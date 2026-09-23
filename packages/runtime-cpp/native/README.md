# Native C and C++ Runtime

`bayma-cpp-host` is the protocol process behind the TypeScript C and C++
adapters. It embeds Clang's incremental Interpreter (`clang::Interpreter`,
the library clang-repl is built on) rather than driving the clang-repl
terminal, so each exec's output, diagnostics, and result come back as
separate, structured envelopes.

```sh
bayma-cpp-host --language=c|c++ [--sysroot=PATH]
```

`bun run provision` builds it from `src/` against the pinned LLVM release's
static libraries, with that release's clang, and proves the result answers a
cell in each language before the payload carries it.

## Design

- **Supervisor and worker.** A cell can take its process down: a fault, an
  uncaught exception, `exit()`, or the OOM killer. The host is a small
  supervisor that forks the interpreter as a worker (`supervisor.cpp`). The
  worker records the running cell in memory shared with the supervisor,
  which reports that cell's error when the worker dies and starts a fresh
  worker. The session loses its definitions and values but keeps its
  checkpoint.
- **Output at the descriptor level.** The worker replaces descriptors 1 and
  2 with pipes (`capture.cpp`), so `printf`, `std::cout`, and child processes
  are all captured. Before a cell's outcome, a fresh marker written through
  each pipe proves everything the cell wrote has been forwarded. Output that
  arrives between cells is discarded, and stdin is empty.
- **Diagnostics and results.** Clang's diagnostics are the exec's error, or
  its stderr when they are only warnings. A trailing expression's value is
  the result. C++ results are captured by bayma rather than by the
  Interpreter, whose capture drops the cleanups of temporaries in the
  expression and then fails to link (LLVM #225868): the worker rewrites the
  trailing expression into a call to a template from the session's prelude,
  which renders string-likes quoted, anything `std::format` formats (C++23
  formats ranges, maps, and tuples), and anything with an `operator<<`
  streamed, and shows anything else by its type and address. C results use
  the Interpreter's own rendering.
- **Checkpoints** are JSON text that cells write and read through a C API the
  host exports to the JIT (`bayma_write_checkpoint`, `bayma_read_checkpoint`).
  A successful exec commits the checkpoint as it stands; a failed one
  preserves the committed one.

## One C++ runtime per process

The JIT resolves the symbols cells use in the host process, so cells must see
exactly one C++ runtime:

- **Linux.** The LLVM release's libraries are built against GCC's libstdc++,
  so the host is too, but links it statically and exports only the symbols
  in `exports.txt`. Cells use the payload's libc++, which the worker loads
  with its libc++abi, libunwind, and libatomic. The host and libc++abi share
  the system's `libgcc_s` unwinder, where the JIT registers the frames of
  what it compiles. GCC's libstdc++ could not serve cells anyway: the
  Interpreter compiles cells with emulated TLS, which `std::call_once` and
  `std::async` in libstdc++ do not support.
- **macOS.** The release's libraries, the host, and cells all use the
  system's libc++.

## Headers and the glibc floor

On Linux the host is built against a sysroot of pinned Ubuntu 22.04 packages
(glibc 2.35 and GCC 12's libstdc++, the LLVM release's own), and provisioning
checks it requires no newer glibc than bayma's floor. Cells compile against
the same release's glibc and Linux headers, which the payload carries in
`sysroot/`, so no C headers are needed on the machine. On macOS, cells compile
against the SDK of the Xcode Command Line Tools, which the adapter locates
with `xcrun`.
