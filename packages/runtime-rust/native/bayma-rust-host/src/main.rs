use evcxr::{CommandContext, EvalCallbacks, EvalContextOutputs};
use serde::Deserialize;
use serde_json::{Value, json};
use std::env;
use std::fs;
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use std::time::Duration;


const PROMPT: &str = "BAYMA> ";
// Leave framing headroom below the core's 64 KiB message ceiling. This keeps
// the host's truncation marker authoritative instead of asking a second
// boundary to truncate an already-bounded protocol message.
const MAX_MESSAGE_BYTES: usize = 60 * 1024;
const TRUNCATION_MARKER: &str = "…Bayma truncated runtime message…";
const PROTOCOL_VERSION: u32 = 1;
const CHECKPOINT_PATH_ENV: &str = "BAYMA_RUST_CHECKPOINT_PATH";
const IGNORE_CWD_CONFIG_ENV: &str = "EVCXR_IGNORE_CWD_CONFIG";
const SEALED_RUNTIME_ENV: &str = "BAYMA_EVCXR_SEALED";
const MAX_CACHE_BYTES_ENV: &str = "BAYMA_RUST_MAX_CACHE_BYTES";
const OWNS_PROCESS_TREE_ENV: &str = "BAYMA_RUST_OWNS_PROCESS_TREE";
const MAX_CACHE_BYTES: u64 = 512 * 1024 * 1024;
const OUTPUT_DRAIN_TIMEOUT: Duration = Duration::from_secs(5);

static STDOUT: OnceLock<Mutex<io::Stdout>> = OnceLock::new();

#[derive(Clone)]
struct ActiveExecution {
    prefix: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecSpec {
    schema_version: u32,
    event_prefix: String,
    exec_id: String,
    code: String,
    source_path: String,
    durability_mode: String,
    checkpoint_json: Option<String>,
    checkpoint_output_path: String,
}

fn bounded_text(value: &str) -> String {
    if value.len() <= MAX_MESSAGE_BYTES {
        return value.to_owned();
    }
    let marker_bytes = TRUNCATION_MARKER.len();
    let payload_bytes = MAX_MESSAGE_BYTES.saturating_sub(marker_bytes);
    let mut left = payload_bytes / 2;
    while left > 0 && !value.is_char_boundary(left) {
        left -= 1;
    }
    let mut right = value.len().saturating_sub(payload_bytes - left);
    while right < value.len() && !value.is_char_boundary(right) {
        right += 1;
    }
    format!("{}{}{}", &value[..left], TRUNCATION_MARKER, &value[right..])
}

fn write_stdout(value: &str) -> io::Result<()> {
    let mut output = STDOUT
        .get_or_init(|| Mutex::new(io::stdout()))
        .lock()
        .unwrap();
    output.write_all(value.as_bytes())?;
    output.flush()
}

fn emit(prefix: &str, kind: &str, text: Option<&str>, checkpoint: Option<Value>) {
    let mut payload = json!({ "kind": kind });
    if let Some(text) = text {
        payload["text"] = Value::String(bounded_text(text));
    }
    if let Some(checkpoint) = checkpoint {
        payload["checkpoint"] = checkpoint;
    }
    let _ = write_stdout(&format!("{prefix}{payload}\n"));
}

fn print_prompt() {
    let _ = write_stdout(PROMPT);
}

fn terminate_abandoned_process_tree(process_handle: &Arc<Mutex<Child>>) -> ! {
    let _ = process_handle.lock().unwrap().kill();
    if env::var(OWNS_PROCESS_TREE_ENV).as_deref() == Ok("1") {
        // SAFETY: ProcessTransport starts this host as the leader of its
        // own process group when it grants the process-tree capability.
        // Killing group zero therefore cannot reach the MCP server or an
        // operator shell, and it also reaches in-flight Cargo/rustc work.
        unsafe {
            libc::kill(0, libc::SIGKILL);
        }
    }
    std::process::exit(1);
}

fn protocol_input(process_handle: Arc<Mutex<Child>>) -> crossbeam_channel::Receiver<String> {
    let (sender, receiver) = crossbeam_channel::unbounded();
    thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if sender.send(line).is_err() {
                        return;
                    }
                }
                Err(error) => {
                    eprintln!("bayma-rust-host: stdin failed: {error}");
                    terminate_abandoned_process_tree(&process_handle);
                }
            }
        }
        // stdin EOF means the owning MCP server disappeared or closed the
        // transport. This thread remains responsive while the main thread is
        // compiling or executing untrusted Rust.
        terminate_abandoned_process_tree(&process_handle);
    });
    receiver
}

fn start_output_forwarder(
    outputs: EvalContextOutputs,
    active: Arc<Mutex<Option<ActiveExecution>>>,
    pending_output_lines: Arc<AtomicUsize>,
) {
    let spawn_channel = |receiver: crossbeam_channel::Receiver<String>,
                         kind: &'static str,
                         active: Arc<Mutex<Option<ActiveExecution>>>,
                         pending_output_lines: Arc<AtomicUsize>| {
        thread::spawn(move || {
            while let Ok(line) = receiver.recv() {
                let current = active.lock().unwrap().clone();
                if let Some(current) = current {
                    emit(&current.prefix, kind, Some(&(line + "\n")), None);
                }
                pending_output_lines.fetch_sub(1, Ordering::SeqCst);
            }
        });
    };
    spawn_channel(
        outputs.stdout,
        "stdout",
        Arc::clone(&active),
        Arc::clone(&pending_output_lines),
    );
    spawn_channel(outputs.stderr, "stderr", active, pending_output_lines);
}

fn wait_for_output_drain(pending_output_lines: &AtomicUsize) -> bool {
    let started = std::time::Instant::now();
    while pending_output_lines.load(Ordering::SeqCst) != 0 {
        if started.elapsed() >= OUTPUT_DRAIN_TIMEOUT {
            return false;
        }
        thread::sleep(Duration::from_millis(1));
    }
    true
}

fn rust_string_literal(value: &str) -> String {
    format!("{value:?}")
}

fn checkpoint_prep(spec: &ExecSpec) -> String {
    let checkpoint = spec.checkpoint_json.as_deref().unwrap_or("null");
    format!(
        "let mut bayma_checkpoint: Option<bayma_rust_support::Value> = \
         bayma_rust_support::decode_checkpoint({}).expect(\"Bayma supplied a validated checkpoint\");",
        rust_string_literal(checkpoint)
    )
}

fn checkpoint_commit_code(checkpoint_staging_path: &Path) -> String {
    format!(
        "std::fs::write({}, \
         bayma_rust_support::encode_checkpoint(&bayma_checkpoint)\
         .expect(\"Rust checkpoint serialization failed\"))\
         .expect(\"Rust checkpoint write failed\");",
        rust_string_literal(&checkpoint_staging_path.to_string_lossy())
    )
}

fn validate_output_path(spec_path: &Path, output_path: &Path) -> Result<(), String> {
    let spec_parent = spec_path
        .parent()
        .ok_or_else(|| "execution spec has no parent directory".to_owned())?
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize execution workspace: {error}"))?;
    let output_parent = output_path
        .parent()
        .ok_or_else(|| "checkpoint output has no parent directory".to_owned())?
        .canonicalize()
        .map_err(|error| format!("failed to canonicalize checkpoint parent: {error}"))?;
    if output_parent != spec_parent {
        return Err("checkpoint output must remain in the execution workspace".to_owned());
    }
    Ok(())
}

fn run_exec(
    context: &mut CommandContext,
    spec_path: &Path,
    checkpoint_staging_path: &Path,
    active: &Arc<Mutex<Option<ActiveExecution>>>,
    pending_output_lines: &AtomicUsize,
) {
    let result = (|| -> Result<(), String> {
        let raw = fs::read_to_string(spec_path)
            .map_err(|error| format!("failed to read execution spec: {error}"))?;
        let spec: ExecSpec = serde_json::from_str(&raw)
            .map_err(|error| format!("invalid execution spec: {error}"))?;
        if spec.schema_version != PROTOCOL_VERSION {
            return Err(format!(
                "unsupported Rust execution protocol version {}",
                spec.schema_version
            ));
        }
        if spec.event_prefix.is_empty() || spec.exec_id.is_empty() {
            return Err("execution identity fields must not be empty".to_owned());
        }
        if spec.source_path.is_empty() {
            return Err("execution source path must not be empty".to_owned());
        }
        let source_path = PathBuf::from(&spec.source_path);
        let source_parent = source_path
            .parent()
            .ok_or_else(|| "execution source has no parent directory".to_owned())?
            .canonicalize()
            .map_err(|error| format!("failed to canonicalize execution source parent: {error}"))?;
        let spec_parent = spec_path
            .parent()
            .ok_or_else(|| "execution spec has no parent directory".to_owned())?
            .canonicalize()
            .map_err(|error| format!("failed to canonicalize execution workspace: {error}"))?;
        if source_parent != spec_parent {
            return Err("execution source must remain in the execution workspace".to_owned());
        }
        let source = fs::read_to_string(&source_path)
            .map_err(|error| format!("failed to read execution source: {error}"))?;
        if source != format!("{}\n", spec.code) {
            return Err("execution source and submitted code disagree".to_owned());
        }
        if spec.durability_mode != "ephemeral" && spec.durability_mode != "checkpointed" {
            return Err(format!(
                "unsupported durability mode {}",
                spec.durability_mode
            ));
        }

        if spec.durability_mode == "checkpointed" {
            let output_path = PathBuf::from(&spec.checkpoint_output_path);
            validate_output_path(spec_path, &output_path)?;
            let initial = spec.checkpoint_json.as_deref().unwrap_or("null");
            fs::write(&output_path, initial)
                .map_err(|error| format!("failed to seed checkpoint output: {error}"))?;
            fs::write(checkpoint_staging_path, initial)
                .map_err(|error| format!("failed to seed checkpoint staging file: {error}"))?;
            context
                .execute(&checkpoint_prep(&spec))
                .map_err(|error| format!("failed to prepare Rust checkpoint: {error}"))?;
        }

        let started_active = Arc::clone(active);
        let started_prefix = spec.event_prefix.clone();
        let execution_started = || {
            *started_active.lock().unwrap() = Some(ActiveExecution {
                prefix: started_prefix.clone(),
            });
        };
        let finished_active = Arc::clone(active);
        let output_drain_timed_out = AtomicBool::new(false);
        let execution_finished = || {
            if !wait_for_output_drain(pending_output_lines) {
                output_drain_timed_out.store(true, Ordering::SeqCst);
            }
            *finished_active.lock().unwrap() = None;
        };
        let input_reader = |_| String::new();
        let mut callbacks = EvalCallbacks {
            input_reader: &input_reader,
            execution_started: &execution_started,
            execution_finished: &execution_finished,
        };
        let execution = context.execute_with_callbacks(&spec.code, &mut callbacks);

        if output_drain_timed_out.load(Ordering::SeqCst) {
            emit(
                &spec.event_prefix,
                "error",
                Some(
                    "Rust output exceeded the five-second delivery drain; remaining output was dropped",
                ),
                None,
            );
        } else {
            match &execution {
                Ok(output) => {
                    if output.did_panic {
                        emit(
                            &spec.event_prefix,
                            "error",
                            Some("Rust execution panicked; see stderr for the panic diagnostic"),
                            None,
                        );
                    } else if output.did_user_error {
                        emit(
                            &spec.event_prefix,
                            "error",
                            Some("Rust execution returned early with ?; see stderr for the error"),
                            None,
                        );
                    } else if let Some(text) = output.get("text/plain")
                        && !text.is_empty()
                    {
                        emit(&spec.event_prefix, "result", Some(text), None);
                    }
                }
                Err(error) => {
                    emit(&spec.event_prefix, "error", Some(&format!("{error}")), None);
                }
            }
        }

        if spec.durability_mode == "checkpointed" {
            if execution.is_err() {
                // EVcxR returns Err before user code runs for compilation and
                // command-processing failures. Preserve the exact prior core
                // authority instead of manufacturing a fresh revision from
                // the sidecar seed.
                emit(&spec.event_prefix, "checkpoint-preserved", None, None);
            } else {
                context
                    .execute(&checkpoint_commit_code(checkpoint_staging_path))
                    .map_err(|error| format!("failed to commit Rust checkpoint: {error}"))?;
                fs::copy(checkpoint_staging_path, &spec.checkpoint_output_path)
                    .map_err(|error| format!("failed to publish Rust checkpoint: {error}"))?;
                let checkpoint = json!({
                    "runtimeId": "rust",
                    "codecId": "rust-serde-json-v1",
                    "codecVersion": 1,
                    "payloadKind": "text-sidecar",
                    "payloadPath": spec.checkpoint_output_path,
                    "compatibility": {
                        "runtimeVersion": env!("CARGO_PKG_VERSION"),
                        "languageVersion": env::var("BAYMA_RUST_VERSION").unwrap_or_else(|_| "unknown".to_owned()),
                        "platform": env::consts::OS,
                        "arch": env::consts::ARCH,
                    }
                });
                emit(&spec.event_prefix, "checkpoint", None, Some(checkpoint));
            }
        }
        emit(&spec.event_prefix, "done", None, None);
        Ok(())
    })();

    if let Err(error) = result {
        let prefix = fs::read_to_string(spec_path)
            .ok()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.get("event_prefix")?.as_str().map(str::to_owned));
        if let Some(prefix) = prefix {
            emit(&prefix, "error", Some(&error), None);
            emit(&prefix, "done", None, None);
        } else {
            let _ = writeln!(io::stderr(), "bayma-rust-host: {error}");
        }
    }
}

fn required_path(name: &str) -> Result<PathBuf, String> {
    let value = env::var_os(name).ok_or_else(|| format!("{name} is required"))?;
    let path = PathBuf::from(value);
    if !path.is_absolute() || !path.exists() {
        return Err(format!("{name} must name an existing absolute path"));
    }
    Ok(path)
}

fn required_file(name: &str) -> Result<PathBuf, String> {
    let path = required_path(name)?;
    if !path.is_file() {
        return Err(format!("{name} must name a file"));
    }
    Ok(path)
}

fn required_directory(name: &str) -> Result<PathBuf, String> {
    let path = required_path(name)?;
    if !path.is_dir() {
        return Err(format!("{name} must name a directory"));
    }
    Ok(path)
}

fn prepend_tool_directories(tools: &[&Path]) -> Result<(), String> {
    let mut entries = Vec::new();
    for tool in tools {
        let parent = tool
            .parent()
            .ok_or_else(|| format!("tool path has no parent: {}", tool.display()))?;
        if !entries.iter().any(|entry| entry == parent) {
            entries.push(parent.to_path_buf());
        }
    }
    if let Some(current) = env::var_os("PATH") {
        for entry in env::split_paths(&current) {
            if !entries.contains(&entry) {
                entries.push(entry);
            }
        }
    }
    let joined = env::join_paths(entries)
        .map_err(|error| format!("failed to compose contained Rust PATH: {error}"))?;
    // SAFETY: initialization runs before EVcxR and output-forwarding threads.
    unsafe { env::set_var("PATH", joined) };
    Ok(())
}

fn initialize(
    checkpoint_staging_path: &Path,
) -> Result<(CommandContext, EvalContextOutputs), String> {
    let rustc_bin = required_file("BAYMA_RUSTC_BIN")?;
    let cargo_bin = required_file("BAYMA_CARGO_BIN")?;
    let support_dir = required_directory("BAYMA_RUST_SUPPORT_DIR")?;
    required_directory("BAYMA_RUST_CACHE_DIR")?;
    required_directory("EVCXR_CONFIG_DIR")?;
    prepend_tool_directories(&[&rustc_bin, &cargo_bin])?;
    // SAFETY: this runs before EVcxR or the output-forwarding threads start, so
    // no other thread can concurrently observe or mutate the process environment.
    unsafe {
        env::set_var(CHECKPOINT_PATH_ENV, checkpoint_staging_path);
        env::set_var(IGNORE_CWD_CONFIG_ENV, "1");
        env::set_var(SEALED_RUNTIME_ENV, "1");
        env::set_var(MAX_CACHE_BYTES_ENV, MAX_CACHE_BYTES.to_string());
    }
    let (mut context, outputs) = CommandContext::new()
        .map_err(|error| format!("failed to initialize EVcxR: {}", error.diagnostic_text()))?;
    let dependency = format!(
        ":dep bayma_rust_support = {{ package = \"bayma-rust-support\", path = {} }}",
        rust_string_literal(&support_dir.to_string_lossy())
    );
    // The support crate's serde closure comes from the user's Cargo registry
    // like any other dependency; the first session on a machine fetches it.
    context.execute(&dependency).map_err(|error| {
        format!(
            "failed to register Bayma Rust support crate: {}",
            error.diagnostic_text()
        )
    })?;
    context.execute(":cache 512").map_err(|error| {
        format!(
            "failed to configure bounded EVcxR cache: {}",
            error.diagnostic_text()
        )
    })?;
    Ok((context, outputs))
}

fn main() {
    evcxr::runtime_hook();

    let config_dir = match required_path("EVCXR_CONFIG_DIR") {
        Ok(value) => value,
        Err(error) => {
            eprintln!("bayma-rust-host: {error}");
            std::process::exit(1);
        }
    };
    let checkpoint_staging_path =
        config_dir.join(format!("checkpoint-{}.json", std::process::id()));

    let (mut context, outputs) = match initialize(&checkpoint_staging_path) {
        Ok(value) => value,
        Err(error) => {
            eprintln!("bayma-rust-host: {error}");
            std::process::exit(1);
        }
    };

    let process_handle: Arc<Mutex<Child>> = context.process_handle();
    let protocol_input = protocol_input(Arc::clone(&process_handle));
    if let Err(error) = ctrlc::set_handler(move || {
        let _ = process_handle.lock().unwrap().kill();
    }) {
        eprintln!("bayma-rust-host: failed to install interrupt handler: {error}");
        std::process::exit(1);
    }

    let active = Arc::new(Mutex::new(None));
    let pending_output_lines = Arc::clone(&outputs.pending_output_lines);
    start_output_forwarder(
        outputs,
        Arc::clone(&active),
        Arc::clone(&pending_output_lines),
    );

    print_prompt();
    for line in protocol_input {
        if let Some(path) = line.strip_prefix(":exec ") {
            run_exec(
                &mut context,
                Path::new(path),
                &checkpoint_staging_path,
                &active,
                pending_output_lines.as_ref(),
            );
        } else if let Some(nonce) = line.strip_prefix(":probe ") {
            let _ = write_stdout(&format!("__BAYMA_READY_{nonce}__\n"));
        } else if line == ":shutdown" {
            break;
        } else if !line.trim().is_empty() {
            eprintln!("bayma-rust-host: unknown protocol command");
        }
        print_prompt();
    }
    let _ = fs::remove_file(checkpoint_staging_path);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_text_preserves_head_tail_and_discloses_truncation() {
        let input = format!("head{}tail", "x".repeat(MAX_MESSAGE_BYTES * 4));
        let bounded = bounded_text(&input);
        assert!(bounded.starts_with("head"));
        assert!(bounded.ends_with("tail"));
        assert!(bounded.contains("Bayma truncated runtime message"));
        assert!(bounded.len() <= MAX_MESSAGE_BYTES);
    }

    #[test]
    fn bounded_text_preserves_utf8_boundaries() {
        let bounded = bounded_text(&"€".repeat(MAX_MESSAGE_BYTES));
        assert!(bounded.contains("Bayma truncated runtime message"));
        assert!(bounded.len() <= MAX_MESSAGE_BYTES);
    }
}
