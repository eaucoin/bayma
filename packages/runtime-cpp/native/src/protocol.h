// The host's side of bayma's line protocol: a prompt when the host is ready
// for a command, and JSON envelopes behind an exec's event prefix.

#pragma once

#include "llvm/ADT/StringRef.h"

#include <cstddef>
#include <optional>
#include <string>

namespace bayma {

/// Tells bayma the host is ready for its next command.
inline constexpr llvm::StringLiteral Prompt = "BAYMA> ";

/// Protocol output goes to `Fd`: the host's original stdout, set aside before
/// the user's stdout is captured.
void setProtocolFd(int Fd);

/// Writes `Bytes` to the protocol whole, from any thread. A host that can no
/// longer reach bayma exits.
void writeProtocol(llvm::StringRef Bytes);

/// One envelope line: `Prefix` and `{"kind": Kind, "text": Text}`, with the
/// text made valid UTF-8 and bounded to what bayma accepts in one message.
std::string envelope(llvm::StringRef Prefix, llvm::StringRef Kind,
                     std::optional<llvm::StringRef> Text = std::nullopt);

/// The length of the longest prefix of `Text` that ends on a UTF-8 character
/// boundary.
std::size_t completeUtf8Prefix(llvm::StringRef Text);

} // namespace bayma
