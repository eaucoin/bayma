# Native Rust Runtime

This workspace builds `bayma-rust-host`, the native protocol process behind
the TypeScript Rust adapter, and `bayma-rust-support`, the serde checkpoint API
compiled into EVcxR cells. `evcxr/` is EVcxR 0.21.1 with the patches below; it
is the one dependency that ships as source, everything else comes from
crates.io under the committed `Cargo.lock`.

```sh
cargo build --locked --release -p bayma-rust-host
cargo test --locked -p evcxr --lib "module::cache::tests::"
```

These sources ship inside the `bayma` npm package. On linux-x64 the release
job builds the host and publishes it as `@bayma-repl/rust-host-linux-x64`;
on every other platform the Rust adapter runs the same `cargo build` with the
user's toolchain the first time a Rust session starts, and every Rust cell
depends on `bayma-rust-support` by path.

EVcxR is intentionally a library dependency. The host never drives or scrapes
the EVcxR terminal binary. It supplies the required `runtime_hook`, validates
file-backed requests, frames output, owns checkpoint staging, and keeps every
Cargo/rustc/evaluation subprocess under the outer transport's process tree.

## Narrow EVcxR patch

The EVcxR 0.21.1 source carries nine narrow Bayma patches:

- `EvalOutputs.did_panic` and `did_user_error` record the already-detected
  panic and question-mark early-return signals and propagate through
  `EvalOutputs::merge`.
- `EVCXR_IGNORE_CWD_CONFIG` lets the host reject an ambient `evcxr.toml` in a
  session working directory as compiler, linker, cache, or startup authority.
- Cargo invocations discard ambient/user `RUSTFLAGS` and encode Bayma's flags
  with Cargo's unit-separator format, so paths with spaces stay one argument
  and the package manifest, rather than EVcxR defaults or `PATH`, is the
  toolchain authority. Sealed contexts also reject toolchain,
  linker, codegen-backend, compiler-wrapper, startup-config, and protected
  environment mutations, and cap `:cache` at the host's 512 MiB policy.
- EVcxR resolves rustc and Cargo from the host-validated
  `BAYMA_RUSTC_BIN`/`BAYMA_CARGO_BIN` paths before its standalone-REPL
  discovery fallbacks. The host also prepends those exact tool directories for
  rust-analyzer subprocesses before any threads start. An installed host
  therefore never depends on its build machine's embedded paths or the ordering
  of a mutable host `PATH`.
- Setup failures retain rustc's rendered diagnostic for the embedding host.
  Ordinary cell-error display remains concise, while linker stderr and other
  initialization evidence are no longer collapsed to an unexplained exit code.
- Execution lifecycle callbacks identify the exact interval in which EVcxR is
  running a loaded cell. A token-bound START/RUN handshake opens the host's
  output envelope before user code can execute; a token-bound stderr barrier
  and exact produced/delivered accounting close it only after attributable
  output drains. Output arriving during a later compilation or while idle is
  discarded instead of being assigned to the wrong execution.
- The evaluation-child request is JSON-framed and each loaded function gets a
  fresh 256-bit control identity. Paths containing spaces remain one field, and
  ordinary untagged output resembling EVcxR's upstream literal markers cannot
  accidentally manufacture a start or completion transition. This framing is
  not a sandbox against deliberate code running inside EVcxR's process.
- The cross-session compilation cache (`module/cache.rs`) is content-addressed:
  entries are keyed by a SHA-256 over the cell's inputs and verified on read,
  publication is immutable and lock-serialised, and pruning stays within the
  host's bound. Its own tests run in CI.
- `:lockfile <path>` resolves a session's dependencies against a chosen
  `Cargo.lock`, and `:lockfile` alone stops. Cargo rewrites the session
  crate's lockfile to its current dependencies on every run, so the chosen
  contents, read once, are restored before each Cargo invocation; Cargo then
  keeps every locked version that still matches, yanked ones included. Without
  it a session can neither reproduce a known-good graph nor select a yanked
  release.

The host requires a Bayma-owned cache root. EVcxR serializes cache reads,
immutable-entry publication, statistics, and pruning with a cross-process file
lock, so concurrent sessions share one bounded cache without partial-entry or
cleanup races.

Protocol input is read on a dedicated watchdog thread. If the owning MCP
server disappears while the main thread is compiling or executing user code,
stdin EOF tears down the host's entire owned process tree instead of leaving a
compiler or evaluation child behind.

Upstream EVcxR catches a user panic and updates its variable state but discards
that fact at the public API boundary. Without the flag, a library embedder can
only misreport the cell as successful or parse human stderr. The other patches
close ambient configuration boundaries that EVcxR intentionally leaves open
for its standalone REPL. EVcxR otherwise keeps its execution, analysis,
display, cache, and subprocess behavior.

## Licenses

The host package carries `licenses/`: an inventory of every crate in the
host's dependency closure from `cargo metadata`, each crate's license and
notice files as cargo fetched them, and canonical text for every license
family in the inventory.
