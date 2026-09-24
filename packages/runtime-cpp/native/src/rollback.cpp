#include "rollback.h"

#include "clang/AST/DeclCXX.h"
#include "clang/AST/DeclContextInternals.h"
#include "clang/Basic/SourceManager.h"
#include "clang/Lex/HeaderSearch.h"
#include "clang/Lex/MacroInfo.h"
#include "clang/Lex/PPCallbacks.h"
#include "clang/Lex/Preprocessor.h"
#include "llvm/ADT/STLFunctionalExtras.h"
#include "llvm/Support/MemoryBuffer.h"

namespace bayma {

namespace {

using Changes = CellRollback::Changes;

using StaleHeaders = llvm::DenseSet<const clang::FileEntry *>;

class Recorder : public clang::PPCallbacks {
public:
  Recorder(clang::Preprocessor &PP, std::shared_ptr<Changes> Recorded,
           std::shared_ptr<StaleHeaders> Stale)
      : PP(PP), Recorded(std::move(Recorded)), Stale(std::move(Stale)) {}

  void InclusionDirective(clang::SourceLocation, const clang::Token &,
                          llvm::StringRef, bool, clang::CharSourceRange,
                          clang::OptionalFileEntryRef Header, llvm::StringRef,
                          llvm::StringRef, const clang::Module *, bool,
                          clang::SrcMgr::CharacteristicKind) override {
    // A header a failed cell reverted is read again, as it is now.
    if (!Header || !Stale->erase(&Header->getFileEntry()))
      return;
    if (auto Contents = llvm::MemoryBuffer::getFile(Header->getName(),
                                                    /*IsText=*/true))
      PP.getSourceManager().overrideFileContents(*Header, std::move(*Contents));
  }

  void MacroDefined(const clang::Token &Name,
                    const clang::MacroDirective *Directive) override {
    const clang::MacroDirective *Previous = Directive->getPrevious();
    changed(Name, Previous
                      ? const_cast<clang::MacroInfo *>(Previous->getMacroInfo())
                      : nullptr);
  }

  void MacroUndefined(const clang::Token &Name,
                      const clang::MacroDefinition &Definition,
                      const clang::MacroDirective *) override {
    changed(Name, Definition.getMacroInfo());
  }

  void FileChanged(clang::SourceLocation Location, FileChangeReason Reason,
                   clang::SrcMgr::CharacteristicKind,
                   clang::FileID Previous) override {
    clang::SourceManager &Sources = PP.getSourceManager();
    if (Reason == ExitFile) {
      if (!Recorded->Open.empty() && Recorded->Open.back() == Previous)
        Recorded->Open.pop_back();
      return;
    }
    if (Reason != EnterFile)
      return;
    clang::FileID Entered = Sources.getFileID(Location);
    Recorded->Open.push_back(Entered);
    // The cell's own input is the first file it enters.
    if (Recorded->Cell.isInvalid()) {
      Recorded->Cell = Entered;
      return;
    }
    // A header that becomes `#pragma once` in this cell is one to revert.
    auto Header = Sources.getFileEntryRefForID(Entered);
    if (Header && !PP.getHeaderSearchInfo().getFileInfo(*Header).isPragmaOnce)
      Recorded->Entered.emplace_back(Entered, *Header);
  }

private:
  void changed(const clang::Token &Name, clang::MacroInfo *Before) {
    Recorded->Macros.push_back(
        {Name.getIdentifierInfo(), Before,
         PP.getSourceManager().getFileID(Name.getLocation())});
  }

  clang::Preprocessor &PP;
  std::shared_ptr<Changes> Recorded;
  std::shared_ptr<StaleHeaders> Stale;
};

/// The latest declaration of `D`'s entity from before `Failed`, if any.
clang::NamedDecl *declaredBefore(const clang::NamedDecl &D,
                                 const clang::TranslationUnitDecl &Failed) {
  for (const clang::Decl *Earlier = D.getPreviousDecl(); Earlier;
       Earlier = Earlier->getPreviousDecl())
    if (Earlier->getTranslationUnitDecl() != &Failed)
      return const_cast<clang::NamedDecl *>(
          llvm::cast<clang::NamedDecl>(Earlier));
  return nullptr;
}

/// Reverts the names `Declared`, a context of `Failed`'s, declared in the
/// files reverted, and in the namespaces it reopened; and finds again those
/// declared at the top level in the files kept, which Clang forgot.
void revertDeclarations(clang::DeclContext &Declared,
                        const clang::TranslationUnitDecl &Failed,
                        llvm::function_ref<bool(clang::FileID)> Reverted,
                        const clang::SourceManager &Sources) {
  for (clang::Decl *D : Declared.decls()) {
    auto *Named = llvm::dyn_cast<clang::NamedDecl>(D);
    clang::SourceLocation Location = D->getLocation();
    if (Named && !Named->getDeclName().isEmpty() && Location.isValid())
      if (clang::StoredDeclsMap *Names = Named->getDeclContext()
                                             ->getRedeclContext()
                                             ->getPrimaryContext()
                                             ->getLookupPtr()) {
        clang::DeclarationName Name = Named->getDeclName();
        clang::StoredDeclsList &Found = (*Names)[Name];
        bool Listed = llvm::is_contained(Found.getLookupResult(), Named);
        if (Reverted(Sources.getFileID(Sources.getExpansionLoc(Location)))) {
          if (Listed)
            Found.remove(Named);
          if (clang::NamedDecl *Earlier = declaredBefore(*Named, Failed))
            Found.addOrReplaceDecl(Earlier);
        } else if (!Listed && &Declared == &Failed) {
          Found.addOrReplaceDecl(Named);
        }
        if (Found.isNull())
          Names->erase(Name);
      }
    if (llvm::isa<clang::NamespaceDecl, clang::LinkageSpecDecl,
                  clang::ExportDecl>(D))
      revertDeclarations(*llvm::cast<clang::DeclContext>(D), Failed, Reverted,
                         Sources);
  }
}

} // namespace

CellRollback::CellRollback(clang::Preprocessor &PP, bool KeepParsedHeaders)
    : PP(PP), KeepParsedHeaders(KeepParsedHeaders),
      Recorded(std::make_shared<Changes>()),
      Stale(std::make_shared<StaleHeaders>()) {
  PP.addPPCallbacks(std::make_unique<Recorder>(PP, Recorded, Stale));
}

void CellRollback::begin() { *Recorded = Changes(); }

bool CellRollback::reverted(clang::FileID File) const {
  // The cell's own input, and the headers that failed to parse in it.
  return !KeepParsedHeaders || File == Recorded->Cell ||
         Recorded->Failed.contains(File);
}

void CellRollback::failed() {
  Recorded->Failed.insert(Recorded->Open.begin(), Recorded->Open.end());
}

void CellRollback::revert(clang::TranslationUnitDecl *Unit) {
  clang::SourceManager &Sources = PP.getSourceManager();
  // Latest first, so a macro changed more than once returns to what it was
  // before the first change reverted.
  clang::SourceLocation Here =
      Sources.getLocForStartOfFile(Sources.getMainFileID());
  for (const Changes::Macro &Change : llvm::reverse(Recorded->Macros)) {
    if (!reverted(Change.Where))
      continue;
    if (Change.Before)
      PP.appendDefMacroDirective(Change.Name, Change.Before, Here);
    else
      PP.appendMacroDirective(Change.Name,
                              new (PP.getPreprocessorAllocator())
                                  clang::UndefMacroDirective(Here));
  }
  for (auto &[File, Header] : Recorded->Entered)
    if (reverted(File)) {
      PP.getHeaderSearchInfo().getFileInfo(Header).isPragmaOnce = false;
      Stale->insert(&Header.getFileEntry());
    }
  if (Unit)
    revertDeclarations(
        *Unit, *Unit, [this](clang::FileID File) { return reverted(File); },
        Sources);
  begin();
}

} // namespace bayma
