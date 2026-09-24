#include "thread_locals.h"

#include "llvm/ADT/DenseMap.h"
#include "llvm/ADT/StringMap.h"
#include "llvm/ExecutionEngine/Orc/AbsoluteSymbols.h"
#include "llvm/Support/Compiler.h"

#include <cstddef>
#include <cstdio>
#include <cstdlib>
#include <dlfcn.h>
#include <limits>
#include <mutex>
#include <string>

namespace bayma {

#ifdef __linux__
namespace {

/// The C runtime's emulated-TLS control object: compiler-rt's and libgcc's
/// `__emutls_control`.
struct EmutlsControl {
  std::size_t Size;
  std::size_t Align;
  void *Object;
  void *Value;
};

/// Marks a bridged control object in the size field: no object compiled with
/// emulated TLS is that large.
constexpr std::size_t Bridged = std::numeric_limits<std::size_t>::max();

/// A library's thread-local that cells reach, by the name the library
/// exports it under.
struct BridgedThreadLocal {
  EmutlsControl Control;
  std::string Name;
};

/// Every bridged thread-local, by name. They live as long as the process: a
/// cell undone and run again finds its control object where it was.
struct Registry {
  std::mutex M;
  llvm::StringMap<BridgedThreadLocal *> ByName;
};

Registry &registry() {
  static Registry *R = new Registry;
  return *R;
}

const EmutlsControl *bridge(llvm::StringRef Name) {
  Registry &R = registry();
  std::lock_guard<std::mutex> Lock(R.M);
  BridgedThreadLocal *&Entry = R.ByName[Name];
  if (!Entry) {
    Entry = new BridgedThreadLocal{{Bridged, 0, nullptr, nullptr}, Name.str()};
    Entry->Control.Value = Entry;
  }
  return &Entry->Control;
}

/// The calling thread's copy of a bridged thread-local. dlsym answers a TLS
/// symbol with the calling thread's copy, allocating it if the thread has
/// none yet; each thread keeps its answers.
void *threadCopy(const BridgedThreadLocal &Variable) {
  thread_local llvm::DenseMap<const BridgedThreadLocal *, void *> Copies;
  void *&Copy = Copies[&Variable];
  if (!Copy)
    Copy = ::dlsym(RTLD_DEFAULT, Variable.Name.c_str());
  return Copy;
}

/// What `__emutls_v.<name>` controls: `name`, or empty for another symbol.
llvm::StringRef controlledName(llvm::StringRef Symbol) {
  llvm::StringRef Name = Symbol;
  return Name.consume_front("__emutls_v.") ? Name : llvm::StringRef();
}

class LoadedThreadLocals : public llvm::orc::DefinitionGenerator {
public:
  llvm::Error
  tryToGenerate(llvm::orc::LookupState &, llvm::orc::LookupKind,
                llvm::orc::JITDylib &JD, llvm::orc::JITDylibLookupFlags,
                const llvm::orc::SymbolLookupSet &LookupSet) override {
    llvm::orc::SymbolMap Controls;
    for (const auto &[Symbol, Flags] : LookupSet) {
      llvm::StringRef Name = controlledName(*Symbol);
      // Whatever a loaded library exports under the name is its variable:
      // a cell that declares it thread_local is trusted, as a linker trusts
      // a declaration.
      if (Name.empty() || !::dlsym(RTLD_DEFAULT, Name.str().c_str()))
        continue;
      Controls[Symbol] = {llvm::orc::ExecutorAddr::fromPtr(bridge(Name)),
                          llvm::JITSymbolFlags::Exported};
    }
    if (Controls.empty())
      return llvm::Error::success();
    return JD.define(llvm::orc::absoluteSymbols(std::move(Controls)));
  }
};

} // namespace

std::unique_ptr<llvm::orc::DefinitionGenerator> loadedThreadLocals() {
  return std::make_unique<LoadedThreadLocals>();
}
#else
std::unique_ptr<llvm::orc::DefinitionGenerator> loadedThreadLocals() {
  return nullptr;
}
#endif

} // namespace bayma

#ifdef __linux__
// Cells resolve this in the host, ahead of the C runtime's; see
// thread_locals.h. It is exported by name; see exports-linux.txt.
extern "C" LLVM_ATTRIBUTE_VISIBILITY_DEFAULT void *
__emutls_get_address(void *Control) {
  auto *C = static_cast<bayma::EmutlsControl *>(Control);
  if (C->Size == bayma::Bridged)
    return bayma::threadCopy(
        *static_cast<const bayma::BridgedThreadLocal *>(C->Value));
  using Resolver = void *(*)(void *);
  static const auto Runtime =
      reinterpret_cast<Resolver>(::dlsym(RTLD_NEXT, "__emutls_get_address"));
  if (!Runtime) {
    std::fputs("bayma-cpp-host: the C runtime has no __emutls_get_address\n",
               stderr);
    std::abort();
  }
  return Runtime(Control);
}
#endif
