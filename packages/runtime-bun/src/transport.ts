import { payloadValue, ProcessTransport } from "@bayma/core";

const BUN_PROMPT_RE = /(?:^|[\r\n])(?:> |❯ )/g;

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
    interruptProbe: (nonce) => {
      const expectedOutput = Buffer.from(nonce).toString("base64");
      return {
        input: `process.stdout.write(Buffer.from(${JSON.stringify(nonce)}).toString("base64") + "\\n"); void 0\n`,
        expectedOutput,
      };
    },
    command: () => ({
      file: payloadValue("BAYMA_BUN_BIN"),
      args: ["repl"],
    }),
  });
}
