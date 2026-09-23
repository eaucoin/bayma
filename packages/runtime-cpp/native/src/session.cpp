#include "session.h"

#include "protocol.h"
#include "supervisor.h"

#include "clang/AST/ASTContext.h"
#include "clang/AST/Decl.h"
#include "clang/AST/ExprCXX.h"
#include "clang/Frontend/CompilerInstance.h"
#include "clang/Frontend/TextDiagnosticPrinter.h"
#include "clang/Interpreter/Interpreter.h"
#include "clang/Interpreter/Value.h"
#include "clang/Lex/Preprocessor.h"
#include "clang/Sema/Lookup.h"
#include "clang/Sema/Sema.h"
#include "clang/Sema/SemaConsumer.h"
#include "llvm/Support/JSON.h"
#include "llvm/Support/MemoryBuffer.h"
#include "llvm/Support/Path.h"
#include "llvm/TargetParser/Host.h"

#include <cstdio>
#include <unistd.h>
#include <utility>
#include <vector>

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

// Declarations every C++ session starts with.
//
// An uncaught exception would reach std::terminate and abort without a word;
// it ends the interpreter with a report of what was thrown instead.
//
// A cell's trailing expression becomes a call to bayma_capture_result, which
// renders the value while the cell runs: string-likes quoted, whatever
// std::format formats (C++23 formats ranges, maps, and tuples), whatever has
// an operator<< streamed, enumerations as their value, and anything else by
// type and address.
constexpr llvm::StringLiteral CxxPrelude = R"cpp(
#include <cstddef>
#include <exception>
#include <format>
#include <memory>
#include <ostream>
#include <sstream>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
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
template <class T>
concept streamable = requires(std::ostream &out, const T &value) {
  out << value;
};
template <class T>
std::string render(const T &value, const char *type) {
  if constexpr (std::is_pointer_v<T> &&
                std::convertible_to<const T &, std::string_view>) {
    if (!value)
      return "nullptr";
  }
  if constexpr (std::convertible_to<const T &, std::string_view>) {
    return std::format("{:?}", std::string_view(value));
  } else if constexpr (std::is_same_v<T, char>) {
    return std::format("{:?}", value);
  } else if constexpr (std::is_enum_v<T>) {
    return std::format("{}", std::to_underlying(value));
  } else if constexpr (std::formattable<T, char>) {
    return std::format("{}", value);
  } else if constexpr (streamable<T>) {
    std::ostringstream out;
    out << value;
    return std::move(out).str();
  } else {
    return std::format("({}) @{}", type,
                       static_cast<const void *>(std::addressof(value)));
  }
}
} // namespace bayma_detail
template <class T>
void bayma_capture_result(T &&value, const char *type) noexcept {
  std::string text;
  try {
    text = bayma_detail::render<std::remove_cvref_t<T>>(value, type);
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
/// Clang's own value capture moves a class-typed result into storage it
/// destroys later, and marks the class's destructor used without
/// instantiating it, so the destructor of a template such as std::vector or
/// std::map is never compiled: the cell fails to link, and every cell after
/// it fails with it. The call is ordinary C++ that Sema checks like any
/// other, so its temporaries and their destructors are handled as usual.
class ValueCapture : public clang::SemaConsumer {
public:
  void InitializeSema(clang::Sema &S) override { Sema = &S; }
  void ForgetSema() override { Sema = nullptr; }

  bool HandleTopLevelDecl(clang::DeclGroupRef Group) override {
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

  clang::Sema *Sema = nullptr;
  clang::Expr *Capture = nullptr;
};

/// Clang's Interpreter with bayma's value capture in place of its own.
class CapturingInterpreter : public clang::Interpreter {
public:
  CapturingInterpreter(std::unique_ptr<clang::CompilerInstance> Instance,
                       llvm::Error &Err)
      : Interpreter(std::move(Instance), Err, /*IEB=*/nullptr,
                    std::make_unique<ValueCapture>()) {}
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

std::vector<std::string> compilerArgs(const SessionOptions &Options) {
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
  Args.insert(Args.end(), {"-iquote", Options.Cwd, "-fno-color-diagnostics"});
  return Args;
}

#ifdef __linux__
/// On Linux cells use the payload's libc++. Its libraries name one another
/// without a search path, so each is loaded by its full path, dependencies
/// first.
llvm::Error loadLibcxx(clang::Interpreter &Interp, llvm::StringRef Root) {
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

} // namespace

Session::Session(Language Lang, OutputCapture &Capture)
    : Lang(Lang), Capture(Capture) {}

Session::~Session() = default;

llvm::Expected<std::unique_ptr<Session>>
Session::create(const SessionOptions &Options, OutputCapture &Capture) {
  std::vector<std::string> Args = compilerArgs(Options);
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
    S->Interp =
        std::make_unique<CapturingInterpreter>(std::move(*Compiler), Err);
    if (Err)
      return std::move(Err);
  } else {
    // C results are values or arrays of them, which Clang's own capture
    // handles.
    auto Interp = clang::Interpreter::create(std::move(*Compiler));
    if (!Interp)
      return Interp.takeError();
    S->Interp = std::move(*Interp);
  }

  // Diagnostics become part of a cell's messages rather than host stderr.
  clang::CompilerInstance &Instance = *S->Interp->getCompilerInstance();
  auto *Printer = new clang::TextDiagnosticPrinter(
      S->DiagnosticStream, Instance.getDiagnosticOpts());
  Instance.getDiagnostics().setClient(Printer, /*ShouldOwnClient=*/true);
  Printer->BeginSourceFile(Instance.getLangOpts(), &Instance.getPreprocessor());

#ifdef __linux__
  if (Options.Lang == Language::Cxx)
    if (llvm::Error Err = loadLibcxx(*S->Interp, Options.Root))
      return std::move(Err);
#endif
  llvm::StringRef Prelude =
      Options.Lang == Language::Cxx ? CxxPrelude : CPrelude;
  if (llvm::Error Err = S->Interp->ParseAndExecute(Prelude))
    return llvm::joinErrors(std::move(Err),
                            llvm::createStringError(S->takeDiagnostics()));
  S->takeDiagnostics();
  return S;
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
  clang::Value Result;
  llvm::Error Failure = Interp->ParseAndExecute(Spec->Code, &Result);
  std::string Reported = takeDiagnostics();
  std::optional<std::string> Printed = takeResult(Result);

  // Everything the cell wrote reaches its envelopes before its outcome.
  std::fflush(nullptr);
  bool Drained = Capture.drain();
  if (Failure) {
    std::string Reason = llvm::toString(std::move(Failure));
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
    if (Failure || CheckpointRefused)
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
