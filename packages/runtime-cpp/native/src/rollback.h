// A failed cell leaves the session as it found it, but for the headers it
// included that parsed.
//
// Clang's Interpreter discards the declarations of an input that fails to
// parse, and bayma undoes one that fails to link or run (Interpreter::Undo).
// Neither is enough by itself:
//
// - The preprocessor goes on believing what the failed cell told it: its
//   macros stay defined, and a header it was including when parsing failed
//   stays included, by its guard or `#pragma once`, with its declarations
//   missing, so including it again would do nothing.
// - Clang forgets the cell's declarations at the top level only, where it
//   also forgets the earlier declarations the cell redeclared: a failed cell
//   that included a standard header, which reopens `namespace std`, would
//   leave `std` undeclared. Declarations in namespaces the cell reopened stay.
// - A header that parsed is still undone with the cell, though including it
//   again cannot declare its classes anew: an earlier declaration still holds
//   the definition the undone one gave it, so they would be redefined.
//
// So while a cell runs, what it changes is recorded, with the file each
// change comes from, and so are the files being parsed whenever an error is
// reported. When the cell fails, what its own code and any header that
// failed to parse changed is reverted: their macros, their headers' being
// included, and their declarations, in every namespace, with what they
// redeclared found again. What headers that parsed declared is kept, as if
// a cell that succeeded had included them. A header that failed is read
// again, from its file, when a cell next includes it, so a fix is seen.
// C keeps nothing: Clang forgets a failed C cell's declarations, headers'
// among them, but for its enumerators, forgotten here; and C has no
// namespaces or classes for them to linger in, so all a C cell changed is
// reverted.

#pragma once

#include "clang/Basic/FileEntry.h"
#include "clang/Basic/SourceLocation.h"
#include "llvm/ADT/DenseSet.h"

#include <memory>
#include <utility>
#include <vector>

namespace clang {
class IdentifierInfo;
class MacroInfo;
class Preprocessor;
class Sema;
class TranslationUnitDecl;
} // namespace clang

namespace bayma {

class CellRollback {
public:
  /// Records what `S`'s preprocessor changes from now on. `KeepParsedHeaders`
  /// keeps what the headers that parsed in a failed cell declared: C++'s way.
  CellRollback(clang::Sema &S, bool KeepParsedHeaders);

  /// A cell starts: what earlier cells changed stays.
  void begin();

  /// An error was reported: the files being parsed failed.
  void failed();

  /// The cell failed: what its own code and the headers that failed in it
  /// changed is reverted. `Unit` is its translation unit, when the consumer
  /// saw it declare anything; Clang withholds from the consumer what a cell
  /// that fails to parse declared, and then the unit is the one current when
  /// its first error was reported.
  void revert(clang::TranslationUnitDecl *Unit);

  /// What a cell changed, and where.
  struct Changes {
    struct Macro {
      clang::IdentifierInfo *Name;
      /// Its definition before the change, or null for none.
      clang::MacroInfo *Before;
      clang::FileID Where;
    };
    /// The cell's own input.
    clang::FileID Cell;
    /// The files being parsed, innermost last.
    std::vector<clang::FileID> Open;
    /// The files that were being parsed when an error was reported.
    llvm::DenseSet<clang::FileID> Failed;
    /// The translation unit current when the first error was reported.
    clang::TranslationUnitDecl *Unit = nullptr;
    /// Each change to a macro, in order.
    std::vector<Macro> Macros;
    /// The headers the cell entered that were not yet `#pragma once`.
    std::vector<std::pair<clang::FileID, clang::FileEntryRef>> Entered;
  };

private:
  /// Whether the cell's changes from `File` are reverted.
  bool reverted(clang::FileID File) const;

  clang::Sema &S;
  clang::Preprocessor &PP;
  bool KeepParsedHeaders;
  std::shared_ptr<Changes> Recorded;
  /// Headers a failed cell reverted, to read again when next included.
  std::shared_ptr<llvm::DenseSet<const clang::FileEntry *>> Stale;
};

} // namespace bayma
