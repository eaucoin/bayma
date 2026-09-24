#include "jit.h"

#include "thread_locals.h"

#include "llvm/Demangle/Demangle.h"
#include "llvm/ExecutionEngine/JITLink/JITLink.h"
#include "llvm/ExecutionEngine/Orc/AbsoluteSymbols.h"
#include "llvm/ExecutionEngine/Orc/Debugging/DebuggerSupport.h"
#include "llvm/ExecutionEngine/Orc/LLJIT.h"
#include "llvm/ExecutionEngine/Orc/ObjectLinkingLayer.h"
#include "llvm/IR/Constants.h"
#include "llvm/IR/Function.h"
#include "llvm/IR/GlobalVariable.h"
#include "llvm/IR/IRBuilder.h"
#include "llvm/IR/Mangler.h"
#include "llvm/IR/Module.h"

#include <dlfcn.h>
#include <string>
#include <vector>

namespace bayma {

namespace {

using namespace llvm;
using namespace llvm::orc;

/// Where a loaded library defines `Name`, or null. The host exports only the
/// C API cells call, so this finds libraries' definitions, never the host's.
void *loadedDefinition(StringRef Name) {
  // A name the compiler must not mangle further is no library's.
  if (Name.empty() || Name.front() == '\1')
    return nullptr;
  return ::dlsym(RTLD_DEFAULT, Name.str().c_str());
}

/// A definition every user of a header emits its own copy of: a template's
/// instantiation, an inline function, a vtable, or a type_info.
bool isVague(const GlobalValue &G) {
  return !G.isDeclaration() && (G.hasLinkOnceLinkage() || G.hasWeakLinkage());
}

/// The guard variable of the variable `Name` names.
std::string guardOf(StringRef Name) {
  return Name.starts_with("_Z") ? ("_ZGV" + Name.drop_front(2)).str()
                                : std::string();
}

/// Whether the cell may use the library's copy of `V`. A variable initialized
/// at run time is guarded, and the library initializes its own copy: the
/// cell's initializer may run on it only if it sees the library's guard too.
bool shareable(const GlobalVariable &V, const Module &M) {
  if (V.isThreadLocal())
    return false; // Bridged instead; see thread_locals.h.
  std::string Guard = guardOf(V.getName());
  return Guard.empty() || !M.getNamedGlobal(Guard) || loadedDefinition(Guard);
}

/// Turns a definition into a declaration of a symbol defined elsewhere.
void makeDeclaration(GlobalValue &G) {
  if (auto *F = dyn_cast<Function>(&G))
    F->deleteBody();
  else {
    auto &V = cast<GlobalVariable>(G);
    V.setInitializer(nullptr);
    V.setLinkage(GlobalValue::ExternalLinkage);
  }
  cast<GlobalObject>(G).setComdat(nullptr);
  G.setVisibility(GlobalValue::DefaultVisibility);
  // Loaded libraries are anywhere in the address space: reach them through
  // the GOT.
  G.setDSOLocal(false);
}

/// Resolves the module's vague definitions that a loaded library already
/// exports to the library's.
Error preferLoaded(LLJIT &J, Module &M, MaterializationResponsibility &R) {
  SymbolMap Loaded;
  std::vector<GlobalValue *> Resolved;
  for (GlobalValue &G : M.global_values()) {
    if (!isVague(G) || !isa<Function, GlobalVariable>(G))
      continue;
    if (auto *V = dyn_cast<GlobalVariable>(&G); V && !shareable(*V, M))
      continue;
    SymbolStringPtr Symbol = J.mangleAndIntern(G.getName());
    auto Claimed = R.getSymbols().find(Symbol);
    if (Claimed == R.getSymbols().end())
      continue;
    void *Address = loadedDefinition(G.getName());
    if (!Address)
      continue;
    Loaded[Symbol] = {ExecutorAddr::fromPtr(Address), Claimed->second};
    Resolved.push_back(&G);
  }
  for (GlobalValue *G : Resolved)
    makeDeclaration(*G);
  if (Loaded.empty())
    return Error::success();
  return R.replace(absoluteSymbols(std::move(Loaded)));
}

/// The prefix of the functions the JIT makes of a module's static
/// initializers.
constexpr StringLiteral InitializerPrefix = "__orc_init_func.";

} // namespace

/// What the JIT tells the session's CellJit, and asks it.
struct CellJitHooks {
  /// Links the module's strong references to what the module does not define
  /// weakly, noting them, so a missing one resolves to null rather than
  /// failing the link. Thread-local variables are left as they are: their
  /// control objects are made as they are looked up; see thread_locals.h.
  static void weakenReferences(CellJit &Cell, Module &M) {
    std::lock_guard<std::mutex> Lock(Cell.M);
    for (GlobalValue &G : M.global_values()) {
      if (!G.isDeclaration() || !G.hasExternalLinkage() || G.use_empty() ||
          !isa<Function, GlobalVariable>(G))
        continue;
      if (auto *F = dyn_cast<Function>(&G); F && F->isIntrinsic())
        continue;
      if (auto *V = dyn_cast<GlobalVariable>(&G); V && V->isThreadLocal())
        continue;
      G.setLinkage(GlobalValue::ExternalWeakLinkage);
      // The linker's name for it has the platform's prefix: Mach-O's `_`.
      std::string Linked;
      raw_string_ostream Name(Linked);
      Mangler::getNameWithPrefix(Name, G.getName(), M.getDataLayout());
      Cell.Weakened[Linked] = G.getName().str();
    }
  }

  /// Makes the module's static initializers do nothing when the running cell
  /// uses a symbol nothing defines.
  static void guardInitializers(CellJit &Cell, Module &M) {
    LLVMContext &Context = M.getContext();
    Type *Flag = Type::getInt8Ty(Context);
    for (Function &F : M) {
      if (F.isDeclaration() || !F.getName().starts_with(InitializerPrefix))
        continue;
      BasicBlock *Body = &F.getEntryBlock();
      BasicBlock *Guard =
          BasicBlock::Create(Context, "bayma.unresolved", &F, Body);
      BasicBlock *Skip = BasicBlock::Create(Context, "bayma.skip", &F);
      ReturnInst::Create(Context, Skip);
      IRBuilder<> Builder(Guard);
      Value *Address = ConstantExpr::getIntToPtr(
          Builder.getInt64(reinterpret_cast<uintptr_t>(&Cell.Unresolved)),
          Builder.getPtrTy());
      auto *Unresolved = Builder.CreateLoad(Flag, Address, "unresolved");
      Unresolved->setAtomic(AtomicOrdering::Acquire);
      Unresolved->setAlignment(Align(alignof(std::atomic<bool>)));
      Builder.CreateCondBr(Builder.CreateIsNotNull(Unresolved), Skip, Body);
    }
  }

  /// JITLink resolved the graph's externals: a weakened one at null is one
  /// nothing defines.
  static Error noteUndefined(CellJit &Cell, jitlink::LinkGraph &G) {
    std::lock_guard<std::mutex> Lock(Cell.M);
    for (jitlink::Symbol *External : G.external_symbols()) {
      if (External->getAddress())
        continue;
      auto Weakened = Cell.Weakened.find(*External->getName());
      if (Weakened == Cell.Weakened.end())
        continue;
      Cell.Undefined.push_back(Weakened->second);
      Cell.Unresolved.store(true, std::memory_order_release);
    }
    return Error::success();
  }
};

namespace {

class UndefinedSymbols : public ObjectLinkingLayer::Plugin {
public:
  explicit UndefinedSymbols(std::shared_ptr<CellJit> Cell)
      : Cell(std::move(Cell)) {}

  void modifyPassConfig(MaterializationResponsibility &, jitlink::LinkGraph &,
                        jitlink::PassConfiguration &Config) override {
    Config.PreFixupPasses.push_back([Cell = Cell](jitlink::LinkGraph &G) {
      return CellJitHooks::noteUndefined(*Cell, G);
    });
  }
  Error notifyFailed(MaterializationResponsibility &) override {
    return Error::success();
  }
  Error notifyRemovingResources(JITDylib &, ResourceKey) override {
    return Error::success();
  }
  void notifyTransferringResources(JITDylib &, ResourceKey,
                                   ResourceKey) override {}

private:
  std::shared_ptr<CellJit> Cell;
};

} // namespace

void CellJit::begin() {
  std::lock_guard<std::mutex> Lock(M);
  Undefined.clear();
  Unresolved.store(false, std::memory_order_release);
}

std::vector<std::string> CellJit::undefined() {
  std::lock_guard<std::mutex> Lock(M);
  std::vector<std::string> Names;
  for (const std::string &Name : Undefined)
    Names.push_back(demangle(Name));
  return Names;
}

std::unique_ptr<clang::IncrementalExecutorBuilder>
executorBuilder(std::shared_ptr<CellJit> Cell) {
  auto JIT = std::make_unique<LLJITBuilder>();
  // As Clang's own builder: debuggers see what the JIT compiles.
  JIT->setPrePlatformSetup([](LLJIT &J) {
    consumeError(enableDebuggerSupport(J));
    return Error::success();
  });
  JIT->setNotifyCreatedCallback([Cell](LLJIT &J) {
    // The platform's transform has made the module's initializers into one
    // function by now.
    J.getIRTransformLayer().setTransform(
        [&J,
         Cell](ThreadSafeModule TSM,
               MaterializationResponsibility &R) -> Expected<ThreadSafeModule> {
          Error Err = TSM.withModuleDo([&](Module &M) -> Error {
            if (Error Err = preferLoaded(J, M, R))
              return Err;
            CellJitHooks::weakenReferences(*Cell, M);
            CellJitHooks::guardInitializers(*Cell, M);
            return Error::success();
          });
          if (Err)
            return std::move(Err);
          return std::move(TSM);
        });
    if (auto *Linker = dyn_cast<ObjectLinkingLayer>(&J.getObjLinkingLayer()))
      Linker->addPlugin(std::make_shared<UndefinedSymbols>(Cell));
    if (auto ThreadLocals = loadedThreadLocals())
      J.getProcessSymbolsJITDylib()->addGenerator(std::move(ThreadLocals));
    return Error::success();
  });
  auto Builder = std::make_unique<clang::IncrementalExecutorBuilder>();
  Builder->JITBuilder = std::move(JIT);
  return Builder;
}

} // namespace bayma
