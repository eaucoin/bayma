import { expect, test } from "bun:test";
import {
  assertDoctorProcessResult,
  doctorSuccessOutput,
  runDoctor,
  SessionCatalogStore,
  CheckpointStore,
  ExecHistoryStore,
} from "@bayma/core";
import { bunAdapter } from "@bayma/runtime-bun";
import { withTempDir } from "../../support/temp.ts";

test("doctor cleans only the session it creates in a shared state directory", async () => {
  await withTempDir(async (dir) => {
    const sessionId = "sess_preexisting";
    const catalog = new SessionCatalogStore(dir);
    const history = new ExecHistoryStore(dir);
    const checkpoints = new CheckpointStore(dir);
    const checkpoint = checkpoints.writeCommit(sessionId, {
      runtimeId: "bun",
      codecId: "json-v1",
      codecVersion: 1,
      payloadKind: "json-inline",
      inlineJson: { answer: 41 },
    });
    history.write(sessionId, []);
    catalog.write({
      sessionId,
      runtimeId: "bun",
      title: "preexisting",
      cwd: dir,
      status: "suspended",
      durabilityMode: "checkpointed",
      checkpointRevision: checkpoint.revision,
      checkpointUpdatedAtMs: checkpoint.updatedAtMs,
      runtimeGeneration: 1,
      createdAtMs: checkpoint.updatedAtMs,
      updatedAtMs: checkpoint.updatedAtMs,
      closed: false,
      cols: 80,
      rows: 24,
    });

    await runDoctor([bunAdapter], { cwd: dir, stateDir: dir });

    expect(catalog.read(sessionId)?.status).toBe("suspended");
    expect(checkpoints.read(sessionId)?.inlineJson).toEqual({ answer: 41 });
    expect(history.read(sessionId)).toEqual([]);
    expect(catalog.list().entries.map((entry) => entry.sessionId)).toEqual([
      sessionId,
    ]);
  });
});

test("doctor process evidence is exact and runtime bound", () => {
  const success = {
    status: 0,
    stdout: doctorSuccessOutput(["python"]) + "\n",
    stderr: "",
  };
  const message = "doctor process did not emit its exact success record";
  expect(() => assertDoctorProcessResult(["python"], success)).not.toThrow();
  expect(() => assertDoctorProcessResult(["bun"], success)).toThrow(message);
  expect(() => assertDoctorProcessResult(["python", "bun"], success)).toThrow(
    message,
  );
  expect(() =>
    assertDoctorProcessResult(["python"], {
      ...success,
      stdout: success.stdout + "extra\n",
    }),
  ).toThrow(message);
  expect(() =>
    assertDoctorProcessResult(["python"], { ...success, stderr: "warning\n" }),
  ).toThrow(message);
  expect(() =>
    assertDoctorProcessResult(["python"], { ...success, status: 1 }),
  ).toThrow(message);
});

test("doctor cleanup failures retain their nested diagnostics", async () => {
  await withTempDir(async (dir) => {
    const adapter = {
      ...bunAdapter,
      createTransport: () => {
        const transport = bunAdapter.createTransport();
        const failingTerminate = async (
          ...args: Parameters<typeof transport.terminate>
        ) => {
          await transport.terminate(...args);
          throw new AggregateError(
            [new Error("simulated locked child handle")],
            "simulated transport cleanup failure",
          );
        };
        return new Proxy(transport, {
          get(target, property, receiver) {
            if (property === "terminate") return failingTerminate;
            const value = Reflect.get(target, property, receiver);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      },
    };

    try {
      await runDoctor([adapter], { cwd: dir });
      throw new Error("doctor unexpectedly passed");
    } catch (error) {
      expect(error).toBeInstanceOf(AggregateError);
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("doctor cleanup failed"),
      );
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("simulated transport cleanup failure"),
      );
      expect(error).toHaveProperty(
        "message",
        expect.stringContaining("simulated locked child handle"),
      );
    }
  });
});
