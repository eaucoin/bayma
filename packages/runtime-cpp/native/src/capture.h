// The user's stdout and stderr, captured at the descriptor level: printf,
// std::cout, and child processes alike write into pipes whose contents become
// envelopes of the running cell.

#pragma once

#include "llvm/ADT/StringRef.h"

#include <memory>
#include <mutex>
#include <optional>
#include <string>

namespace bayma {

/// A worker's one capture. Its reader threads block in read() for the rest of
/// the process, so the worker ends by exiting with its capture in place.
class OutputCapture {
public:
  /// Replaces descriptors 1 and 2 with pipes read by background threads.
  OutputCapture();
  ~OutputCapture();

  /// Attributes output to the cell with event prefix `Prefix`. Output that
  /// arrives while no cell runs is discarded.
  void begin(std::string Prefix);

  /// Waits until everything written to either descriptor so far has been
  /// forwarded. False if it did not drain in time.
  bool drain();

  void end();

  /// The running cell's event prefix, if a cell is running.
  std::optional<std::string> prefix();

private:
  class Stream;

  std::mutex M;
  std::optional<std::string> Prefix;
  std::unique_ptr<Stream> Out;
  std::unique_ptr<Stream> Err;
};

} // namespace bayma
