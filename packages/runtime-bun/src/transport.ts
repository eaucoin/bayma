import { payloadValue, ProcessTransport, type PromptProbe } from "@bayma/core";

const BUN_PROMPT_RE = /(?:^|[\r\n])(?:> |❯ )/g;

/** A line that runs `code`, then prints `nonce` in base64. */
function printingNonce(code: string, nonce: string): PromptProbe {
  return {
    input: `${code}process.stdout.write(Buffer.from(${JSON.stringify(nonce)}).toString("base64") + "\\n"); void 0\n`,
    expectedOutput: Buffer.from(nonce).toString("base64"),
  };
}

export function createBunTransport(): ProcessTransport {
  return new ProcessTransport({
    platformId: "tmux",
    promptRe: BUN_PROMPT_RE,
    // Bun's interactive editor can consume the terminating newline before it
    // has finished applying a piped line's preceding bytes. Submit Enter as a
    // separate bounded step so a complete .load command cannot remain running
    // until unrelated later input arrives.
    lineSubmitDelayMs: 10,
    interruptStrategy: "write_ctrl_c",
    interruptProbe: (nonce) => printingNonce("", nonce),
    // A full collection takes about a quarter off what a save of the sandbox
    // holds of a session that worked, for some 75 ms.
    garbageCollectionProbe: (nonce) => printingNonce("Bun.gc(true); ", nonce),
    command: () => ({
      file: payloadValue("BAYMA_BUN_BIN"),
      args: ["repl"],
    }),
  });
}
