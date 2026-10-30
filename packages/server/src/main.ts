import { failureDetail } from "@bayma/core/errors";
import { runSandboxHookCommand } from "@bayma/core/sandbox-hook";

// The bayma binary: one server hosting every runtime. The sandbox hook, which
// gVisor starts as a process of its own on the path of every save and restore
// of the sandbox the server runs in, loads none of the server: its modules are
// imported for every other command alone, a chunk of their own beside this
// one's (tooling/src/build.ts).
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "sandbox-hook") return runSandboxHookCommand(args);
  const [
    { runCli },
    { bunAdapter },
    { cAdapter, cppAdapter },
    { dotnetScriptAdapter },
    { goAdapter },
    { leanAdapter },
    { pythonAdapter },
    { rustAdapter },
  ] = await Promise.all([
    import("@bayma/core"),
    import("@bayma/runtime-bun"),
    import("@bayma/runtime-cpp"),
    import("@bayma/runtime-dotnet-script"),
    import("@bayma/runtime-go"),
    import("@bayma/runtime-lean"),
    import("@bayma/runtime-python"),
    import("@bayma/runtime-rust"),
  ]);
  return runCli([
    bunAdapter,
    pythonAdapter,
    dotnetScriptAdapter,
    rustAdapter,
    cAdapter,
    cppAdapter,
    leanAdapter,
    goAdapter,
  ]);
}

main().catch((error: unknown) => {
  process.stderr.write(failureDetail(error) + "\n");
  process.exit(1);
});
