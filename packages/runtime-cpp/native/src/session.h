// One incremental C or C++ interpreter: Clang's, the library clang-repl is
// built on. It evaluates each exec spec as one incremental input and reports
// the outcome as envelopes.

#pragma once

#include "capture.h"

#include "llvm/ADT/StringRef.h"
#include "llvm/Support/Error.h"
#include "llvm/Support/raw_ostream.h"

#include <memory>
#include <optional>
#include <string>

namespace clang {
class Interpreter;
class TranslationUnitDecl;
class Value;
} // namespace clang

namespace bayma {

class CellJit;
class CellRollback;

enum class Language { C, Cxx };

struct SessionOptions {
  Language Lang = Language::Cxx;
  /// The runtime's directory in the payload: the host binary's parent's
  /// parent, holding Clang's resource headers and, on Linux, libc++.
  std::string Root;
  /// The system headers cells compile against: the payload's on Linux, the
  /// SDK's on macOS.
  std::string Sysroot;
  /// The session's working directory; quoted #includes resolve from it.
  std::string Cwd;
};

class Session {
public:
  static llvm::Expected<std::unique_ptr<Session>>
  create(const SessionOptions &Options, OutputCapture &Capture);
  ~Session();

  /// Runs the exec spec at `SpecPath` and writes its envelopes, ending with
  /// `done`.
  void execute(llvm::StringRef SpecPath);

private:
  Session(Language Lang, OutputCapture &Capture);

  /// Takes what a cell that failed to parse left for the next one to compile.
  void flushFailedCell();

  /// Links the running cell's code now, rather than when something first
  /// uses it, so what it lacks is its own error; see jit.h.
  void linkCell();

  /// The running cell's result: C++ cells report theirs as they run.
  std::optional<std::string> takeResult(const clang::Value &Result);
  std::string takeDiagnostics();

  Language Lang;
  OutputCapture &Capture;
  std::string Diagnostics;
  llvm::raw_string_ostream DiagnosticStream{Diagnostics};
  std::shared_ptr<CellJit> Jit;
  std::unique_ptr<clang::Interpreter> Interp;
  std::unique_ptr<CellRollback> Rollback;
  /// The running C++ cell's translation unit, once it declares anything.
  clang::TranslationUnitDecl *CellUnit = nullptr;
};

} // namespace bayma
