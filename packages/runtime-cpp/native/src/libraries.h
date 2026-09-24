// Loading the libraries a session's settings name, as a dynamic linker would
// at a program's start: each after the libraries it needs.
//
// A library names the others it needs, and the dynamic linker looks for them
// in its own runpath and the system's directories. A library kept in a
// project, rather than installed, is rarely found that way, so before a
// library is loaded, whatever it needs that is not yet loaded is looked for
// in the settings' `-L` directories and the library's own, and loaded first.

#pragma once

#include "settings.h"

#include "llvm/Support/Error.h"

namespace bayma {

/// Loads `Settings.Libraries` into the process, where cells resolve them,
/// with relative paths and directories resolved from `Cwd`.
llvm::Error loadLibraries(const SessionSettings &Settings, llvm::StringRef Cwd);

} // namespace bayma
