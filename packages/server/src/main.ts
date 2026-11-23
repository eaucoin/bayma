import { failureDetail, failureMessage } from "@bayma/core/errors";
import { runSandboxHookCommand } from "@bayma/core/sandbox-hook";

// The bayma binary: one server hosting every runtime. The sandbox hook, which
// gVisor starts as a process of its own on the path of every save and restore
// of the sandbox the server runs in, loads none of the server: its modules are
// imported for every other command alone, a chunk of their own beside this
// one's (tooling/src/build.ts).
async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "sandbox-hook") {
    // What the hook could not do, said as its words alone, as bayma's image's
    // hook without Node (packages/core/native/sandbox-hook.c) says it: a
    // host shows it as the reason its save or restore failed.
    try {
      return await runSandboxHookCommand(args);
    } catch (error) {
      process.stderr.write(failureMessage(error) + "\n");
      process.exit(1);
    }
  }
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
