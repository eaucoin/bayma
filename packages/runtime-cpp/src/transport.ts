import { execFileSync } from "node:child_process";
import { payloadValue, ProcessTransport } from "@bayma/core";
import type { RuntimeTransport } from "@bayma/core";

export const CPP_PROMPT = "BAYMA> ";

/** The languages bayma-cpp-host evaluates. */
export type CppLanguage = "c" | "c++";

/** The payload variable naming the host binary, per language. */
const HOST_BIN: Record<CppLanguage, string> = {
  c: "BAYMA_C_HOST_BIN",
  "c++": "BAYMA_CPP_HOST_BIN",
};

/**
 * One bayma-cpp-host per session. JIT-compiled code cannot be interrupted
 * safely, so an interrupt replaces the host; the host leads its own process
 * group, so anything a cell started goes with it.
 */
export function createCppTransport(language: CppLanguage): RuntimeTransport {
  return new ProcessTransport({
    platformId: "stdio",
    promptRe: /(?:^|[\r\n])BAYMA> /g,
    interruptStrategy: "recycle",
    ownsProcessTree: true,
    command: () => ({
      file: payloadValue(HOST_BIN[language]),
      args: [
        `--language=${language}`,
        ...(process.platform === "darwin" ? [`--sysroot=${macosSdk()}`] : []),
      ],
      // As Apple's toolchain names the SDK to Clang, so the libclang cells
      // call parses a project against it, as the project's build would.
      ...(process.platform === "darwin"
        ? { env: { SDKROOT: macosSdk() } }
        : {}),
    }),
  });
}

let sdk: string | undefined;

/**
 * macOS cells compile against the SDK of the Xcode Command Line Tools, which
 * cannot be redistributed; on Linux the payload carries its own headers.
 */
function macosSdk(): string {
  if (sdk === undefined) {
    try {
      sdk = execFileSync("xcrun", ["--show-sdk-path"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      throw new Error(
        "C and C++ sessions on macOS need the Xcode Command Line Tools; install them with `xcode-select --install`",
      );
    }
  }
  return sdk;
}
