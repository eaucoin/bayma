#include "supervisor.h"

#include "protocol.h"

#include <algorithm>
#include <atomic>
#include <cerrno>
#include <cstring>
#include <new>
#include <string>
#include <sys/mman.h>
#include <sys/wait.h>
#include <unistd.h>

namespace bayma {

namespace {

/// What a worker tells its supervisor about the cell it is running.
struct RunningCell {
  std::atomic<bool> Running{false};
  char Prefix[512] = {};
  char Reason[4096] = {};
};

RunningCell *Cell = nullptr;

void copyBounded(char *Destination, std::size_t Capacity,
                 llvm::StringRef Source) {
  std::size_t Length = std::min(Source.size(), Capacity - 1);
  std::memcpy(Destination, Source.data(), Length);
  Destination[Length] = '\0';
}

std::string describeDeath(int Status) {
  if (WIFSIGNALED(Status))
    return "The cell was ended by signal " + std::to_string(WTERMSIG(Status)) +
           " (" + ::strsignal(WTERMSIG(Status)) + ").";
  return "The cell ended the process with exit status " +
         std::to_string(WEXITSTATUS(Status)) + ".";
}

} // namespace

int supervise(llvm::unique_function<void()> RunWorker) {
  void *Shared = ::mmap(nullptr, sizeof(RunningCell), PROT_READ | PROT_WRITE,
                        MAP_SHARED | MAP_ANONYMOUS, -1, 0);
  if (Shared == MAP_FAILED)
    return 1;
  Cell = new (Shared) RunningCell();
  for (;;) {
    Cell->Running = false;
    pid_t Worker = ::fork();
    if (Worker < 0)
      return 1;
    if (Worker == 0) {
      RunWorker();
      _exit(1);
    }
    int Status = 0;
    while (::waitpid(Worker, &Status, 0) < 0 && errno == EINTR) {
    }
    if (!Cell->Running) {
      // Between cells: bayma closed the session, or the interpreter never
      // started. Either way this host is done.
      return WIFEXITED(Status) ? WEXITSTATUS(Status) : 1;
    }
    std::string Reason =
        Cell->Reason[0] ? std::string(Cell->Reason) : describeDeath(Status);
    writeProtocol(envelope(Cell->Prefix, "error",
                           Reason + "\nThe session's state was lost; it "
                                    "continues in a fresh interpreter."));
    writeProtocol(envelope(Cell->Prefix, "done"));
  }
}

void recordCellStart(llvm::StringRef Prefix) {
  copyBounded(Cell->Prefix, sizeof(Cell->Prefix), Prefix);
  Cell->Reason[0] = '\0';
  Cell->Running = true;
}

void recordCellEnd() { Cell->Running = false; }

void recordCellFailure(llvm::StringRef Reason) {
  copyBounded(Cell->Reason, sizeof(Cell->Reason), Reason);
}

std::size_t maxCellPrefixSize() { return sizeof(RunningCell::Prefix) - 1; }

} // namespace bayma
