import type { RuntimeModelProfile } from "@bayma/core";

/** What C and C++ sessions share, after each language's first sentence. */
const SHARED = [
  "Clang's incremental Interpreter (clang-repl) compiles each exec and runs it in the session's process, so definitions, variables, and #includes persist across execs.",
  "A trailing expression without a semicolon is the exec's result.",
  "Quoted #include paths resolve from the session working directory.",
  "Checkpointed recovery preserves only JSON text written with bayma_write_checkpoint(json) and read with bayma_read_checkpoint().",
].join(" ");

const FAILURES =
  "the exec ends with an error and the session continues in a fresh interpreter, keeping its checkpoint but losing its definitions and values; an interrupt does the same. Output written by threads after an exec returns is discarded, and interactive stdin is unavailable.";

export const cppModelProfile: RuntimeModelProfile = {
  runtimeId: "cpp",
  heading: "C++",
  description: `C++23 with libc++. ${SHARED} Results print their contents when std::format can format them (numbers, strings, standard containers, pairs, and tuples) or they have an operator<<. Clang's Interpreter can crash on a lambda written inside a top-level statement; bind the lambda to a variable first, or make the call inside a function. If an exec crashes the process, throws an uncaught exception, or exits, ${FAILURES}`,
};

export const cModelProfile: RuntimeModelProfile = {
  runtimeId: "c",
  heading: "C",
  description: `C23. ${SHARED} If an exec crashes the process or exits, ${FAILURES}`,
};
