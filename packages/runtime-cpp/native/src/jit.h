// The JIT cells run in: Clang's default, with what makes libraries the
// session loads plug in the way they would with an ordinary link, and what
// lets a cell that cannot link be undone.
//
// A cell instantiates what it uses from a library's headers: templates,
// inline functions, vtables, and type_info. A dynamic linker gives a process
// one copy of each, whichever it loaded first, but the JIT keeps the cell's
// own. Then the library and the cell disagree about which is which: a
// dynamic_cast in the library fails on an object a cell created, an exception
// escapes its handler, a static member exists twice. So before the JIT
// compiles a cell, every such weak definition that a loaded library already
// exports is resolved to the library's, as the dynamic linker would have.
//
// A cell that uses a symbol nothing defines cannot link. Were the JIT to
// fail it there, what it compiled would stay behind in an error state, and
// the static initializers it registered would fail every cell after it. So a
// cell's references are linked as weak ones: whatever nothing defines is
// noted instead, the cell's initializers see the note and do nothing, and the
// session reports the symbols and undoes the cell.
//
// It also bridges the libraries' thread-local variables; see
// thread_locals.h.

#pragma once

#include "clang/Interpreter/IncrementalExecutor.h"
#include "llvm/ADT/StringMap.h"

#include <atomic>
#include <memory>
#include <mutex>
#include <string>
#include <vector>

namespace bayma {

/// What the session and its JIT share about the running cell.
class CellJit {
public:
  /// A cell starts.
  void begin();

  /// What the cell's code uses that nothing defines, by name; if any, the
  /// cell ran nothing and must be undone.
  std::vector<std::string> undefined();

private:
  friend struct CellJitHooks;

  /// Whether the running cell uses a symbol nothing defines, which its
  /// initializers read before they run.
  std::atomic<bool> Unresolved{false};
  std::mutex M;
  /// The references the JIT links weakly that the cells made strong: each
  /// symbol, as the linker names it, to the name the cell's code gave it.
  llvm::StringMap<std::string> Weakened;
  std::vector<std::string> Undefined;
};

/// Builds the executor a session's Interpreter compiles and runs cells with,
/// sharing the running cell with `Cell`.
std::unique_ptr<clang::IncrementalExecutorBuilder>
executorBuilder(std::shared_ptr<CellJit> Cell);

} // namespace bayma
