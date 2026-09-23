import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, MAX_CHECKPOINT_PAYLOAD_BYTES } from "@bayma/core";

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "bayma-checkpoint-store-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("checkpoint manifest store commits and reads inline JSON", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const checkpoint = store.writeCommit("sess_inline", {
      runtimeId: "bun",
      codecId: "json-v1",
      codecVersion: 1,
      payloadKind: "json-inline",
      inlineJson: { answer: 41 },
      compatibility: { runtimeVersion: "test" },
    });

    expect(checkpoint.codecId).toBe("json-v1");
    expect(checkpoint.schemaVersion).toBe(1);
    expect(checkpoint.payloadKind).toBe("json-inline");
    expect(checkpoint.value).toEqual({ answer: 41 });

    const snapshot = store.snapshot("sess_inline");
    expect(snapshot?.manifest.inlineJson).toEqual({ answer: 41 });
    expect(snapshot?.payloadAbsolutePath).toBeUndefined();
  });
});

test("inline checkpoints reject values that JSON would silently change", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const invalidValues: unknown[] = [
      { value: Number.NaN },
      { value: Number.POSITIVE_INFINITY },
      { value: -0 },
      new Date("2026-01-01T00:00:00.000Z"),
      Object.assign([1, 2], { extra: true }),
      [, 1],
    ];

    for (const [index, inlineJson] of invalidValues.entries()) {
      const sessionId = `sess_invalid_json_${index}`;
      expect(() =>
        store.writeCommit(sessionId, {
          runtimeId: "dotnet-script",
          codecId: "json-v1",
          codecVersion: 1,
          payloadKind: "json-inline",
          inlineJson,
        }),
      ).toThrow();
      expect(store.read(sessionId)).toBeNull();
    }
  });
});

test("checkpoint manifest store commits binary sidecars and rejects corruption", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const sourcePayload = join(dir, "payload-source.bin");
    writeFileSync(sourcePayload, Buffer.from("checkpoint-bytes"));

    const checkpoint = store.writeCommit("sess_binary", {
      runtimeId: "bun",
      codecId: "bun-jsc-structured-clone-v1",
      codecVersion: 1,
      payloadKind: "binary-sidecar",
      payloadPath: sourcePayload,
      compatibility: { runtimeVersion: "test" },
    });

    expect(checkpoint.payloadKind).toBe("binary-sidecar");
    const snapshot = store.snapshot("sess_binary");
    expect(snapshot?.payloadAbsolutePath).toBeString();

    writeFileSync(snapshot!.payloadAbsolutePath!, Buffer.from("corrupt"));
    expect(store.read("sess_binary")).toBeNull();
    expect(store.inspect("sess_binary").failure).toContain(
      "checkpoint sidecar checksum mismatch",
    );
    expect(() => store.snapshot("sess_binary")).toThrow(
      "checkpoint sidecar checksum mismatch",
    );
  });
});

test("checkpoint sidecars reject oversized sparse files without persisting them", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const sourcePayload = join(dir, "oversized-sparse.bin");
    writeFileSync(sourcePayload, "");
    truncateSync(sourcePayload, MAX_CHECKPOINT_PAYLOAD_BYTES + 1);

    expect(() =>
      store.writeCommit("sess_oversized", {
        runtimeId: "python",
        codecId: "python-pickle-protocol5-v1",
        codecVersion: 1,
        payloadKind: "binary-sidecar",
        payloadPath: sourcePayload,
      }),
    ).toThrow(
      `checkpoint payload exceeds ${MAX_CHECKPOINT_PAYLOAD_BYTES} bytes`,
    );
    expect(store.read("sess_oversized")).toBeNull();
    expect(
      readdirSync(store.checkpointDirectory("sess_oversized")),
    ).toHaveLength(0);
  });
});

test("checkpoint manifest store rejects sidecar path traversal", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const sourcePayload = join(dir, "payload-source.bin");
    writeFileSync(sourcePayload, Buffer.from("checkpoint-bytes"));
    store.writeCommit("sess_traversal", {
      runtimeId: "bun",
      codecId: "bun-jsc-structured-clone-v1",
      codecVersion: 1,
      payloadKind: "binary-sidecar",
      payloadPath: sourcePayload,
    });

    const manifestPath = store.manifestPath("sess_traversal");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      payloadPath: string;
    };
    manifest.payloadPath = "../payload-source.bin";
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    expect(store.read("sess_traversal")).toBeNull();
    expect(store.inspect("sess_traversal").failure).toContain(
      "payload path must be a filename",
    );
  });
});

test("unversioned checkpoint manifests remain readable as v0", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    store.writeCommit("sess_v0", {
      runtimeId: "bun",
      codecId: "json-v1",
      codecVersion: 1,
      payloadKind: "json-inline",
      inlineJson: { answer: 41 },
    });
    const manifestPath = store.manifestPath("sess_v0");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete manifest.schemaVersion;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    expect(store.read("sess_v0")?.schemaVersion).toBe(1);
    expect(store.read("sess_v0")?.value).toEqual({ answer: 41 });
  });
});

test("sidecar replacement commits before retiring the previous payload", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const firstSource = join(dir, "first.bin");
    const secondSource = join(dir, "second.bin");
    writeFileSync(firstSource, Buffer.from("first"));
    writeFileSync(secondSource, Buffer.from("second"));

    store.writeCommit("sess_replace", {
      runtimeId: "bun",
      codecId: "bun-jsc-structured-clone-v1",
      codecVersion: 1,
      payloadKind: "binary-sidecar",
      payloadPath: firstSource,
    });
    const first = store.snapshot("sess_replace")!;
    const firstPayloadPath = first.payloadAbsolutePath!;

    expect(() =>
      store.write(
        "sess_replace",
        {
          ...first.manifest,
          revision: "",
          payloadPath: secondSource,
        },
        secondSource,
      ),
    ).toThrow("checkpoint manifest shape is invalid");
    expect(() =>
      store.write(
        "sess_replace",
        {
          ...first.manifest,
          revision: "ckpt/ambiguous",
          payloadPath: secondSource,
        },
        secondSource,
      ),
    ).toThrow("checkpoint manifest shape is invalid");
    expect(store.snapshot("sess_replace")?.manifest.revision).toBe(
      first.manifest.revision,
    );
    expect(readFileSync(firstPayloadPath, "utf8")).toBe("first");

    store.writeCommit("sess_replace", {
      runtimeId: "bun",
      codecId: "bun-jsc-structured-clone-v1",
      codecVersion: 1,
      payloadKind: "binary-sidecar",
      payloadPath: secondSource,
    });
    expect(existsSync(firstPayloadPath)).toBe(false);
    expect(
      readdirSync(store.checkpointDirectory("sess_replace")).filter((name) =>
        name.startsWith("payload-"),
      ),
    ).toHaveLength(1);
  });
});

test("post-commit garbage collection cannot negate an authoritative checkpoint", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const sessionId = "sess_cleanup_failure";
    store.writeCommit(sessionId, {
      runtimeId: "bun",
      codecId: "json-v1",
      codecVersion: 1,
      payloadKind: "json-inline",
      inlineJson: { answer: 41 },
    });

    const undeletableAsFile = store.checkpointPath(sessionId);
    mkdirSync(undeletableAsFile);
    writeFileSync(join(undeletableAsFile, "sentinel"), "still here\n", "utf8");

    const committed = store.writeCommit(sessionId, {
      runtimeId: "bun",
      codecId: "json-v1",
      codecVersion: 1,
      payloadKind: "json-inline",
      inlineJson: { answer: 42 },
    });

    expect(committed.inlineJson).toEqual({ answer: 42 });
    expect(store.snapshot(sessionId)?.manifest.revision).toBe(
      committed.revision,
    );
    expect(readFileSync(join(undeletableAsFile, "sentinel"), "utf8")).toBe(
      "still here\n",
    );
  });
});

test("checkpoint manifest store reads legacy JSON checkpoints", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    writeFileSync(
      store.checkpointPath("sess_legacy"),
      JSON.stringify({
        revision: "ckpt_legacy",
        updatedAtMs: 123,
        value: { answer: 41 },
      }),
    );

    const checkpoint = store.read("sess_legacy");
    expect(checkpoint?.codecId).toBe("json-v1");
    expect(checkpoint?.payloadKind).toBe("json-inline");
    expect(checkpoint?.value).toEqual({ answer: 41 });
  });
});

test("legacy checkpoint compatibility accepts only its exact v0 shape", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const legacyPath = store.checkpointPath("sess_invalid_legacy");
    writeFileSync(
      legacyPath,
      JSON.stringify({ revision: "ckpt_legacy", updatedAtMs: 1 }),
      "utf8",
    );
    expect(store.inspect("sess_invalid_legacy")).toEqual(
      expect.objectContaining({
        checkpoint: null,
        failure: expect.stringContaining("legacy checkpoint shape is invalid"),
      }),
    );

    writeFileSync(
      legacyPath,
      JSON.stringify({
        revision: "ckpt_legacy",
        updatedAtMs: 1,
        value: null,
        ignored: true,
      }),
      "utf8",
    );
    expect(store.inspect("sess_invalid_legacy")).toEqual(
      expect.objectContaining({
        checkpoint: null,
        failure: expect.stringContaining("legacy checkpoint shape is invalid"),
      }),
    );
  });
});

test("a corrupt current manifest never falls back to stale legacy state", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const sessionId = "sess_corrupt_current";
    store.writeCommit(sessionId, {
      runtimeId: "bun",
      codecId: "json-v1",
      codecVersion: 1,
      payloadKind: "json-inline",
      inlineJson: { answer: 42 },
    });
    writeFileSync(
      store.checkpointPath(sessionId),
      JSON.stringify({
        revision: "ckpt_stale",
        updatedAtMs: 1,
        value: { answer: 1 },
      }),
    );
    writeFileSync(store.manifestPath(sessionId), "{broken", "utf8");

    expect(store.read(sessionId)).toBeNull();
    expect(store.inspect(sessionId).failure).toContain(
      "checkpoint is unreadable",
    );
  });
});

test("checkpoint manifest store replaces legacy JSON on the next commit", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const legacyPath = store.checkpointPath("sess_upgrade");
    writeFileSync(
      legacyPath,
      JSON.stringify({
        revision: "ckpt_legacy",
        updatedAtMs: 123,
        value: { answer: 41 },
      }),
    );

    expect(store.read("sess_upgrade")?.value).toEqual({ answer: 41 });

    const checkpoint = store.writeCommit("sess_upgrade", {
      runtimeId: "bun",
      codecId: "json-v1",
      codecVersion: 1,
      payloadKind: "json-inline",
      inlineJson: { answer: 42 },
    });

    expect(checkpoint.value).toEqual({ answer: 42 });
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(store.manifestPath("sess_upgrade"))).toBe(true);
  });
});

test("checkpoint commits preserve monotonic time and refuse corrupt predecessors", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const sessionId = "sess_monotonic";
    store.writeCommit(sessionId, {
      runtimeId: "dotnet-script",
      codecId: "dotnet-system-text-json-v2",
      codecVersion: 2,
      payloadKind: "json-inline",
      inlineJson: null,
    });

    const manifestPath = store.manifestPath(sessionId);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const futureUpdatedAtMs = Date.now() + 1_000_000;
    manifest.updatedAtMs = futureUpdatedAtMs;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    const next = store.writeCommit(sessionId, {
      runtimeId: "dotnet-script",
      codecId: "dotnet-system-text-json-v2",
      codecVersion: 2,
      payloadKind: "json-inline",
      inlineJson: { answer: 42 },
    });
    expect(next.updatedAtMs).toBe(futureUpdatedAtMs);

    writeFileSync(manifestPath, "{broken", "utf8");
    expect(() =>
      store.writeCommit(sessionId, {
        runtimeId: "dotnet-script",
        codecId: "dotnet-system-text-json-v2",
        codecVersion: 2,
        payloadKind: "json-inline",
        inlineJson: { answer: 43 },
      }),
    ).toThrow("checkpoint is unreadable");
    expect(readFileSync(manifestPath, "utf8")).toBe("{broken");
  });
});

test("current inline manifests must contain their JSON payload field", () => {
  withTempDir((dir) => {
    const store = new CheckpointStore(dir);
    const sessionId = "sess_missing_inline_payload";
    store.writeCommit(sessionId, {
      runtimeId: "dotnet-script",
      codecId: "dotnet-system-text-json-v2",
      codecVersion: 2,
      payloadKind: "json-inline",
      inlineJson: null,
    });
    const manifestPath = store.manifestPath(sessionId);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    delete manifest.inlineJson;
    writeFileSync(manifestPath, JSON.stringify(manifest), "utf8");

    expect(store.inspect(sessionId).failure).toContain(
      "inline checkpoint JSON payload is missing",
    );
  });
});
