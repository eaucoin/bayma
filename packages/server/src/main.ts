import { failureDetail, runCli } from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { cAdapter, cppAdapter } from "@bayma/runtime-cpp";
import { dotnetScriptAdapter } from "@bayma/runtime-dotnet-script";
import { pythonAdapter } from "@bayma/runtime-python";
import { rustAdapter } from "@bayma/runtime-rust";

// The bayma binary: one server hosting every runtime.
runCli([
  bunAdapter,
  pythonAdapter,
  dotnetScriptAdapter,
  rustAdapter,
  cAdapter,
  cppAdapter,
]).catch((error: unknown) => {
  process.stderr.write(failureDetail(error) + "\n");
  process.exit(1);
});
