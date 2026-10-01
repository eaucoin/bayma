import { Buffer } from "node:buffer";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CheckpointStore,
  ExecHistoryStore,
  imageMimeType,
  RUNTIME_OUTPUT_CAPTURE_POLICY,
  RuntimeRegistry,
  SessionCatalogStore,
  SessionManager,
  type ExecRecord,
  type SessionEvent,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { FakeTransport } from "../../../../support/fake-transport.ts";
import { withTempDir } from "../../../../support/temp.ts";

// A one-pixel PNG.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

function managerFor(dir: string, transport: FakeTransport) {
  const events: SessionEvent[] = [];
  const historyStore = new ExecHistoryStore(dir);
  const manager = new SessionManager(
    new RuntimeRegistry([{ adapter: bunAdapter, transport }]),
    new SessionCatalogStore(dir),
    historyStore,
    new CheckpointStore(dir),
    {
      maxSessions: 8,
      warnUsagePercent: 75,
      defaultCols: 80,
      defaultRows: 24,
    },
    ({ event }) => events.push(event),
  );
  return { manager, historyStore, events };
}

/**
 * Runs an exec whose runtime shows each of `images`, as a file it removes
 * once the exec ends, as runtimes' exec directories are.
 */
async function showImages(
  dir: string,
  images: Uint8Array[],
): Promise<
  {
    exec: ExecRecord;
    sessionId: string;
  } & ReturnType<typeof managerFor>
> {
  const transport = new FakeTransport(false);
  const fixture = managerFor(dir, transport);
  const { sessionId } = await fixture.manager.createWithPolicy(
    "actor_1",
    "images",
    dir,
    { durabilityMode: "ephemeral" },
    "controller",
  );
  const { execId } = await fixture.manager.submitExec(
    sessionId,
    "actor_1",
    "show()",
  );
  const marker = transport.pendingEventPrefix(sessionId);
  const execDir = join(dir, "exec");
  mkdirSync(execDir);
  images.forEach((image, index) => {
    const payloadPath = join(execDir, `image-${index}`);
    writeFileSync(payloadPath, image);
    transport.emit(
      sessionId,
      `${marker}${JSON.stringify({ kind: "image", payloadPath })}\n`,
    );
  });
  transport.completeNext(sessionId);
  await Bun.sleep(0);
  rmSync(execDir, { recursive: true });
  return {
    ...fixture,
    sessionId,
    exec: fixture.manager.exec(sessionId, execId),
  };
}

test("image formats are read from the bytes' signatures", () => {
  const bytes = (text: string) => Buffer.from(text, "latin1");
  expect(imageMimeType(PNG)).toBe("image/png");
  expect(imageMimeType(bytes("\xff\xd8\xff\xe0JFIF"))).toBe("image/jpeg");
  expect(imageMimeType(bytes("GIF87a..."))).toBe("image/gif");
  expect(imageMimeType(bytes("GIF89a..."))).toBe("image/gif");
  expect(imageMimeType(bytes("RIFF\x10\0\0\0WEBPVP8 "))).toBe("image/webp");
  expect(imageMimeType(bytes("RIFF\x10\0\0\0WAVEfmt "))).toBeUndefined();
  expect(imageMimeType(bytes("<svg/>"))).toBeUndefined();
  expect(imageMimeType(new Uint8Array())).toBeUndefined();
});

test("an image an exec shows is kept beside its history and announced without its bytes", async () => {
  await withTempDir(async (dir) => {
    const { exec, sessionId, manager, historyStore, events } = await showImages(
      dir,
      [PNG],
    );

    expect(exec.status).toBe("ok");
    const [message] = exec.messages;
    expect(exec.messages).toHaveLength(1);
    expect(message).toMatchObject({
      seq: 1,
      kind: "image",
      text: "",
      image: { mimeType: "image/png", byteLength: PNG.byteLength },
    });
    // The runtime's file is gone; the kept copy remains.
    expect(manager.execImage(sessionId, exec.execId, 1)).toEqual({
      mimeType: "image/png",
      byteLength: PNG.byteLength,
      bytes: PNG,
    });
    expect(historyStore.read(sessionId)[0]?.messages).toEqual(exec.messages);
    expect(events).toContainEqual({
      type: "exec/image",
      sessionId,
      execId: exec.execId,
      seq: 1,
      messageId: message!.messageId,
      mimeType: "image/png",
      byteLength: PNG.byteLength,
    });
    expect(() => manager.execImage(sessionId, exec.execId, 2)).toThrow(
      "has no image at seq 2",
    );
  });
});

test("an exec's images obey the capture policy, and each refusal says why", async () => {
  const { maxExecImages, maxImageBytes, maxExecImageBytes } =
    RUNTIME_OUTPUT_CAPTURE_POLICY;
  const sized = (byteLength: number) =>
    Buffer.concat([PNG, Buffer.alloc(byteLength - PNG.byteLength)]);
  const refusals = (exec: ExecRecord) =>
    exec.messages
      .filter((message) => message.kind === "stderr")
      .map((message) => message.text);

  await withTempDir(async (dir) => {
    const { exec } = await showImages(dir, [
      Buffer.from("not an image"),
      sized(maxImageBytes + 1),
      PNG,
    ]);
    expect(exec.status).toBe("ok");
    expect(refusals(exec)).toEqual([
      "Bayma did not show an image: it is not a PNG, JPEG, GIF, or WebP image\n",
      `Bayma did not show an image: an image holds at most ${maxImageBytes} bytes\n`,
    ]);
    expect(exec.messages.at(-1)?.kind).toBe("image");
  });

  await withTempDir(async (dir) => {
    const { exec } = await showImages(
      dir,
      Array.from({ length: maxExecImages + 1 }, () => PNG),
    );
    expect(
      exec.messages.filter((message) => message.kind === "image"),
    ).toHaveLength(maxExecImages);
    expect(refusals(exec)).toEqual([
      `Bayma did not show an image: an exec shows at most ${maxExecImages} images\n`,
    ]);
  });

  await withTempDir(async (dir) => {
    const count = Math.floor(maxExecImageBytes / maxImageBytes) + 1;
    const { exec } = await showImages(
      dir,
      Array.from({ length: count }, () => sized(maxImageBytes)),
    );
    expect(
      exec.messages.filter((message) => message.kind === "image"),
    ).toHaveLength(count - 1);
    expect(refusals(exec)).toEqual([
      `Bayma did not show an image: an exec's images hold at most ${maxExecImageBytes} bytes together\n`,
    ]);
  });
});

test("a file the runtime did not leave is refused", async () => {
  await withTempDir(async (dir) => {
    const transport = new FakeTransport(false);
    const { manager } = managerFor(dir, transport);
    const { sessionId } = await manager.createWithPolicy(
      "actor_1",
      "missing image",
      dir,
      { durabilityMode: "ephemeral" },
      "controller",
    );
    const { execId } = await manager.submitExec(sessionId, "actor_1", "1");
    transport.emit(
      sessionId,
      `${transport.pendingEventPrefix(sessionId)}${JSON.stringify({
        kind: "image",
        payloadPath: join(dir, "missing.png"),
      })}\n`,
    );
    transport.completeNext(sessionId);
    await Bun.sleep(0);
    const [message] = manager.exec(sessionId, execId).messages;
    expect(message?.kind).toBe("stderr");
    expect(message?.text).toContain("Bayma did not show an image: ");
    expect(message?.text).toContain("ENOENT");
  });
});

test("a session's images go with it, and loading removes those no session owns", async () => {
  await withTempDir(async (dir) => {
    const { exec, sessionId, manager, historyStore } = await showImages(dir, [
      PNG,
    ]);
    const imagePath = historyStore.imagePath(
      sessionId,
      exec.messages[0]!.messageId,
    );
    expect(existsSync(imagePath)).toBe(true);
    await manager.close(sessionId, "actor_1");
    expect(existsSync(join(historyStore.imagesDir, sessionId))).toBe(false);
  });

  await withTempDir(async (dir) => {
    const first = managerFor(dir, new FakeTransport());
    const { sessionId } = await first.manager.create("actor_1", "kept", dir);
    await first.manager.shutdown();
    const owned = join(first.historyStore.imagesDir, sessionId);
    const orphaned = join(first.historyStore.imagesDir, "sess_gone");
    mkdirSync(owned, { recursive: true });
    mkdirSync(orphaned, { recursive: true });

    await managerFor(dir, new FakeTransport()).manager.loadCatalog();

    expect(existsSync(owned)).toBe(true);
    expect(existsSync(orphaned)).toBe(false);
  });
});
