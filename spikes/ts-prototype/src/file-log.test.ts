import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileLog } from "./file-log.js";
import { InMemoryLog } from "./membrane.js";
import { selfAndAncestorIds } from "./lineage.js";
import type { InstanceEnvelope, Log } from "./membrane.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function logPath(): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-log-"));
  return join(dir, "weir.jsonl");
}

const envelope = (id: string, causationIds: string[] = []): InstanceEnvelope => ({
  id,
  correlationId: "c1",
  node: "n",
  contractHash: "h",
  schemaHash: "s",
  timestamp: "2026-09-26T00:00:00.000Z",
  step: 1,
  causationIds,
});

/**
 * Run the same assertions against both implementations, so the durable one
 * cannot quietly diverge from the one every other test uses.
 */
function behavesLikeALog(name: string, make: () => Promise<Log>): void {
  describe(name, () => {
    it("returns instances oldest first, scoped to their correlation", async () => {
      const log = await make();
      log.append("A", "c1", { v: 1 }, envelope("e1"));
      log.append("A", "c2", { v: 2 }, envelope("e2"));
      log.append("A", "c1", { v: 3 }, envelope("e3"));

      expect(log.instances("A", "c1").map((i) => i.payload)).toEqual([{ v: 1 }, { v: 3 }]);
      expect(log.instances("A", "c2").map((i) => i.payload)).toEqual([{ v: 2 }]);
      expect(log.latest("A", "c1")).toEqual({ v: 3 });
      expect(log.instances("B", "c1")).toEqual([]);
    });

    it("mints unique ids, resolvable across every edge and correlation", async () => {
      const log = await make();
      const a = log.append("A", "c1", { v: 1 }, envelope("e1"));
      const b = log.append("B", "c2", { v: 2 }, envelope("e2"));

      expect(a).not.toBe(b);
      expect(log.instanceById(a)?.payload).toEqual({ v: 1 });
      expect(log.instanceById(b)?.payload).toEqual({ v: 2 });
      expect(log.instanceById("nope")).toBeUndefined();
    });

    it("numbers seq in append order across edges and correlations", async () => {
      const log = await make();
      const a = log.append("A", "c1", { v: 1 }, envelope("e1"));
      const b = log.append("B", "c2", { v: 2 }, envelope("e2"));

      expect(log.instanceById(b)!.seq).toBeGreaterThan(log.instanceById(a)!.seq);
    });
  });
}

behavesLikeALog("InMemoryLog", async () => new InMemoryLog());
behavesLikeALog("FileLog", async () => FileLog.open(await logPath()));

describe("FileLog — durability", () => {
  it("reloads every instance with the same id, seq, payload and envelope", async () => {
    const path = await logPath();
    const written = await FileLog.open(path);
    const first = written.append("A", "c1", { v: 1 }, envelope("e1"));
    const second = written.append("B", "c1", { v: 2 }, envelope("e2", [first]));

    const reloaded = await FileLog.open(path);

    expect(reloaded.instances("A", "c1")).toEqual(written.instances("A", "c1"));
    expect(reloaded.instanceById(second)).toEqual(written.instanceById(second));
    expect(reloaded.instanceById(second)!.envelope!.causationIds).toEqual([first]);
  });

  it("takes seq from the file rather than recounting, so a non-contiguous log survives", async () => {
    // The property that matters: `seq` is a logical clock, and joinRows
    // orders ancestors by it and takes the highest as "nearest". A reload
    // that recounted would change which ancestor a join picks — silently,
    // and only for runs that had been persisted.
    //
    // A log written by one writer with nothing evicted is always 0..n-1 in
    // file order, so recounting would produce identical numbers and this
    // test would pass either way (confirmed: it did, before being written
    // this way). What discriminates is a file whose seqs are *not*
    // contiguous, which is what eviction or compaction produces — so the
    // gaps here are the point, not incidental fixture noise.
    const path = await logPath();
    const lines = [
      { id: "i-root", seq: 5, correlationId: "c1", edge: "Run", payload: { r: 1 } },
      { id: "i-mid", seq: 9, correlationId: "c1", edge: "A", payload: { v: 1 }, envelope: envelope("e1", ["i-root"]) },
      { id: "i-leaf", seq: 14, correlationId: "c1", edge: "B", payload: { v: 2 }, envelope: envelope("e2", ["i-mid"]) },
    ];
    await writeFile(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");

    const reloaded = FileLog.open(path);

    expect(reloaded.instanceById("i-root")!.seq).toBe(5);
    expect(reloaded.instanceById("i-mid")!.seq).toBe(9);
    expect(reloaded.instanceById("i-leaf")!.seq).toBe(14);
    // And lineage still walks it: the nearest ancestor of the leaf is the
    // mid, because 9 > 5, which is only true if the stored seqs survived.
    expect([...selfAndAncestorIds(reloaded, "i-leaf")]).toEqual(["i-leaf", "i-mid", "i-root"]);
    // A subsequent append continues past the highest seq seen, rather than
    // colliding with one already in the file.
    const next = reloaded.append("A", "c1", { v: 3 }, envelope("e3"));
    expect(reloaded.instanceById(next)!.seq).toBeGreaterThan(14);
  });

  it("appends one line per instance, and keeps its own keys on each", async () => {
    const path = await logPath();
    const log = await FileLog.open(path);
    log.append("A", "c1", { v: 1 }, envelope("e1"));
    log.append("A", "c1", { v: 2 }, envelope("e2"));

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    expect(lines).toHaveLength(2);
    // edge and correlationId live on the line because the index is rebuilt
    // from the file and they are its keys.
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.edge).toBe("A");
    expect(parsed.correlationId).toBe("c1");
    expect(parsed.seq).toBe(0);
  });

  it("opens a path that does not exist yet, and two runs in one file stay separate", async () => {
    const path = await logPath();
    const log = await FileLog.open(path);
    log.append("A", "run-1", { v: 1 }, envelope("e1"));
    log.append("A", "run-2", { v: 2 }, envelope("e2"));

    const reloaded = await FileLog.open(path);

    expect(reloaded.instances("A", "run-1").map((i) => i.payload)).toEqual([{ v: 1 }]);
    expect(reloaded.instances("A", "run-2").map((i) => i.payload)).toEqual([{ v: 2 }]);
    // instanceById is global across correlations, and stays so after reload.
    const all = [...reloaded.instances("A", "run-1"), ...reloaded.instances("A", "run-2")];
    for (const i of all) expect(reloaded.instanceById(i.id)).toBeDefined();
  });
});
