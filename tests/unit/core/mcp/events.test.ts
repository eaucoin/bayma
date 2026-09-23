import { expect, test } from "bun:test";
import { TextDecoder } from "node:util";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  Utf8LineProjector,
  SubscribedResourceUpdatePublisher,
  SERVER_EVENTS_URI,
} from "@bayma/core";

test("the output projector preserves order and UTF-8 line boundaries", () => {
  const decoder = new TextDecoder();
  const projector = new Utf8LineProjector();
  const bytes = new Uint8Array(Buffer.from("alpha\n€beta\n", "utf8"));

  const first = decoder.decode(bytes.slice(0, 8), { stream: true });
  const second = decoder.decode(bytes.slice(8), { stream: false });

  expect(projector.push(first)).toEqual(["alpha"]);
  expect(projector.push(second)).toEqual(["€beta"]);
  expect(projector.finish()).toEqual([]);
});

test("resource update projection coalesces output bursts", async () => {
  let releaseFirstSend: () => void = () => {};
  const firstSendBlocked = new Promise<void>((resolve) => {
    releaseFirstSend = resolve;
  });
  let updateCalls = 0;
  const server = {
    server: {
      sendResourceListChanged: async () => undefined,
      sendResourceUpdated: async () => {
        updateCalls += 1;
        if (updateCalls === 1) await firstSendBlocked;
      },
    },
  } as unknown as McpServer;
  const publisher = new SubscribedResourceUpdatePublisher(
    server,
    new Set([SERVER_EVENTS_URI]),
  );

  publisher.publish({
    type: "exec/ptyDelta",
    sessionId: "sess_1",
    execId: "exec_1",
    seq: 1,
    channel: "pty",
    dataBase64: "eA==",
  });
  for (let seq = 2; seq <= 1_000; seq += 1) {
    publisher.publish({
      type: "exec/ptyDelta",
      sessionId: "sess_1",
      execId: "exec_1",
      seq,
      channel: "pty",
      dataBase64: "eA==",
    });
  }
  releaseFirstSend();
  await publisher.flush();

  expect(updateCalls).toBe(2);
});
