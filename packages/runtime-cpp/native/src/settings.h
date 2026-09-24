// A session's own compiler and linker settings, from `compile_flags.txt` in
// its working directory: the file clangd reads, one argument per line.
//
// Most arguments go to the compiler after bayma's own, so they can add
// include directories and definitions, or choose the language standard. The
// linker's are the host's to act on before the first cell: `-L<dir>` names a
// directory to find libraries in, `-l<name>` (or `-l:<file>`) and a path to a
// shared library name libraries to load, and `-stdlib=` chooses the C++
// standard library cells compile against and run with.

#pragma once

#include "session.h"

#include "llvm/Support/Error.h"

#include <string>
#include <vector>

namespace bayma {

/// The C++ standard libraries a session can use.
enum class StandardLibrary {
  /// LLVM's: the payload's libc++. The default.
  Libcxx,
  /// GCC's: the payload's libstdc++ headers, run with the system's libstdc++,
  /// as the C++ libraries a Linux distribution ships are built. Linux only.
  Libstdcxx,
};

struct SessionSettings {
  /// For the compiler, after bayma's own arguments.
  std::vector<std::string> CompilerArgs;
  /// Where `-l` libraries, and those they need, are looked for first.
  std::vector<std::string> LibraryDirectories;
  /// The libraries to load, in order: `-l` names and paths.
  std::vector<std::string> Libraries;
  StandardLibrary Stdlib = StandardLibrary::Libcxx;
};

/// The settings in `compile_flags.txt` in `Cwd`, or none when there is no
/// such file. A `-std=` or `-stdlib=` for the other language is ignored, so
/// one file can serve C and C++ sessions alike.
llvm::Expected<SessionSettings> readSettings(llvm::StringRef Cwd,
                                             Language Lang);

} // namespace bayma
