// bayma-cpp-host: the protocol process behind bayma's C and C++ runtimes.
//
//   bayma-cpp-host --language=c|c++ [--sysroot=PATH]
//
// It prints a prompt, then serves `:exec <spec>` lines until its input closes.
// See ../README.md for the design.

#include "capture.h"
#include "protocol.h"
#include "session.h"
#include "supervisor.h"

#include "llvm/Support/FileSystem.h"
#include "llvm/Support/Path.h"
#include "llvm/Support/TargetSelect.h"
#include "llvm/Support/raw_ostream.h"

#include <cstdio>
#include <fcntl.h>
#include <unistd.h>

namespace {

using namespace bayma;

/// One interpreter, serving `:exec` lines until the protocol input closes.
[[noreturn]] void runWorker(SessionOptions Options) {
  // Cells cannot read the protocol: their stdin is empty, and their stdout
  // and stderr are captured while the protocol keeps the originals.
  int ProtocolIn = ::dup(STDIN_FILENO);
  int Null = ::open("/dev/null", O_RDONLY);
  ::dup2(Null, STDIN_FILENO);
  ::close(Null);
  OutputCapture Capture;
  std::setvbuf(stdout, nullptr, _IOLBF, 0);

  llvm::InitializeNativeTarget();
  llvm::InitializeNativeTargetAsmPrinter();
  auto S = Session::create(Options, Capture);
  if (!S) {
    writeProtocol("bayma-cpp-host: " + llvm::toString(S.takeError()) + "\n");
    _exit(WorkerFailedToStart);
  }

  FILE *Input = ::fdopen(ProtocolIn, "r");
  writeProtocol(Prompt);
  char *Line = nullptr;
  std::size_t Capacity = 0;
  ssize_t Length;
  while ((Length = ::getline(&Line, &Capacity, Input)) >= 0) {
    llvm::StringRef Command =
        llvm::StringRef(Line, static_cast<std::size_t>(Length)).trim();
    if (Command.consume_front(":exec "))
      (*S)->execute(Command);
    writeProtocol(Prompt);
  }
  // bayma closed the session.
  _exit(0);
}

} // namespace

int main(int Argc, const char **Argv) {
  SessionOptions Options;
  std::string Language;
  for (int Index = 1; Index < Argc; ++Index) {
    llvm::StringRef Arg(Argv[Index]);
    if (Arg.consume_front("--language="))
      Language = Arg.str();
    else if (Arg.consume_front("--sysroot="))
      Options.Sysroot = Arg.str();
    else {
      llvm::errs() << "bayma-cpp-host: unknown argument " << Arg << "\n";
      return 2;
    }
  }
  if (Language == "c")
    Options.Lang = bayma::Language::C;
  else if (Language == "c++")
    Options.Lang = bayma::Language::Cxx;
  else {
    llvm::errs() << "bayma-cpp-host: --language must be c or c++\n";
    return 2;
  }

  std::string Executable = llvm::sys::fs::getMainExecutable(
      Argv[0], reinterpret_cast<void *>(&runWorker));
  Options.Root =
      llvm::sys::path::parent_path(llvm::sys::path::parent_path(Executable))
          .str();
  // On Linux the payload carries the system headers cells compile against;
  // on macOS they are the SDK's, which bayma names.
  if (Options.Sysroot.empty())
    Options.Sysroot = Options.Root + "/sysroot";
  llvm::SmallString<256> Cwd;
  llvm::sys::fs::current_path(Cwd);
  Options.Cwd = Cwd.str().str();

  setProtocolFd(::dup(STDOUT_FILENO));
  return supervise([Options] { runWorker(Options); });
}
