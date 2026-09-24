# Native C and C++ Runtime

`bayma-cpp-host` is the protocol process behind the TypeScript C and C++
adapters. It embeds Clang's incremental Interpreter (`clang::Interpreter`,
the library clang-repl is built on) rather than driving the clang-repl
terminal, so each exec's output, diagnostics, and result come back as
separate, structured envelopes.

```sh
bayma-cpp-host --language=c|c++ [--sysroot=PATH]
```

A session's own settings come from `compile_flags.txt` in its working
directory, the file clangd reads, one argument per line (`settings.cpp`).
Compiler arguments follow bayma's own, so they can add include directories and
definitions or choose the standard; a `-std=` or `-stdlib=` for the other
language is ignored, so one file serves C and C++ sessions. `-L<dir>`,
`-l<name>` (or `-l:<file>`), and a path to a shared library load libraries
before the first cell (`libraries.cpp`), each after the libraries it needs
that those directories or its own hold, as a dynamic linker would at a
program's start; a library kept in a project, rather than installed, is rarely
found through its runpath. On Linux, `-stdlib=libstdc++` compiles cells
against the payload's libstdc++ headers and runs them with the system's
libstdc++, as a distribution's C++ libraries are built and run.

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
- **Libraries plug in** (`jit.cpp`). A cell instantiates what it uses from a
  library's headers, templates, inline functions, vtables, and type_info, and
  the JIT would keep the cell's copies, where a dynamic linker gives the
  process one copy of each. The library and the cell would then disagree: a
  `dynamic_cast` in the library would fail on an object a cell made, an
  exception would escape the handler for its type, a static member would
  exist twice. So before the JIT compiles a cell, each such weak definition
  that a loaded library already exports is resolved to the library's.
- **Thread-local variables** (`thread_locals.cpp`, Linux). The JIT compiles
  cells with emulated TLS, and libraries built ahead of time keep theirs in
  native TLS, which a cell, even through an inline function in a library's
  headers, could not otherwise reach. The host gives the JIT a control object
  for each thread-local a loaded library exports as it is looked up, and
  answers `__emutls_get_address`, which cells resolve in the host, with the
  calling thread's own copy of the library's variable; every other control
  object goes on to the C runtime's.
- **A failed cell is undone** (`rollback.cpp`), all but the headers it
  included that parsed, which stay included as if a cell that succeeded had
  included them. A cell that fails to parse is withdrawn by Clang, and one
  that fails to link or run by `Interpreter::Undo`; the template
  instantiations and generated code a cell that failed to parse leaves for
  the next are taken by an empty input, undone with them. Neither touches the
  preprocessor, and Clang forgets declarations at the top level only, where
  it also forgets the earlier ones they redeclared, `namespace std` among
  them. So the macros, `#pragma once` headers, and declarations, in every
  namespace, of the cell's own code and of any header that failed to parse
  in it are reverted, with what they redeclared found again, and a header
  that failed is read again from its file when next included. A cell is
  linked as it runs, not when something first uses it, so what it lacks is
  its own error; and its references are linked weakly, so a symbol nothing
  defines is noted rather than failing the link, which would leave what the
  JIT compiled in an error state for every cell after it. A cell that uses
  one runs none of its code: its static initializers see the note and do
  nothing, and it is undone.
- **Checkpoints** are JSON text that cells write and read through a C API the
  host exports to the JIT (`bayma_write_checkpoint`, `bayma_read_checkpoint`).
  A successful exec commits the checkpoint as it stands; a failed one
  preserves the committed one.

## One C++ runtime per process

The JIT resolves the symbols cells use in the host process, so cells must see
exactly one C++ runtime:

- **Linux.** The LLVM release's libraries are built against GCC's libstdc++,
  so the host is too, but links it statically and exports only the symbols
  in `exports.txt` and `exports-linux.txt`. Cells use the payload's libc++,
  which the worker loads with its libc++abi, libunwind, and libatomic, or,
  when the session chooses it, the system's libstdc++, whose own thread-locals
  (those behind `std::call_once`, for one) cells reach through the host as
  they reach any library's. Either shares the system's `libgcc_s` unwinder
  with the host, where the JIT registers the frames of what it compiles.
- **macOS.** The release's libraries, the host, and cells all use the
  system's libc++.

## Headers and the glibc floor

On Linux the host is built against a sysroot of pinned Ubuntu 22.04 packages
(glibc 2.35 and GCC 12's libstdc++, the LLVM release's own), and provisioning
checks it requires no newer glibc than bayma's floor. Cells compile against
the same release's glibc and Linux headers, and GCC 12's libstdc++ headers for
sessions that choose libstdc++, which the payload carries in `sysroot/`, so no
headers are needed on the machine. On macOS, cells compile
against the SDK of the Xcode Command Line Tools, which the adapter locates
with `xcrun`.
