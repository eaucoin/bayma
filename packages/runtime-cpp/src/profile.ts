import type { RuntimeModelProfile } from "@bayma/core";

/** What C and C++ sessions share, after each language's first sentence. */
const SHARED = [
  "Clang's incremental Interpreter (clang-repl) compiles each exec and runs it in the session's process, so definitions, variables, and #includes persist across execs.",
  "A trailing expression without a semicolon is the exec's result.",
  "Quoted #include paths resolve from the session working directory.",
  "A compile_flags.txt there, one argument per line as clangd reads it, sets the session's compiler arguments (such as -I, -isystem, -D, and -std=) and loads its libraries (-L and -l, or a library's path), each with the libraries it needs from those directories.",
  "Checkpointed recovery preserves only JSON text written with bayma_write_checkpoint(json) and read with bayma_read_checkpoint().",
].join(" ");

const FAILURES =
  "the exec ends with an error and the session continues in a fresh interpreter, keeping its checkpoint but losing its definitions and values; an interrupt does the same. Output written by threads after an exec returns is discarded, and interactive stdin is unavailable.";

export const cppModelProfile: RuntimeModelProfile = {
  runtimeId: "cpp",
  heading: "C++",
  description: `C++23 with libc++, or from C++17 on with -std=; on Linux, -stdlib=libstdc++ uses GCC's libstdc++, as a distribution's C++ libraries do. ${SHARED} An exec that fails to compile or link is undone, but for the headers it included that parsed, which stay included; a header that failed is read again when next included. Cells share what loaded libraries define, as a linked program would: template instantiations, type_info, and, on Linux, thread-local variables among them. Results print their contents when std::format can format them (numbers, strings, standard containers, pairs, and tuples, with libc++ in C++23), and otherwise when they are numbers, strings, or enumerations or have an operator<<. Clang's Interpreter cannot name a lambda written in a statement at a cell's top level, as a call's argument or in a block, if, or loop, and may crash the session on one; write the lambda as a top-level variable's initializer, or inside a function. If an exec crashes the process, throws an uncaught exception, or exits, ${FAILURES}`,
};

export const cModelProfile: RuntimeModelProfile = {
  runtimeId: "c",
  heading: "C",
  description: `C23, or another standard with -std=. ${SHARED} An exec that fails to compile or link is undone entirely, the headers it included among them, which the next cell to use them must include again. If an exec crashes the process or exits, ${FAILURES}`,
};
