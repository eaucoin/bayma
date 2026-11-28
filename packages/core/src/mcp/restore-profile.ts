// Measurement only: a CPU profile of the server from a save that ends the
// sandbox to the answer of the restore that follows, summed by function over
// what the restored server ran, said on stderr as one line.
import { Session } from "node:inspector";

let session: Session | undefined;
const marks = new Map<string, bigint>();

export function profileFromSave(): void {
  if (session) return;
  marks.clear();
  session = new Session();
  session.connect();
  session.post("Profiler.enable");
  session.post("Profiler.setSamplingInterval", { interval: 100 });
  session.post("Profiler.start");
}

export function markRestore(name: string): void {
  if (session) marks.set(name, process.hrtime.bigint());
}

interface Node {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number };
  children?: number[];
}

export function endRestoreProfile(): void {
  const s = session;
  // Not until a restore: the save's own answer ends nothing.
  if (!s || !marks.has("handler")) return;
  session = undefined;
  const stopAt = process.hrtime.bigint();
  s.post("Profiler.stop", (error, result) => {
    s.disconnect();
    if (error || !result) return;
    const profile = result.profile as unknown as {
      nodes: Node[];
      samples: number[];
      timeDeltas: number[];
      endTime: number;
    };
    const byId = new Map(profile.nodes.map((node) => [node.id, node]));
    const parent = new Map<number, number>();
    for (const node of profile.nodes)
      for (const child of node.children ?? []) parent.set(child, node.id);
    const times: number[] = [];
    let t = 0;
    for (const delta of profile.timeDeltas) times.push((t += delta));
    const offset = profile.endTime - times[times.length - 1]!;
    // The restored server's samples: those after the longest gap, the sandbox's.
    let gapAt = 0;
    for (let i = 1; i < times.length; i += 1)
      if (
        times[i]! - times[i - 1]! >
        times[gapAt]! - (times[gapAt - 1] ?? times[0]!)
      )
        gapAt = i;
    const zero = times[gapAt]! + offset;
    const at = (name: string) => {
      const mark = marks.get(name);
      return mark === undefined
        ? null
        : Math.round(
            (profile.endTime + Number(mark - stopAt) / 1000 - zero) / 100,
          ) / 10;
    };
    const names = ["request", "handler", "reconnected", "answered"];
    const edges = [0, ...names.map(at).map((v) => v ?? Infinity)];
    const label = (node: Node) =>
      `${node.callFrame.functionName || "(anonymous)"} ${node.callFrame.url.split("/").pop()}:${node.callFrame.lineNumber + 1}`;
    const windows = names.map(() => ({
      self: new Map<string, number>(),
      total: new Map<string, number>(),
      ms: 0,
    }));
    for (let i = gapAt; i < profile.samples.length; i += 1) {
      const ms = ((times[i + 1] ?? times[i]!) - times[i]!) / 1000;
      const when = (times[i]! + offset - zero) / 1000;
      const w = edges.findIndex((edge, k) => k > 0 && when < edge) - 1;
      if (w < 0) continue;
      const window = windows[w]!;
      window.ms += ms;
      let node = byId.get(profile.samples[i]!);
      window.self.set(label(node!), (window.self.get(label(node!)) ?? 0) + ms);
      const seen = new Set<string>();
      for (; node; node = byId.get(parent.get(node.id) ?? -1)) {
        const name = label(node);
        if (seen.has(name)) continue;
        seen.add(name);
        window.total.set(name, (window.total.get(name) ?? 0) + ms);
      }
    }
    const top = (map: Map<string, number>, n: number) =>
      [...map]
        .sort((a, b) => b[1] - a[1])
        .slice(0, n)
        .map(([name, ms]) => [name, Math.round(ms * 10) / 10]);
    process.stderr.write(
      `bayma-restore-profile ${JSON.stringify({
        marks: Object.fromEntries(names.map((name) => [name, at(name)])),
        windows: windows.map((window, k) => ({
          to: names[k],
          ms: Math.round(window.ms * 10) / 10,
          self: top(window.self, 25),
          total: top(window.total, 40),
        })),
      })}\n`,
    );
  });
}
