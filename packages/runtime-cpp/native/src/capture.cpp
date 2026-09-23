#include "capture.h"

#include "protocol.h"

#include "llvm/ADT/StringExtras.h"

#include <chrono>
#include <condition_variable>
#include <random>
#include <thread>
#include <unistd.h>
#include <vector>

namespace bayma {

namespace {

constexpr auto DrainTimeout = std::chrono::seconds(5);

/// A marker no cell writes by accident: record separators around 128 random
/// bits.
std::string freshMarker() {
  std::random_device Device;
  std::string Marker = "\x1e"
                       "bayma-drain-";
  for (int Word = 0; Word < 4; ++Word)
    Marker += llvm::utohexstr(Device(), /*LowerCase=*/true, /*Width=*/8);
  return Marker + "\x1e";
}

} // namespace

/// One captured descriptor. `drain` writes a fresh marker through the pipe
/// and waits for the reader to reach it, so everything written before it has
/// been forwarded.
class OutputCapture::Stream {
public:
  Stream(OutputCapture &Owner, int TargetFd, llvm::StringRef Kind)
      : Owner(Owner), TargetFd(TargetFd), Kind(Kind) {
    int Fds[2];
    if (::pipe(Fds) != 0 || ::dup2(Fds[1], TargetFd) < 0)
      _exit(1);
    ::close(Fds[1]);
    ReadFd = Fds[0];
    std::thread([this] { read(); }).detach();
  }

  bool drain(const std::string &Marker) {
    {
      std::lock_guard<std::mutex> Lock(M);
      PendingMarker = Marker;
    }
    if (::write(TargetFd, Marker.data(), Marker.size()) !=
        static_cast<ssize_t>(Marker.size()))
      return false;
    std::unique_lock<std::mutex> Lock(M);
    return Drained.wait_for(Lock, DrainTimeout,
                            [this] { return PendingMarker.empty(); });
  }

private:
  void read() {
    std::vector<char> Buffer(64 * 1024);
    for (;;) {
      ssize_t N = ::read(ReadFd, Buffer.data(), Buffer.size());
      if (N <= 0)
        return;
      std::lock_guard<std::mutex> Lock(M);
      Held.append(Buffer.data(), static_cast<std::size_t>(N));
      forwardHeld();
    }
  }

  void forwardHeld() {
    if (PendingMarker.empty()) {
      forward(Held);
      Held.clear();
      return;
    }
    std::size_t At = Held.find(PendingMarker);
    if (At == std::string::npos) {
      // Hold back only what could still be the start of the marker.
      std::size_t Keep = std::min(Held.size(), PendingMarker.size() - 1);
      forward(llvm::StringRef(Held).drop_back(Keep));
      Held.erase(0, Held.size() - Keep);
      return;
    }
    forward(llvm::StringRef(Held).take_front(At));
    flushIncompleteCharacter();
    Held.erase(0, At + PendingMarker.size());
    PendingMarker.clear();
    Drained.notify_all();
    forwardHeld();
  }

  /// Forwards whole UTF-8 characters, keeping a split one for the next read.
  void forward(llvm::StringRef Bytes) {
    Partial.append(Bytes.begin(), Bytes.end());
    std::size_t Complete = completeUtf8Prefix(Partial);
    if (Complete > 0)
      emit(llvm::StringRef(Partial).take_front(Complete));
    Partial.erase(0, Complete);
  }

  void flushIncompleteCharacter() {
    if (!Partial.empty())
      emit(Partial);
    Partial.clear();
  }

  void emit(llvm::StringRef Text) {
    if (auto Prefix = Owner.prefix())
      writeProtocol(envelope(*Prefix, Kind, Text));
  }

  OutputCapture &Owner;
  int TargetFd;
  int ReadFd = -1;
  llvm::StringRef Kind;
  std::mutex M;
  std::condition_variable Drained;
  std::string PendingMarker;
  std::string Held;
  std::string Partial;
};

OutputCapture::OutputCapture()
    : Out(std::make_unique<Stream>(*this, STDOUT_FILENO, "stdout")),
      Err(std::make_unique<Stream>(*this, STDERR_FILENO, "stderr")) {}

OutputCapture::~OutputCapture() = default;

void OutputCapture::begin(std::string CellPrefix) {
  std::lock_guard<std::mutex> Lock(M);
  Prefix = std::move(CellPrefix);
}

bool OutputCapture::drain() {
  std::string Marker = freshMarker();
  bool OutDrained = Out->drain(Marker);
  return Err->drain(Marker) && OutDrained;
}

void OutputCapture::end() {
  std::lock_guard<std::mutex> Lock(M);
  Prefix.reset();
}

std::optional<std::string> OutputCapture::prefix() {
  std::lock_guard<std::mutex> Lock(M);
  return Prefix;
}

} // namespace bayma
