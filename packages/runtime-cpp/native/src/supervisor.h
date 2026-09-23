// A cell can take its process down: a fault, an uncaught exception, exit(),
// or the kernel's OOM killer. So the host is a small supervisor that forks the
// interpreter as a worker. The worker records the cell it runs in memory it
// shares with the supervisor, which reports that cell's error when the worker
// dies and starts a fresh worker in its place.

#pragma once

#include "llvm/ADT/FunctionExtras.h"
#include "llvm/ADT/StringRef.h"

namespace bayma {

/// A worker's exit status when its interpreter could not start.
inline constexpr int WorkerFailedToStart = 3;

/// Runs workers until one ends between cells, and returns that worker's exit
/// status. `RunWorker` runs in each forked worker and never returns.
int supervise(llvm::unique_function<void()> RunWorker);

/// In a worker: the cell with this event prefix is about to run.
void recordCellStart(llvm::StringRef Prefix);

/// In a worker: the running cell has reported its outcome.
void recordCellEnd();

/// In a worker: why the running cell is about to end the worker, for the
/// supervisor to report in place of the bare exit status.
void recordCellFailure(llvm::StringRef Reason);

/// The longest event prefix a cell can be recorded with.
std::size_t maxCellPrefixSize();

} // namespace bayma
