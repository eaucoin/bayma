// Thread-local variables that loaded libraries define, reachable from cells.
//
// Clang's JIT compiles cells with emulated TLS: a cell reaches a thread-local
// `x` through `__emutls_get_address(&__emutls_v.x)`, and the JIT defines the
// control object `__emutls_v.x` alongside each thread-local a cell defines.
// A library built ahead of time keeps its thread-locals in native TLS, where
// no control object exists, so a cell using one, even through an inline
// function in the library's headers, fails to link.
//
// So the host bridges them. When a cell needs the control object of a
// thread-local some loaded library defines, the JIT is given one made here,
// and the host's `__emutls_get_address`, which cells resolve in place of the
// C runtime's, answers it with the calling thread's own copy of the library's
// variable. Every other control object is passed on to the C runtime's.

#pragma once

#include "llvm/ExecutionEngine/Orc/Core.h"

#include <memory>

namespace bayma {

/// Defines, as they are looked up, the control objects of thread-locals that
/// loaded libraries define. Linux only: elsewhere there is none.
std::unique_ptr<llvm::orc::DefinitionGenerator> loadedThreadLocals();

} // namespace bayma
