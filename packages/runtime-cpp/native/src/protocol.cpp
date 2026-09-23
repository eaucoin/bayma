#include "protocol.h"

#include "llvm/Support/JSON.h"
#include "llvm/Support/raw_ostream.h"

#include <mutex>
#include <unistd.h>

namespace bayma {

namespace {

// Headroom below the 64 KiB ceiling bayma puts on one message, so this
// marker, not a second truncation, is what a reader sees.
constexpr std::size_t MaxMessageBytes = 60 * 1024;
constexpr llvm::StringLiteral TruncationMarker =
    "…Bayma truncated runtime message…";

int ProtocolFd = -1;
std::mutex ProtocolMutex;

bool isContinuationByte(char Byte) {
  return (static_cast<unsigned char>(Byte) & 0xC0) == 0x80;
}

std::string boundedText(llvm::StringRef Text) {
  std::string Valid =
      llvm::json::isUTF8(Text) ? Text.str() : llvm::json::fixUTF8(Text);
  if (Valid.size() <= MaxMessageBytes)
    return Valid;
  // Keep the start and the end, which is where output usually says the most.
  llvm::StringRef Whole(Valid);
  std::size_t Payload = MaxMessageBytes - TruncationMarker.size();
  std::size_t Left = completeUtf8Prefix(Whole.take_front(Payload / 2));
  std::size_t Right = Whole.size() - (Payload - Left);
  while (Right < Whole.size() && isContinuationByte(Whole[Right]))
    ++Right;
  return (Whole.take_front(Left) + TruncationMarker + Whole.drop_front(Right))
      .str();
}

} // namespace

void setProtocolFd(int Fd) { ProtocolFd = Fd; }

void writeProtocol(llvm::StringRef Bytes) {
  std::lock_guard<std::mutex> Lock(ProtocolMutex);
  while (!Bytes.empty()) {
    ssize_t Written = ::write(ProtocolFd, Bytes.data(), Bytes.size());
    if (Written <= 0)
      _exit(1);
    Bytes = Bytes.drop_front(static_cast<std::size_t>(Written));
  }
}

std::string envelope(llvm::StringRef Prefix, llvm::StringRef Kind,
                     std::optional<llvm::StringRef> Text) {
  llvm::json::Object Payload{{"kind", Kind}};
  if (Text)
    Payload["text"] = boundedText(*Text);
  std::string Line;
  llvm::raw_string_ostream(Line)
      << Prefix << llvm::json::Value(std::move(Payload)) << "\n";
  return Line;
}

std::size_t completeUtf8Prefix(llvm::StringRef Text) {
  std::size_t End = Text.size();
  std::size_t Trailing = 0;
  while (Trailing < 3 && Trailing < End &&
         isContinuationByte(Text[End - 1 - Trailing]))
    ++Trailing;
  if (Trailing == End)
    return End;
  auto Lead = static_cast<unsigned char>(Text[End - 1 - Trailing]);
  std::size_t Width = Lead >= 0xF0   ? 4
                      : Lead >= 0xE0 ? 3
                      : Lead >= 0xC0 ? 2
                                     : 1;
  // A lead byte still waiting for continuation bytes starts the remainder.
  return Trailing + 1 < Width ? End - 1 - Trailing : End;
}

} // namespace bayma
