use super::artifacts::Artifact;
use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::borrow::Cow;
use std::collections::BTreeSet;
use std::fmt::Display;
use std::fs::File;
use std::fs::OpenOptions;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::time::SystemTime;

pub(crate) const TARGET_DIR_ENV: &str = "EVCXR_TARGET_DIR";

const CACHE_SCHEMA: u32 = 4;
const MANIFEST_FILE: &str = "manifest.json";
const ARTIFACT_DIRECTORY: &str = "artifacts";

pub(crate) enum CacheResult {
    /// We got a cache hit. The cache result has been written to appropriate output location.
    Hit,
    /// We got a cache miss. If compilation succeeds, the result may be published.
    Miss(CacheMiss),
    /// The current compiler invocation can't be cached.
    NonCache,
}

pub(crate) struct CacheMiss {
    cache_subdirectory: PathBuf,
    output_directory: PathBuf,
    action_key: String,
    inputs: Vec<FileIdentity>,
}

/// Values needed to make paths stable between EVcxR's generated workspaces.
pub(crate) struct CacheEnv {
    target_dir: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct FileIdentity {
    path: String,
    kind: FileKind,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
enum FileKind {
    File,
}

#[derive(Debug, Deserialize, Serialize)]
struct CachedArtifact {
    filename: String,
    emit: String,
    bytes: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
struct EnvironmentIdentity {
    name: String,
    value_sha256: Option<String>,
}

#[derive(Debug, Deserialize, Serialize)]
struct CacheManifest {
    schema: u32,
    action_key: String,
    inputs: Vec<FileIdentity>,
    environment: Vec<EnvironmentIdentity>,
    outputs: Vec<CachedArtifact>,
}

/// Checks the complete compiler action and materializes a validated hit.
pub(crate) fn access_cache(command: &Command) -> Result<CacheResult> {
    if std::env::var(super::CACHE_ENABLED_ENV).is_err() {
        return Ok(CacheResult::NonCache);
    }
    let Some(rust_command_line) = RustCommandLine::parse(command) else {
        return Ok(CacheResult::NonCache);
    };
    if rust_command_line.is_incremental {
        // Cargo enables incremental compilation for local crates. Cargo itself owns those outputs;
        // Bayma's cross-session cache is reserved for non-incremental dependency actions.
        return Ok(CacheResult::NonCache);
    }

    let cache_env = CacheEnv::from_env()?;
    let action = CompilerAction::capture(command, &cache_env)?;
    let action_key = sha256_bytes(action.canonical.as_bytes());
    let cache_dir = cache_directory()?;
    let _cache_lock = lock_cache(&cache_dir)?;
    let cache_subdirectory = cache_dir.join(&action_key);

    if cache_subdirectory.exists() {
        match validated_manifest(
            &cache_subdirectory,
            &action_key,
            &cache_env,
        ) {
            Ok(Some(manifest)) => {
                materialize_outputs(
                    &cache_subdirectory,
                    &rust_command_line.output_directory,
                    &manifest.outputs,
                )?;
                increment_hits(&cache_subdirectory)?;
                for output in manifest.outputs {
                    eprintln!(
                        "{}",
                        Artifact {
                            path: rust_command_line.output_directory.join(output.filename),
                            emit: output.emit,
                        }
                    );
                }
                return Ok(CacheResult::Hit);
            }
            Ok(None) => remove_cache_entry(&cache_subdirectory)?,
            Err(_) => remove_cache_entry(&cache_subdirectory)?,
        }
    }

    Ok(CacheResult::Miss(CacheMiss {
        output_directory: rust_command_line.output_directory,
        cache_subdirectory,
        action_key,
        inputs: action.inputs,
    }))
}

struct CompilerAction {
    canonical: String,
    inputs: Vec<FileIdentity>,
}

impl CompilerAction {
    fn capture(command: &Command, env: &CacheEnv) -> Result<Self> {
        let mut inputs = collect_direct_inputs(command, env)?;
        inputs.sort_by(|left, right| left.path.cmp(&right.path));
        inputs.dedup_by(|left, right| left.path == right.path);

        let mut canonical = String::new();
        canonical.push_str("bayma-rust-cache-action-v4\n");
        canonical.push_str("program\0");
        canonical.push_str(&normalize_text(&os_text(command.get_program())?, env));
        canonical.push('\n');
        for arg in command.get_args() {
            canonical.push_str("arg\0");
            canonical.push_str(&normalize_text(&os_text(arg)?, env));
            canonical.push('\n');
        }
        for input in &inputs {
            canonical.push_str("input\0");
            canonical.push_str(&serde_json::to_string(input)?);
            canonical.push('\n');
        }
        Ok(Self { canonical, inputs })
    }
}

fn collect_direct_inputs(command: &Command, env: &CacheEnv) -> Result<Vec<FileIdentity>> {
    let mut paths = BTreeSet::new();
    add_file_candidate(&mut paths, Path::new(command.get_program()));

    for arg in command.get_args() {
        let arg = os_text(arg)?;
        if arg.starts_with('@') {
            // Rustc response files can name further compiler inputs. Binding only the response
            // file bytes would not bind those referents, and duplicating rustc's response parser
            // here would create a second command-line authority. Compile this action normally.
            return Err(anyhow!("rustc response-file actions are not cacheable"));
        }
        add_argument_file_candidates(&mut paths, &arg);
    }

    for directory_name in ["CARGO_MANIFEST_DIR", "OUT_DIR"] {
        if let Some(directory) = command_environment(command, directory_name)? {
            collect_tree(Path::new(&directory), &mut paths)?;
        }
    }

    paths
        .into_iter()
        .map(|path| file_identity(&path, env))
        .collect()
}

fn command_environment(command: &Command, name: &str) -> Result<Option<String>> {
    if let Some((_, value)) = command
        .get_envs()
        .find(|(candidate, _)| *candidate == std::ffi::OsStr::new(name))
    {
        return value.map(os_text).transpose();
    }
    std::env::var_os(name)
        .map(|value| os_text(&value))
        .transpose()
}

fn add_argument_file_candidates(paths: &mut BTreeSet<PathBuf>, argument: &str) {
    add_file_candidate(paths, Path::new(argument));
    if let Some((_, value)) = argument.split_once('=') {
        add_file_candidate(paths, Path::new(value));
    }
}

fn add_file_candidate(paths: &mut BTreeSet<PathBuf>, path: &Path) {
    if path.is_file() || path.is_symlink() {
        paths.insert(path.to_owned());
    }
}

fn collect_tree(root: &Path, paths: &mut BTreeSet<PathBuf>) -> Result<()> {
    if !root.is_dir() {
        add_file_candidate(paths, root);
        return Ok(());
    }
    let mut pending = vec![root.to_owned()];
    while let Some(directory) = pending.pop() {
        let mut entries = directory.read_dir()?.collect::<std::io::Result<Vec<_>>>()?;
        entries.sort_by_key(|entry| entry.file_name());
        for entry in entries {
            let path = entry.path();
            let metadata = std::fs::symlink_metadata(&path)?;
            if metadata.file_type().is_symlink() || metadata.is_file() {
                paths.insert(path);
            } else if metadata.is_dir() {
                pending.push(path);
            }
        }
    }
    Ok(())
}

fn file_identity(path: &Path, env: &CacheEnv) -> Result<FileIdentity> {
    let metadata = std::fs::symlink_metadata(path)
        .with_context(|| format!("failed to inspect cache input `{}`", path.display()))?;
    let (kind, bytes, sha256) = if metadata.is_file() {
        (FileKind::File, metadata.len(), sha256_file(path)?)
    } else if metadata.file_type().is_symlink() {
        // Rustc may follow the referent, whose bytes are not represented by the link itself. A
        // conservative bypass is sounder than recursively inventing filesystem-resolution rules.
        return Err(anyhow!("symlinked compiler inputs are not cacheable"));
    } else {
        return Err(anyhow!("cache input is not a file: `{}`", path.display()));
    };
    Ok(FileIdentity {
        path: normalize_text(&os_text(path.as_os_str())?, env).into_owned(),
        kind,
        bytes,
        sha256,
    })
}

fn validated_manifest(
    entry: &Path,
    action_key: &str,
    env: &CacheEnv,
) -> Result<Option<CacheManifest>> {
    let data = match std::fs::read(entry.join(MANIFEST_FILE)) {
        Ok(data) => data,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    let manifest: CacheManifest = serde_json::from_slice(&data)?;
    if manifest.schema != CACHE_SCHEMA
        || manifest.action_key != action_key
        || manifest.outputs.is_empty()
    {
        return Ok(None);
    }
    for input in &manifest.inputs {
        let path = restore_path(&input.path, env);
        if file_identity(&path, env).ok().as_ref() != Some(input) {
            return Ok(None);
        }
    }
    for environment in &manifest.environment {
        if environment_identity(&environment.name, env)? != *environment {
            return Ok(None);
        }
    }
    let artifact_directory = entry.join(ARTIFACT_DIRECTORY);
    for output in &manifest.outputs {
        if !safe_filename(&output.filename) {
            return Ok(None);
        }
        let path = artifact_directory.join(&output.filename);
        if !regular_file_matches(&path, output.bytes, &output.sha256)? {
            return Ok(None);
        }
    }
    Ok(Some(manifest))
}

fn materialize_outputs(
    entry: &Path,
    output_directory: &Path,
    outputs: &[CachedArtifact],
) -> Result<()> {
    std::fs::create_dir_all(output_directory)?;
    for output in outputs {
        let source = entry.join(ARTIFACT_DIRECTORY).join(&output.filename);
        let destination = output_directory.join(&output.filename);
        let temporary = unique_path(output_directory, ".bayma-materialize")?;
        std::fs::copy(&source, &temporary).with_context(|| {
            format!(
                "failed to materialize cached output `{}` -> `{}`",
                source.display(),
                destination.display()
            )
        })?;
        if !regular_file_matches(&temporary, output.bytes, &output.sha256)? {
            let _ = std::fs::remove_file(&temporary);
            return Err(anyhow!("materialized cache output failed validation"));
        }
        if destination.exists() {
            std::fs::remove_file(&destination)?;
        }
        std::fs::rename(&temporary, &destination)?;
    }
    Ok(())
}

fn increment_hits(entry: &Path) -> Result<()> {
    let hits_path = entry.join("hits");
    let hits = std::fs::read_to_string(&hits_path)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0)
        .saturating_add(1);
    atomic_write(&hits_path, hits.to_string().as_bytes())
}

fn cache_directory() -> Result<PathBuf> {
    if let Some(path) = std::env::var_os("BAYMA_RUST_CACHE_DIR") {
        return Ok(PathBuf::from(path).join("evcxr"));
    }
    Ok(dirs::cache_dir()
        .ok_or_else(|| anyhow!("failed to determine cache directory"))?
        .join("evcxr"))
}

fn lock_cache(cache_dir: &Path) -> Result<File> {
    std::fs::create_dir_all(cache_dir)?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(cache_dir.join(".bayma-cache.lock"))?;
    lock.lock()?;
    Ok(lock)
}

struct RustCommandLine {
    output_directory: PathBuf,
    is_incremental: bool,
}

impl RustCommandLine {
    fn parse(command: &Command) -> Option<Self> {
        let mut args = command.get_args();
        let mut out_dir = None;
        let mut is_incremental = false;
        while let Some(arg) = args.next() {
            if arg == "--out-dir" {
                out_dir = args.next().map(PathBuf::from);
            }
            if arg == "-C" {
                let Some(next) = args.next() else { break };
                if next.to_string_lossy().starts_with("incremental=") {
                    is_incremental = true;
                }
            }
        }
        out_dir.map(|output_directory| Self {
            output_directory,
            is_incremental,
        })
    }
}

impl CacheEnv {
    fn from_env() -> Result<Self> {
        Ok(Self {
            target_dir: std::env::var(TARGET_DIR_ENV).with_context(|| {
                format!("failed to get environment variable `{TARGET_DIR_ENV}`")
            })?,
        })
    }
}

impl CacheMiss {
    pub(super) fn update_cache(&self, artifacts: &[Artifact]) -> Result<()> {
        if artifacts.is_empty() || !self.original_inputs_unchanged() {
            return Ok(());
        }
        let cache_env = CacheEnv::from_env()?;
        let mut inputs = self.inputs.clone();
        let dependencies = dependency_inputs(artifacts)?;
        for path in dependencies.paths {
            let identity = match file_identity(&path, &cache_env) {
                Ok(identity) => identity,
                Err(_) => return Ok(()),
            };
            inputs.push(identity);
        }
        inputs.sort_by(|left, right| left.path.cmp(&right.path));
        inputs.dedup_by(|left, right| left.path == right.path);
        let mut environment = dependencies
            .environment_names
            .into_iter()
            .map(|name| environment_identity(&name, &cache_env))
            .collect::<Result<Vec<_>>>()?;
        environment.sort_by(|left, right| left.name.cmp(&right.name));
        environment.dedup_by(|left, right| left.name == right.name);

        let cache_dir = cache_directory()?;
        let _cache_lock = lock_cache(&cache_dir)?;
        if self.cache_subdirectory.exists() {
            if validated_manifest(
                &self.cache_subdirectory,
                &self.action_key,
                &cache_env,
            )?
            .is_some()
            {
                return Ok(());
            }
            remove_cache_entry(&self.cache_subdirectory)?;
        }

        let staging = unique_directory(&cache_dir, ".staging")?;
        let result = self.publish_to_staging(&staging, inputs, environment, artifacts);
        if let Err(error) = result {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
        std::fs::rename(&staging, &self.cache_subdirectory)?;
        Ok(())
    }

    fn original_inputs_unchanged(&self) -> bool {
        let Ok(env) = CacheEnv::from_env() else {
            return false;
        };
        self.inputs.iter().all(|input| {
            file_identity(&restore_path(&input.path, &env), &env)
                .ok()
                .as_ref()
                == Some(input)
        })
    }

    fn publish_to_staging(
        &self,
        staging: &Path,
        inputs: Vec<FileIdentity>,
        environment: Vec<EnvironmentIdentity>,
        artifacts: &[Artifact],
    ) -> Result<()> {
        let artifact_directory = staging.join(ARTIFACT_DIRECTORY);
        std::fs::create_dir_all(&artifact_directory)?;
        let mut outputs = Vec::new();
        let mut output_names = BTreeSet::new();
        for artifact in artifacts {
            let Some(filename) = artifact.path.file_name().and_then(|value| value.to_str()) else {
                return Err(anyhow!("rustc artifact has no portable filename"));
            };
            if !safe_filename(filename) {
                return Err(anyhow!("rustc artifact filename is not cache-safe"));
            }
            if !output_names.insert(filename.to_owned()) {
                continue;
            }
            let source = self.output_directory.join(filename);
            let destination = artifact_directory.join(filename);
            std::fs::copy(&source, &destination)?;
            let metadata = destination.metadata()?;
            outputs.push(CachedArtifact {
                filename: filename.to_owned(),
                emit: artifact.emit.clone(),
                bytes: metadata.len(),
                sha256: sha256_file(&destination)?,
            });
        }
        if outputs.is_empty() {
            return Err(anyhow!("rustc emitted no cacheable artifacts"));
        }
        let manifest = CacheManifest {
            schema: CACHE_SCHEMA,
            action_key: self.action_key.clone(),
            inputs,
            environment,
            outputs,
        };
        std::fs::write(staging.join("hits"), "0")?;
        std::fs::write(
            staging.join(MANIFEST_FILE),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        Ok(())
    }
}

struct DependencyInputs {
    paths: BTreeSet<PathBuf>,
    environment_names: BTreeSet<String>,
}

fn dependency_inputs(artifacts: &[Artifact]) -> Result<DependencyInputs> {
    let mut result = DependencyInputs {
        paths: BTreeSet::new(),
        environment_names: BTreeSet::new(),
    };
    for artifact in artifacts
        .iter()
        .filter(|artifact| artifact.emit == "dep-info")
    {
        let data = std::fs::read_to_string(&artifact.path)?;
        let joined = data.replace("\\\r\n", " ").replace("\\\n", " ");
        for line in joined.lines() {
            if let Some(environment) = line.strip_prefix("# env-dep:") {
                let name = environment
                    .split_once('=')
                    .map_or(environment, |(name, _)| name);
                if name.is_empty() {
                    return Err(anyhow!("rustc dep-info reported an empty environment name"));
                }
                result.environment_names.insert(name.to_owned());
                continue;
            }
            let Some((_, dependencies)) = line.split_once(": ") else {
                continue;
            };
            for token in dep_info_tokens(dependencies) {
                let path = PathBuf::from(token);
                if path.is_file() || path.is_symlink() {
                    result.paths.insert(path);
                }
            }
        }
    }
    Ok(result)
}

fn environment_identity(name: &str, env: &CacheEnv) -> Result<EnvironmentIdentity> {
    let value_sha256 = std::env::var_os(name)
        .map(|value| os_text(&value).map(|value| environment_value_sha256(name, &value, env)))
        .transpose()?;
    Ok(EnvironmentIdentity {
        name: name.to_owned(),
        value_sha256,
    })
}

fn environment_value_sha256(name: &str, value: &str, env: &CacheEnv) -> String {
    let identity = if name == "OUT_DIR" {
        normalize_text(value, env)
    } else {
        Cow::Borrowed(value)
    };
    sha256_bytes(identity.as_bytes())
}

fn dep_info_tokens(input: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let mut token = String::new();
    let mut escaped = false;
    for character in input.chars() {
        if escaped {
            token.push(character);
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character.is_whitespace() {
            if !token.is_empty() {
                tokens.push(std::mem::take(&mut token));
            }
        } else {
            token.push(character);
        }
    }
    if escaped {
        token.push('\\');
    }
    if !token.is_empty() {
        tokens.push(token);
    }
    tokens
}

fn regular_file_matches(path: &Path, bytes: u64, sha256: &str) -> Result<bool> {
    let metadata = match path.metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.into()),
    };
    Ok(metadata.is_file() && metadata.len() == bytes && sha256_file(path)? == sha256)
}

fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex_digest(&hasher.finalize()))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    hex_digest(&Sha256::digest(bytes))
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn normalize_text<'a>(value: &'a str, env: &CacheEnv) -> Cow<'a, str> {
    if value.contains(&env.target_dir) {
        Cow::Owned(value.replace(&env.target_dir, "<target_dir>"))
    } else {
        Cow::Borrowed(value)
    }
}

fn restore_path(value: &str, env: &CacheEnv) -> PathBuf {
    PathBuf::from(value.replace("<target_dir>", &env.target_dir))
}

fn os_text(value: &std::ffi::OsStr) -> Result<String> {
    value
        .to_str()
        .map(ToOwned::to_owned)
        .ok_or_else(|| anyhow!("non-UTF-8 compiler input is not cacheable"))
}

fn safe_filename(filename: &str) -> bool {
    !filename.is_empty()
        && filename != "."
        && filename != ".."
        && Path::new(filename).components().count() == 1
}

fn unique_directory(parent: &Path, prefix: &str) -> Result<PathBuf> {
    for attempt in 0..1024_u32 {
        let path = parent.join(format!("{prefix}-{}-{attempt}", std::process::id()));
        match std::fs::create_dir(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.into()),
        }
    }
    Err(anyhow!("failed to allocate unique cache staging directory"))
}

fn unique_path(parent: &Path, prefix: &str) -> Result<PathBuf> {
    for attempt in 0..1024_u32 {
        let path = parent.join(format!("{prefix}-{}-{attempt}", std::process::id()));
        if !path.exists() {
            return Ok(path);
        }
    }
    Err(anyhow!(
        "failed to allocate unique cache materialization path"
    ))
}

fn atomic_write(path: &Path, contents: &[u8]) -> Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| anyhow!("cache file has no parent"))?;
    let temporary = unique_path(parent, ".bayma-write")?;
    std::fs::write(&temporary, contents)?;
    if path.exists() {
        std::fs::remove_file(path)?;
    }
    std::fs::rename(temporary, path)?;
    Ok(())
}

fn remove_cache_entry(path: &Path) -> Result<()> {
    match std::fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

/// Reduces cache usage to <= `cache_bytes`. Returns the number of bytes freed.
pub(crate) fn cleanup(cache_bytes: u64) -> Result<u64> {
    let cache_dir = cache_directory()?;
    let _cache_lock = lock_cache(&cache_dir)?;
    let mut freed = remove_incomplete_cache_entries(&cache_dir)?;
    let mut entries = read_cache_entries()?;
    let total_size: u64 = entries.iter().map(|entry| entry.size).sum();
    if total_size <= cache_bytes {
        return Ok(freed);
    }
    entries.sort_by_key(|entry| entry.last_access);
    entries.reverse();
    let mut to_free = (total_size - cache_bytes) as i64;
    while to_free > 0 {
        let Some(entry) = entries.pop() else { break };
        std::fs::remove_dir_all(entry.subdirectory)?;
        to_free -= entry.size as i64;
        freed += entry.size;
    }
    Ok(freed)
}

fn remove_incomplete_cache_entries(cache_dir: &Path) -> Result<u64> {
    let mut freed = 0;
    for entry in cache_dir.read_dir()? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() {
            continue;
        }
        let path = entry.path();
        let complete = std::fs::read(path.join(MANIFEST_FILE))
            .ok()
            .and_then(|data| serde_json::from_slice::<CacheManifest>(&data).ok())
            .is_some_and(|manifest| structurally_complete(&path, &manifest));
        if complete {
            continue;
        }
        freed += cache_entry_size(&path)?;
        std::fs::remove_dir_all(path)?;
    }
    Ok(freed)
}

fn structurally_complete(entry: &Path, manifest: &CacheManifest) -> bool {
    manifest.schema == CACHE_SCHEMA
        && !manifest.outputs.is_empty()
        && entry.file_name().and_then(|name| name.to_str())
            == Some(manifest.action_key.as_str())
        && valid_sha256(&manifest.action_key)
        && manifest
            .outputs
            .iter()
            .all(|output| safe_filename(&output.filename))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn cache_entry_size(path: &Path) -> Result<u64> {
    let mut size = 0;
    let mut pending = vec![path.to_owned()];
    while let Some(directory) = pending.pop() {
        for item in directory.read_dir()? {
            let item = item?;
            let metadata = item.metadata()?;
            if metadata.is_file() {
                size += metadata.len();
            } else if metadata.is_dir() {
                pending.push(item.path());
            }
        }
    }
    Ok(size)
}

#[derive(Default)]
pub(crate) struct CacheStats {
    num_entries: u64,
    disk_used: u64,
    num_hits: u64,
}

impl CacheStats {
    pub(crate) fn get() -> Result<Self> {
        let cache_dir = cache_directory()?;
        let _cache_lock = lock_cache(&cache_dir)?;
        let mut result = CacheStats::default();
        for entry in read_cache_entries()? {
            result.num_entries += 1;
            result.disk_used += entry.size;
            result.num_hits += std::fs::read_to_string(entry.subdirectory.join("hits"))
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
                .unwrap_or(0);
        }
        Ok(result)
    }
}

impl Display for CacheStats {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        writeln!(f, "Entries: {}", self.num_entries)?;
        writeln!(f, "Disk used: {} MiB", self.disk_used / 1024 / 1024)?;
        writeln!(f, "Hits: {}", self.num_hits)?;
        Ok(())
    }
}

struct CacheEntry {
    last_access: SystemTime,
    size: u64,
    subdirectory: PathBuf,
}

fn read_cache_entries() -> Result<Vec<CacheEntry>> {
    let mut entries = Vec::new();
    let directory = cache_directory()?;
    if !directory.exists() {
        return Ok(entries);
    }
    for entry in directory.read_dir()? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || !entry.path().join(MANIFEST_FILE).is_file() {
            continue;
        }
        let metadata = std::fs::metadata(entry.path().join("hits"))
            .or_else(|_| std::fs::metadata(entry.path().join(MANIFEST_FILE)))?;
        entries.push(CacheEntry {
            last_access: metadata.modified()?,
            size: cache_entry_size(&entry.path())?,
            subdirectory: entry.path(),
        });
    }
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cache_env(root: &Path) -> CacheEnv {
        CacheEnv {
            target_dir: root.display().to_string(),
        }
    }

    #[test]
    fn action_identity_tracks_file_bytes_and_normalizes_target_root() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_input = first.path().join("dependency.rlib");
        let second_input = second.path().join("dependency.rlib");
        std::fs::write(&first_input, b"first").unwrap();
        std::fs::write(&second_input, b"first").unwrap();
        let mut first_command = Command::new(&first_input);
        first_command.args([
            "--out-dir",
            first.path().to_str().unwrap(),
            first_input.to_str().unwrap(),
        ]);
        let mut second_command = Command::new(&second_input);
        second_command.args([
            "--out-dir",
            second.path().to_str().unwrap(),
            second_input.to_str().unwrap(),
        ]);

        let first_action =
            CompilerAction::capture(&first_command, &cache_env(first.path())).unwrap();
        let second_action =
            CompilerAction::capture(&second_command, &cache_env(second.path())).unwrap();
        assert_eq!(first_action.canonical, second_action.canonical);

        std::fs::write(&second_input, b"second").unwrap();
        let changed = CompilerAction::capture(&second_command, &cache_env(second.path())).unwrap();
        assert_ne!(first_action.canonical, changed.canonical);
    }

    #[test]
    fn manifest_rejects_corrupt_outputs_and_changed_transitive_inputs() {
        let root = tempfile::tempdir().unwrap();
        let env = cache_env(root.path());
        let entry = root.path().join("entry");
        let artifacts = entry.join(ARTIFACT_DIRECTORY);
        std::fs::create_dir_all(&artifacts).unwrap();
        let input = root.path().join("input.rs");
        let output = artifacts.join("libexample.rlib");
        std::fs::write(&input, b"source").unwrap();
        std::fs::write(&output, b"artifact").unwrap();
        let manifest = CacheManifest {
            schema: CACHE_SCHEMA,
            action_key: "key".to_owned(),
            inputs: vec![file_identity(&input, &env).unwrap()],
            environment: vec![],
            outputs: vec![CachedArtifact {
                filename: "libexample.rlib".to_owned(),
                emit: "link".to_owned(),
                bytes: 8,
                sha256: sha256_bytes(b"artifact"),
            }],
        };
        std::fs::write(
            entry.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        assert!(
            validated_manifest(&entry, "key", &env)
                .unwrap()
                .is_some()
        );

        std::fs::write(&input, b"changed").unwrap();
        assert!(
            validated_manifest(&entry, "key", &env)
                .unwrap()
                .is_none()
        );
        std::fs::write(&input, b"source").unwrap();
        std::fs::write(&output, b"corrupt!").unwrap();
        assert!(
            validated_manifest(&entry, "key", &env)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn cleanup_removes_legacy_partial_and_structurally_invalid_entries() {
        let root = tempfile::tempdir().unwrap();
        let partial = root.path().join("partial");
        let legacy = root.path().join("legacy");
        let invalid = root.path().join("invalid");
        std::fs::create_dir_all(&partial).unwrap();
        std::fs::create_dir_all(&legacy).unwrap();
        std::fs::create_dir_all(&invalid).unwrap();
        std::fs::write(partial.join("partial"), b"partial").unwrap();
        std::fs::write(legacy.join("stderr"), b"legacy").unwrap();
        std::fs::write(invalid.join(MANIFEST_FILE), b"{}").unwrap();
        let manifest = CacheManifest {
            schema: CACHE_SCHEMA,
            action_key: sha256_bytes(b"action"),
            inputs: vec![],
            environment: vec![],
            outputs: vec![CachedArtifact {
                filename: "libexample.rlib".to_owned(),
                emit: "link".to_owned(),
                bytes: 1,
                sha256: sha256_bytes(b"x"),
            }],
        };
        let complete = root.path().join(&manifest.action_key);
        std::fs::create_dir_all(&complete).unwrap();
        std::fs::write(
            complete.join(MANIFEST_FILE),
            serde_json::to_vec(&manifest).unwrap(),
        )
        .unwrap();
        remove_incomplete_cache_entries(root.path()).unwrap();
        assert!(!partial.exists());
        assert!(!legacy.exists());
        assert!(!invalid.exists());
        assert!(complete.exists());
    }

    #[test]
    fn dep_info_parser_preserves_escaped_spaces_and_backslashes() {
        assert_eq!(
            dep_info_tokens(r"one.rs two\ file.rs three\\four.rs"),
            vec!["one.rs", "two file.rs", r"three\four.rs"]
        );
    }

    #[test]
    fn dep_info_identifies_exact_environment_dependencies_without_values() {
        let root = tempfile::tempdir().unwrap();
        let dep_info = root.path().join("example.d");
        std::fs::write(
            &dep_info,
            "output: input.rs\n# env-dep:BAYMA_CACHE_TEST_SECRET=not-for-the-manifest\n",
        )
        .unwrap();
        let dependencies = dependency_inputs(&[Artifact {
            path: dep_info,
            emit: "dep-info".to_owned(),
        }])
        .unwrap();
        assert_eq!(
            dependencies.environment_names,
            BTreeSet::from(["BAYMA_CACHE_TEST_SECRET".to_owned()])
        );
    }

    #[test]
    fn environment_identity_normalizes_the_ephemeral_target_root() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let first_value = first.path().join("debug/build/example/out");
        let second_value = second.path().join("debug/build/example/out");

        assert_eq!(
            environment_value_sha256(
                "OUT_DIR",
                first_value.to_str().unwrap(),
                &cache_env(first.path()),
            ),
            environment_value_sha256(
                "OUT_DIR",
                second_value.to_str().unwrap(),
                &cache_env(second.path()),
            )
        );
        assert_ne!(
            environment_value_sha256(
                "ARBITRARY_VALUE",
                first_value.to_str().unwrap(),
                &cache_env(first.path()),
            ),
            environment_value_sha256(
                "ARBITRARY_VALUE",
                second_value.to_str().unwrap(),
                &cache_env(second.path()),
            )
        );
    }

    #[test]
    fn opaque_rustc_response_files_are_not_cached() {
        let root = tempfile::tempdir().unwrap();
        let compiler = root.path().join("rustc");
        let response = root.path().join("arguments");
        std::fs::write(&compiler, b"compiler").unwrap();
        std::fs::write(&response, b"--extern example=dependency.rlib").unwrap();
        let mut command = Command::new(compiler);
        command.arg(format!("@{}", response.display()));

        assert!(CompilerAction::capture(&command, &cache_env(root.path())).is_err());
    }

    #[test]
    fn empty_output_manifests_are_structurally_incomplete() {
        let root = tempfile::tempdir().unwrap();
        let action_key = sha256_bytes(b"action");
        let manifest = CacheManifest {
            schema: CACHE_SCHEMA,
            action_key: action_key.clone(),
            inputs: vec![],
            environment: vec![],
            outputs: vec![],
        };

        assert!(!structurally_complete(&root.path().join(action_key), &manifest));
    }
}
