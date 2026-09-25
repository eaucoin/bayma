#include "session.h"

#include "jit.h"
#include "libraries.h"
#include "protocol.h"
#include "rollback.h"
#include "settings.h"
#include "supervisor.h"

#include "clang/AST/ASTContext.h"
#include "clang/AST/Decl.h"
#include "clang/AST/DeclCXX.h"
#include "clang/AST/ExprCXX.h"
#include "clang/AST/GlobalDecl.h"
#include "clang/Frontend/CompilerInstance.h"
#include "clang/Frontend/TextDiagnosticPrinter.h"
#include "clang/Interpreter/Interpreter.h"
#include "clang/Interpreter/Value.h"
#include "clang/Lex/Preprocessor.h"
#include "clang/Sema/Lookup.h"
#include "clang/Sema/Sema.h"
#include "clang/Sema/SemaConsumer.h"
#include "llvm/ADT/StringExtras.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/Path.h"
#include "llvm/TargetParser/Host.h"

#include <cstdio>
#include <unistd.h>
#include <utility>
#include <vector>

// Ends the worker after a failure the session cannot survive; defined with
// the rest of the C API cells call, below.
extern "C" [[noreturn]] void bayma_abandon_interpreter(const char *reason);

namespace bayma {

namespace {

/// What the C API cells call shares with the session running them.
struct CellApiState {
  /// The session's checkpoint as JSON text.
  std::optional<std::string> Checkpoint;
  /// Why the running cell's last bayma_write_checkpoint was refused.
  std::string CheckpointError;
  /// A C++ cell's result, as bayma_capture_result rendered it.
  std::optional<std::string> Result;
};

CellApiState CellApi;

// Declarations every C++ session starts with, in any standard from C++17 and
// with either standard library.
//
// An uncaught exception would reach std::terminate and abort without a word;
// it ends the interpreter with a report of what was thrown instead.
//
// A cell's trailing expression becomes a call to bayma_capture_result, which
// renders the value while the cell runs: string-likes quoted, whatever
// std::format formats where the standard library formats ranges (C++23
// formats ranges, maps, and tuples), numbers, whatever has an operator<<
// streamed, enumerations as their value, and anything else by type and
// address.
constexpr llvm::StringLiteral CxxPrelude = R"cpp(
#if __cplusplus < 201703L
#error "bayma's C++ sessions need C++17 or newer"
#endif
#include <charconv>
#include <cstddef>
#include <exception>
#include <memory>
#include <ostream>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#if __has_include(<format>)
#include <format>
#endif
extern "C" const char *bayma_read_checkpoint(void);
extern "C" int bayma_write_checkpoint(const char *json);
extern "C" [[noreturn]] void bayma_abandon_interpreter(const char *reason);
extern "C" void bayma_report_result(const char *text, std::size_t size);
namespace bayma_detail {
[[noreturn]] inline void report_uncaught() {
  std::string reason = "terminate called";
  if (std::exception_ptr error = std::current_exception()) {
    try {
      std::rethrow_exception(error);
    } catch (const std::exception &uncaught) {
      reason = std::string("uncaught exception: ") + uncaught.what();
    } catch (...) {
      reason = "uncaught exception of a type not derived from std::exception";
    }
  }
  bayma_abandon_interpreter(reason.c_str());
}
template <class T, class = void> struct streamable : std::false_type {};
template <class T>
struct streamable<T, std::void_t<decltype(std::declval<std::ostream &>()
                                          << std::declval<const T &>())>>
    : std::true_type {};
#if defined(__cpp_lib_format_ranges)
inline std::string quoted(std::string_view text) {
  return std::format("{:?}", text);
}
inline std::string quoted(char c) { return std::format("{:?}", c); }
#else
// As std::format's debug format quotes them.
inline void escape(std::string &out, char c, char quote) {
  switch (c) {
  case '\t': out += "\\t"; return;
  case '\n': out += "\\n"; return;
  case '\r': out += "\\r"; return;
  case '\\': out += "\\\\"; return;
  default:
    if (c == quote) {
      out += '\\';
      out += c;
    } else if (static_cast<unsigned char>(c) < 0x20 || c == 0x7f) {
      const char digits[] = "0123456789abcdef";
      out += "\\u{";
      if (c >= 0x10)
        out += digits[c >> 4];
      out += digits[c & 0xf];
      out += '}';
    } else {
      out += c;
    }
  }
}
inline std::string quoted(std::string_view text) {
  std::string out = "\"";
  for (char c : text)
    escape(out, c, '"');
  return out + '"';
}
inline std::string quoted(char c) {
  std::string out = "'";
  escape(out, c, '\'');
  return out + '\'';
}
#endif
template <class T> std::string number(T value) {
  if constexpr (std::is_same_v<T, bool>) {
    return value ? "true" : "false";
  } else {
    char text[64];
    return std::string(text, std::to_chars(text, text + sizeof text, value).ptr);
  }
}
template <class T>
std::string render(const T &value, const char *type) {
  if constexpr (std::is_pointer_v<T> &&
                std::is_convertible_v<const T &, std::string_view>) {
    if (!value)
      return "nullptr";
  }
  if constexpr (std::is_convertible_v<const T &, std::string_view>) {
    return quoted(std::string_view(value));
  } else if constexpr (std::is_same_v<T, char>) {
    return quoted(value);
  } else if constexpr (std::is_enum_v<T>) {
    return number(static_cast<std::underlying_type_t<T>>(value));
#if defined(__cpp_lib_format_ranges)
  } else if constexpr (std::formattable<T, char>) {
    return std::format("{}", value);
#endif
  } else if constexpr (std::is_arithmetic_v<T>) {
    return number(value);
  } else if constexpr (streamable<T>::value) {
    std::ostringstream out;
    out << value;
    return std::move(out).str();
  } else {
    std::ostringstream out;
    out << '(' << type << ") @" << static_cast<const void *>(std::addressof(value));
    return std::move(out).str();
  }
}
} // namespace bayma_detail
template <class T>
void bayma_capture_result(T &&value, const char *type) noexcept {
  std::string text;
  try {
    text = bayma_detail::render<std::remove_cv_t<std::remove_reference_t<T>>>(
        value, type);
  } catch (const std::exception &error) {
    text = std::string("(") + type + ") <" + error.what() + ">";
  }
  bayma_report_result(text.data(), text.size());
}
static const auto bayma_detail_previous_terminate =
    std::set_terminate(bayma_detail::report_uncaught);
)cpp";

constexpr llvm::StringLiteral CPrelude = R"c(
const char *bayma_read_checkpoint(void);
int bayma_write_checkpoint(const char *json);
)c";

/// Replaces a C++ cell's trailing expression `e` with
/// `bayma_capture_result(e, "<type of e>")` before the cell is compiled.
///
/// Clang's own value capture strips the expression's cleanups before wrapping
/// it, so the inline destructor of a temporary inside it, such as the
/// allocator std::vector's constructor takes by default, is never emitted:
/// the cell fails to link, and every cell after it fails with it (LLVM
/// #225868). The call here is ordinary C++ that Sema checks like any other,
/// with the expression's cleanups kept, so its temporaries and their
/// destructors are handled as usual.
///
/// It also notes the running cell's translation unit in `CellUnit`, for a
/// failed cell's declarations to be forgotten; see rollback.h.
class ValueCapture : public clang::SemaConsumer {
public:
  explicit ValueCapture(clang::TranslationUnitDecl *&CellUnit)
      : CellUnit(CellUnit) {}

  void InitializeSema(clang::Sema &S) override { Sema = &S; }
  void ForgetSema() override { Sema = nullptr; }

  bool HandleTopLevelDecl(clang::DeclGroupRef Group) override {
    // The context's current unit while the cell parses; what Clang declares
    // implicitly belongs to its first.
    if (!CellUnit && Sema)
      CellUnit = Sema->getASTContext().getTranslationUnitDecl();
    if (!Sema || Sema->getDiagnostics().hasErrorOccurred())
      return true;
    for (clang::Decl *Declaration : Group)
      if (auto *Statement =
              llvm::dyn_cast<clang::TopLevelStmtDecl>(Declaration))
        if (Statement->isSemiMissing())
          capture(*Statement);
    return true;
  }

private:
  void capture(clang::TopLevelStmtDecl &Statement) {
    auto *Value = llvm::dyn_cast_if_present<clang::Expr>(Statement.getStmt());
    if (!Value)
      return;
    // The expression was checked as a full expression of its own; it is
    // checked again as part of the call, whose temporaries then include the
    // expression's.
    bool HadCleanups = false;
    if (auto *Cleanups = llvm::dyn_cast<clang::ExprWithCleanups>(Value)) {
      Value = Cleanups->getSubExpr();
      HadCleanups = true;
    }
    // Nothing to show for these, as for any statement.
    clang::QualType Type = Value->getType();
    if (Type->isVoidType() || Type->isFunctionType() ||
        Type->isDependentType() || Value->hasPlaceholderType())
      return;

    clang::ASTContext &Context = Sema->getASTContext();
    clang::SourceLocation Location = Value->getBeginLoc();
    if (!Capture) {
      clang::LookupResult Found(*Sema,
                                &Context.Idents.get("bayma_capture_result"),
                                Location, clang::Sema::LookupOrdinaryName);
      Sema->LookupQualifiedName(Found, Context.getTranslationUnitDecl());
      if (Found.empty())
        return;
      clang::CXXScopeSpec Scope;
      Capture =
          Sema->BuildDeclarationNameExpr(Scope, Found, /*ADL=*/false).get();
      if (!Capture)
        return;
    }
    std::string Spelled =
        Type.getNonReferenceType().getUnqualifiedType().getAsString(
            Context.getPrintingPolicy());
    clang::Expr *TypeName = clang::StringLiteral::Create(
        Context, Spelled, clang::StringLiteralKind::Ordinary,
        /*Pascal=*/false,
        Context.getStringLiteralArrayType(Context.CharTy, Spelled.size()),
        Location);

    // A value the call cannot take, such as a bit-field or an overload set,
    // is left as it was: the cell runs, with no result.
    clang::Sema::TentativeAnalysisScope Tentative(*Sema);
    clang::Expr *Arguments[] = {Value, TypeName};
    clang::ExprResult Call = Sema->ActOnCallExpr(
        /*Scope=*/nullptr, Capture, Location, Arguments, Value->getEndLoc());
    if (Call.isInvalid())
      return;
    if (HadCleanups)
      Sema->Cleanup.setExprNeedsCleanups(true);
    clang::ExprResult Full =
        Sema->ActOnFinishFullExpr(Call.get(), /*DiscardedValue=*/true);
    if (!Full.isInvalid())
      Statement.setStmt(Full.get());
  }

  clang::TranslationUnitDecl *&CellUnit;
  clang::Sema *Sema = nullptr;
  clang::Expr *Capture = nullptr;
};

/// Clang's diagnostics as text, which also tells the rollback when a cell
/// reports an error.
class DiagnosticPrinter : public clang::TextDiagnosticPrinter {
public:
  using clang::TextDiagnosticPrinter::TextDiagnosticPrinter;

  void HandleDiagnostic(clang::DiagnosticsEngine::Level Level,
                        const clang::Diagnostic &Info) override {
    clang::TextDiagnosticPrinter::HandleDiagnostic(Level, Info);
    if (Rollback && Level >= clang::DiagnosticsEngine::Error)
      Rollback->failed();
  }

  CellRollback *Rollback = nullptr;
};

/// Clang's Interpreter with bayma's value capture in place of its own.
class CapturingInterpreter : public clang::Interpreter {
public:
  CapturingInterpreter(
      std::unique_ptr<clang::CompilerInstance> Instance, llvm::Error &Err,
      std::unique_ptr<clang::IncrementalExecutorBuilder> Executor,
      clang::TranslationUnitDecl *&CellUnit)
      : Interpreter(std::move(Instance), Err, std::move(Executor),
                    std::make_unique<ValueCapture>(CellUnit)) {}
};

struct ExecSpec {
  std::string EventPrefix;
  std::string Code;
  bool Checkpointed = false;
  /// The session's committed checkpoint, which checkpointed execs carry.
  std::optional<std::string> CheckpointJson;
};

llvm::Expected<ExecSpec> readSpec(llvm::StringRef Path) {
  auto Buffer = llvm::MemoryBuffer::getFile(Path);
  if (!Buffer)
    return llvm::createStringError(Buffer.getError(),
                                   "cannot read exec spec " + Path);
  auto Parsed = llvm::json::parse((*Buffer)->getBuffer());
  if (!Parsed)
    return Parsed.takeError();
  const llvm::json::Object *Spec = Parsed->getAsObject();
  auto Schema = Spec ? Spec->getInteger("schema_version") : std::nullopt;
  auto Prefix = Spec ? Spec->getString("event_prefix") : std::nullopt;
  auto Code = Spec ? Spec->getString("code") : std::nullopt;
  auto Durability = Spec ? Spec->getString("durability_mode") : std::nullopt;
  if (Schema != 1 || !Prefix || Prefix->empty() ||
      Prefix->size() > maxCellPrefixSize() || !Code || !Durability)
    return llvm::createStringError("malformed exec spec " + Path);
  ExecSpec Result{Prefix->str(), Code->str(), *Durability == "checkpointed",
                  std::nullopt};
  if (auto Checkpoint = Spec->getString("checkpoint_json"))
    Result.CheckpointJson = Checkpoint->str();
  return Result;
}

std::vector<std::string> compilerArgs(const SessionOptions &Options,
                                      const SessionSettings &Settings) {
  std::vector<std::string> Args;
  if (Options.Lang == Language::Cxx)
    Args = {"-xc++", "-std=gnu++23", "-stdlib=libc++",
            // A trailing expression is the cell's result, so its value is
            // used, but Clang warns that a nodiscard one was ignored before
            // bayma captures it (LLVM #178595).
            "-Wno-unused-result"};
  else
    Args = {"-xc", "-std=gnu23"};
#ifdef __APPLE__
  Args.insert(Args.end(), {"-isysroot", Options.Sysroot});
#else
  Args.push_back("--sysroot=" + Options.Sysroot);
#endif
  // The payload's headers of the host's own libraries, libclang's among them.
  Args.insert(Args.end(), {"-isystem", Options.Root + "/include"});
  Args.insert(Args.end(), {"-iquote", Options.Cwd, "-fno-color-diagnostics"});
  // The session's own settings come last, so they can override bayma's.
  Args.insert(Args.end(), Settings.CompilerArgs.begin(),
              Settings.CompilerArgs.end());
  return Args;
}

#ifdef __linux__
/// On Linux cells run with the standard library they compile against: the
/// payload's libc++, whose libraries name one another without a search path,
/// so each is loaded by its full path, dependencies first; or the system's
/// libstdc++, which the system's C runtime came with.
llvm::Error loadStandardLibrary(clang::Interpreter &Interp,
                                llvm::StringRef Root, StandardLibrary Stdlib) {
  if (Stdlib == StandardLibrary::Libstdcxx)
    return Interp.LoadDynamicLibrary("libstdc++.so.6");
  llvm::SmallString<256> Directory(Root);
  llvm::sys::path::append(Directory, "lib",
                          llvm::sys::getDefaultTargetTriple());
  for (llvm::StringRef Library :
       {"libatomic.so.1", "libunwind.so.1", "libc++abi.so.1", "libc++.so.1"}) {
    llvm::SmallString<256> Path(Directory);
    llvm::sys::path::append(Path, Library);
    if (llvm::Error Err = Interp.LoadDynamicLibrary(Path.c_str()))
      return Err;
  }
  return llvm::Error::success();
}
#endif

/// Whether an input's failure was Clang's parser's, which discards what it
/// declared itself. Its errors, and only its, say so; anything else failed
/// to link or run.
bool failedToParse(llvm::StringRef Reason) {
  return Reason.starts_with("Parsing failed.");
}

} // namespace

Session::Session(Language Lang, OutputCapture &Capture)
    : Lang(Lang), Capture(Capture), Jit(std::make_shared<CellJit>()) {}

Session::~Session() = default;

llvm::Expected<std::unique_ptr<Session>>
Session::create(const SessionOptions &Options, OutputCapture &Capture) {
  auto Settings = readSettings(Options.Cwd, Options.Lang);
  if (!Settings)
    return Settings.takeError();
  std::vector<std::string> Args = compilerArgs(Options, *Settings);
  std::vector<const char *> Argv;
  for (const std::string &Arg : Args)
    Argv.push_back(Arg.c_str());
  clang::IncrementalCompilerBuilder Builder;
  Builder.SetCompilerArgs(Argv);
  auto Compiler = Builder.CreateCpp();
  if (!Compiler)
    return Compiler.takeError();

  std::unique_ptr<Session> S(new Session(Options.Lang, Capture));
  if (Options.Lang == Language::Cxx) {
    llvm::Error Err = llvm::Error::success();
    S->Interp = std::make_unique<CapturingInterpreter>(
        std::move(*Compiler), Err, executorBuilder(S->Jit), S->CellUnit);
    if (Err)
      return std::move(Err);
  } else {
    // C results are values or arrays of them, which Clang's own capture
    // handles.
    auto Interp = clang::Interpreter::create(std::move(*Compiler),
                                             executorBuilder(S->Jit));
    if (!Interp)
      return Interp.takeError();
    S->Interp = std::move(*Interp);
  }

  // Diagnostics become part of a cell's messages rather than host stderr.
  clang::CompilerInstance &Instance = *S->Interp->getCompilerInstance();
  auto *Printer =
      new DiagnosticPrinter(S->DiagnosticStream, Instance.getDiagnosticOpts());
  Instance.getDiagnostics().setClient(Printer, /*ShouldOwnClient=*/true);
  Printer->BeginSourceFile(Instance.getLangOpts(), &Instance.getPreprocessor());

#ifdef __linux__
  if (Options.Lang == Language::Cxx)
    if (llvm::Error Err =
            loadStandardLibrary(*S->Interp, Options.Root, Settings->Stdlib))
      return std::move(Err);
#endif
  if (llvm::Error Err = loadLibraries(*Settings, Options.Cwd))
    return std::move(Err);
  llvm::StringRef Prelude =
      Options.Lang == Language::Cxx ? CxxPrelude : CPrelude;
  if (llvm::Error Err = S->Interp->ParseAndExecute(Prelude))
    return llvm::joinErrors(std::move(Err),
                            llvm::createStringError(S->takeDiagnostics()));
  S->takeDiagnostics();
  S->Rollback = std::make_unique<CellRollback>(Instance.getSema(),
                                               Options.Lang == Language::Cxx);
  Printer->Rollback = S->Rollback.get();
  return S;
}

void Session::flushFailedCell() {
  // What a cell that fails to parse leaves for the next one to compile: the
  // template instantiations it asked for and the code Clang generated before
  // the error. An empty input takes them, and is undone with them.
  auto Empty = Interp->Parse("");
  if (!Empty) {
    llvm::consumeError(Empty.takeError());
    return;
  }
  if (llvm::Error Err = Interp->Undo())
    bayma_abandon_interpreter(("the failed cell could not be undone: " +
                               llvm::toString(std::move(Err)))
                                  .c_str());
}

void Session::linkCell() {
  // Each cell is a translation unit of its own, the context's latest.
  llvm::SmallVector<const clang::DeclContext *> Contexts{
      Interp->getASTContext().getTranslationUnitDecl()};
  while (!Contexts.empty()) {
    for (const clang::Decl *D : Contexts.pop_back_val()->decls()) {
      if (llvm::isa<clang::NamespaceDecl, clang::LinkageSpecDecl>(D)) {
        Contexts.push_back(llvm::cast<clang::DeclContext>(D));
        continue;
      }
      clang::GlobalDecl Symbol;
      if (auto *F = llvm::dyn_cast<clang::FunctionDecl>(D);
          F && F->isThisDeclarationADefinition() && !F->isInlined() &&
          !F->isTemplated() &&
          !llvm::isa<clang::CXXConstructorDecl, clang::CXXDestructorDecl>(F))
        Symbol = F;
      else if (auto *V = llvm::dyn_cast<clang::VarDecl>(D);
               V && V->hasGlobalStorage() && !V->isInline() &&
               !V->isTemplated() &&
               V->isThisDeclarationADefinition() == clang::VarDecl::Definition)
        Symbol = V;
      else
        continue;
      // One symbol the cell defines links all of its code.
      if (auto Address = Interp->getSymbolAddress(Symbol))
        return;
      else
        llvm::consumeError(Address.takeError());
    }
  }
}

std::string Session::takeDiagnostics() {
  // Each input is compiled as if included from a main file of that name,
  // which says nothing to someone reading a cell's error.
  constexpr llvm::StringLiteral IncludedFromInputs =
      "In file included from <<< inputs >>>:1:";
  llvm::SmallVector<llvm::StringRef> Lines;
  llvm::StringRef(Diagnostics).split(Lines, '\n');
  std::string Kept;
  for (llvm::StringRef Line : Lines)
    if (Line != IncludedFromInputs && !Line.empty())
      Kept += (Line + "\n").str();
  Diagnostics.clear();
  return Kept;
}

std::optional<std::string> Session::takeResult(const clang::Value &Result) {
  if (Lang == Language::Cxx)
    return std::exchange(CellApi.Result, std::nullopt);
  if (!Result.hasValue())
    return std::nullopt;
  std::string Printed;
  llvm::raw_string_ostream Stream(Printed);
  Result.printData(Stream);
  return llvm::StringRef(Printed).rtrim().str();
}

void Session::execute(llvm::StringRef SpecPath) {
  auto Spec = readSpec(SpecPath);
  if (!Spec) {
    // A spec bayma cannot have written: say so where bayma reads.
    writeProtocol("bayma-cpp-host: " + llvm::toString(Spec.takeError()) + "\n");
    return;
  }
  const std::string &Prefix = Spec->EventPrefix;
  // Every checkpointed exec carries the committed checkpoint, so a fresh
  // interpreter starts from it too.
  if (Spec->Checkpointed)
    CellApi.Checkpoint = Spec->CheckpointJson;
  CellApi.CheckpointError.clear();
  CellApi.Result.reset();
  takeDiagnostics();

  recordCellStart(Prefix);
  Capture.begin(Prefix);
  Rollback->begin();
  Jit->begin();
  CellUnit = nullptr;
  clang::Value Result;
  llvm::Error Failure = Interp->ParseAndExecute(Spec->Code, &Result);
  bool Failed = static_cast<bool>(Failure);
  std::string Reason = Failed ? llvm::toString(std::move(Failure)) : "";
  if (!Failed)
    linkCell();
  // A cell whose code uses what nothing defines ran none of it; see jit.h.
  if (std::vector<std::string> Undefined = Jit->undefined();
      !Undefined.empty()) {
    Reason =
        "the cell uses what nothing defines: " + llvm::join(Undefined, ", ");
    Failed = true;
  }
  // A failed cell leaves the session as it found it; see rollback.h. Clang
  // withdraws a cell that fails to parse itself, and one that fails to link
  // or run is undone here.
  if (Failed) {
    clang::TranslationUnitDecl *FailedUnit = CellUnit;
    if (failedToParse(Reason))
      flushFailedCell();
    else if (llvm::Error Err = Interp->Undo())
      bayma_abandon_interpreter(("the failed cell could not be undone: " +
                                 llvm::toString(std::move(Err)))
                                    .c_str());
    Rollback->revert(FailedUnit);
  }
  std::string Reported = takeDiagnostics();
  std::optional<std::string> Printed = takeResult(Result);

  // Everything the cell wrote reaches its envelopes before its outcome.
  std::fflush(nullptr);
  bool Drained = Capture.drain();
  if (Failed) {
    // "Parsing failed." adds nothing to the diagnostics that explain why.
    if (Reported.empty() || Reason != "Parsing failed.")
      Reported += Reason;
    writeProtocol(envelope(Prefix, "error", llvm::StringRef(Reported).rtrim()));
  } else {
    if (!Reported.empty())
      writeProtocol(envelope(Prefix, "stderr", Reported));
    if (Printed)
      writeProtocol(envelope(Prefix, "result", *Printed));
  }
  if (!Drained)
    writeProtocol(envelope(Prefix, "stderr",
                           "bayma: the cell's output did not drain in time; "
                           "some of it may be missing\n"));
  bool CheckpointRefused = !CellApi.CheckpointError.empty();
  if (CheckpointRefused)
    writeProtocol(envelope(Prefix, "error",
                           "bayma_write_checkpoint was given invalid JSON: " +
                               CellApi.CheckpointError));
  // A successful cell commits the checkpoint as it stands; a failed one
  // leaves the committed checkpoint as it was.
  if (Spec->Checkpointed) {
    if (Failed || CheckpointRefused)
      writeProtocol(envelope(Prefix, "checkpoint-preserved"));
    else
      writeProtocol(envelope(Prefix, "checkpoint",
                             CellApi.Checkpoint ? *CellApi.Checkpoint
                                                : llvm::StringRef("null")));
  }
  Capture.end();
  writeProtocol(envelope(Prefix, "done"));
  recordCellEnd();
}

} // namespace bayma

// The C API cells call, resolved by the JIT in the host process. Its symbols
// are exported by name; see exports.txt.
extern "C" {

/// The session's checkpoint as JSON text, or NULL when it has none.
LLVM_ATTRIBUTE_VISIBILITY_DEFAULT const char *bayma_read_checkpoint(void) {
  return bayma::CellApi.Checkpoint ? bayma::CellApi.Checkpoint->c_str()
                                   : nullptr;
}

/// Replaces the session's checkpoint with `json`, which must be JSON; NULL
/// clears it. Returns 0, or -1 when `json` is refused.
LLVM_ATTRIBUTE_VISIBILITY_DEFAULT int bayma_write_checkpoint(const char *json) {
  if (!json) {
    bayma::CellApi.Checkpoint.reset();
    return 0;
  }
  if (auto Parsed = llvm::json::parse(json); !Parsed) {
    bayma::CellApi.CheckpointError = llvm::toString(Parsed.takeError());
    return -1;
  }
  bayma::CellApi.Checkpoint = std::string(json);
  return 0;
}

/// Ends the interpreter after a failure its state cannot survive; the
/// supervisor reports `reason` as the running cell's error.
LLVM_ATTRIBUTE_VISIBILITY_DEFAULT [[noreturn]] void
bayma_abandon_interpreter(const char *reason) {
  bayma::recordCellFailure(reason);
  _exit(70);
}

/// Receives a C++ cell's result, rendered by bayma_capture_result.
LLVM_ATTRIBUTE_VISIBILITY_DEFAULT void bayma_report_result(const char *text,
                                                           std::size_t size) {
  bayma::CellApi.Result.emplace(text, size);
}
}
