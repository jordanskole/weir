import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { elaborate } from "./elaborate.js";
import { elaborateWithImplementations } from "./implementation.js";
import { hashNode } from "./hash.js";
import { InMemoryLog } from "./membrane.js";
import { InMemoryTrace } from "./trace.js";
import { runNetlist } from "./runtime.js";
import { replayInvocation } from "./replay.js";
import { verifyRun } from "./verify.js";

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

const EDGES = {
  "edges/Ask.edge": `description: A request for the time\nfields:\n  label:\n    type: utf8\n    label: L\n    description: d\n    nullable: false\n`,
  "edges/Stamp.edge": `description: A recorded instant\nfields:\n  label:\n    type: utf8\n    label: L\n    description: d\n    nullable: false\n  at:\n    type: utf8\n    label: A\n    description: d\n    nullable: false\n`,
  "edges/Note.edge": `description: Something written about a stamp\nfields:\n  text:\n    type: utf8\n    label: T\n    description: d\n    nullable: false\n`,
};

/**
 * `ask` is an origin producing a request; `clock` is the effect that answers
 * it; `note` consumes the answer and is an ordinary, pure node. That last
 * one is the point of the whole design: a node downstream of an effect is
 * deterministic and verifies as such.
 */
const PROGRAM = {
  ...EDGES,
  "nodes/ask.node": `label: Ask\ndescription: d\ninput: Ask\noutput: Ask\n`,
  "nodes/clock.node": `label: Clock\ndescription: Reads the wall clock\neffect: clock\ninput: Ask\noutput: Stamp\n`,
  "nodes/note.node": `label: Note\ndescription: d\ninput: Stamp\noutput: Note\n`,
  "topology/main.topology": `ask:\n  then:\n    clock:\n      then:\n        note: {}\n`,
};

async function fixture(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-effects-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

/** Writes implementations for the non-effect nodes only — an effect node must need none. */
async function withImpls(root: string): Promise<string> {
  const implRoot = join(root, "impl");
  const raw = await elaborate(root);
  for (const [name, fn] of [
    ["ask", `export default function ask(a) { return a; }`],
    ["note", `export default function note(s) { return { text: s.label + " at " + s.at }; }`],
  ] as const) {
    const hash = (await hashNode(raw.nodes[name]!)).short;
    await mkdir(join(implRoot, name), { recursive: true });
    await writeFile(join(implRoot, name, `${hash}.ts`), `${fn}\n`, "utf8");
  }
  return implRoot;
}

describe("effects", () => {
  it("elaborates an effect node and never looks for an implementation file", async () => {
    const root = await fixture(PROGRAM);
    const implRoot = await withImpls(root);

    const raw = await elaborate(root);
    expect(raw.nodes.clock!.effect).toBe("clock");

    // No impl/clock directory exists, and resolution must not want one.
    const program = await elaborateWithImplementations(root, implRoot);
    expect(program.nodes.clock!.effect).toBe("clock");
  });

  it("refuses to start when a declared effect has no handler, before anything is written", async () => {
    const root = await fixture(PROGRAM);
    const program = await elaborateWithImplementations(root, await withImpls(root));
    const log = new InMemoryLog();

    await expect(
      runNetlist(program, { correlationId: "c1", originPayloads: { ask: { label: "x" } } }, { log, effects: {} }),
    ).rejects.toThrow(/clock/);

    // Nothing ran: a half-written log is worse than a refused start.
    expect(log.instances("Ask", "c1")).toEqual([]);
  });

  it("performs the effect, logs its result as an edge instance, and feeds a downstream node", async () => {
    const root = await fixture(PROGRAM);
    const program = await elaborateWithImplementations(root, await withImpls(root));
    const log = new InMemoryLog();
    const clock = vi.fn(async (ask: { label: string }) => ({ label: ask.label, at: "2026-09-27T00:00:00.000Z" }));

    const result = await runNetlist(
      program,
      { correlationId: "c1", originPayloads: { ask: { label: "boot" } } },
      { log, effects: { clock } },
    );

    expect(clock).toHaveBeenCalledTimes(1);
    expect(result.firings).toBe(3);
    expect(log.latest("Stamp", "c1")).toEqual({ label: "boot", at: "2026-09-27T00:00:00.000Z" });
    expect(log.latest("Note", "c1")).toEqual({ text: "boot at 2026-09-27T00:00:00.000Z" });
  });

  it("threads lineage through the effect — its result cites the request", async () => {
    const root = await fixture(PROGRAM);
    const program = await elaborateWithImplementations(root, await withImpls(root));
    const log = new InMemoryLog();

    await runNetlist(
      program,
      { correlationId: "c1", originPayloads: { ask: { label: "boot" } } },
      { log, effects: { clock: async (a: { label: string }) => ({ label: a.label, at: "t" }) } },
    );

    const request = log.instances("Ask", "c1")[0]!;
    const stamp = log.instances("Stamp", "c1")[0]!;
    expect(stamp.envelope?.causationIds).toEqual([request.id]);
    expect(stamp.envelope?.node).toBe("clock");
  });

  it("turns a handler's malformed result into Failed<In>, not a bad instance in the log", async () => {
    const root = await fixture(PROGRAM);
    const program = await elaborateWithImplementations(root, await withImpls(root));
    const log = new InMemoryLog();

    await runNetlist(
      program,
      { correlationId: "c1", originPayloads: { ask: { label: "boot" } } },
      { log, effects: { clock: async () => ({ nonsense: true }) } },
    );

    expect(log.instances("Stamp", "c1")).toEqual([]);
    expect(log.latest("Failed_Ask", "c1")).toBeDefined();
  });

  it("replays an effect from its record and does not call the handler again", async () => {
    // The property the feature exists for. Asserting the handler was not
    // invoked, rather than only that the value matched: a handler returning
    // the same thing twice would pass the weaker check.
    const root = await fixture(PROGRAM);
    const program = await elaborateWithImplementations(root, await withImpls(root));
    const log = new InMemoryLog();
    const trace = new InMemoryTrace();
    const clock = vi.fn(async (a: { label: string }) => ({ label: a.label, at: "recorded" }));

    await runNetlist(
      program,
      { correlationId: "c1", originPayloads: { ask: { label: "boot" } } },
      { log, trace, effects: { clock } },
    );
    clock.mockClear();

    const entry = trace.entries("c1").find((e) => e.envelope.node === "clock")!;
    const replayed = await replayInvocation(entry, program.nodes.clock!, join(root, "impl"));

    expect(replayed).toEqual({ label: "boot", at: "recorded" });
    expect(clock).not.toHaveBeenCalled();
  });

  it("verify reports the effect as declared-nondeterministic and the node below it as checked", async () => {
    const root = await fixture(PROGRAM);
    const program = await elaborateWithImplementations(root, await withImpls(root));
    const log = new InMemoryLog();
    const trace = new InMemoryTrace();

    await runNetlist(
      program,
      { correlationId: "c1", originPayloads: { ask: { label: "boot" } } },
      { log, trace, effects: { clock: async (a: { label: string }) => ({ label: a.label, at: "t" }) } },
    );

    const report = await verifyRun(trace.entries("c1"), program.nodes, join(root, "impl"));

    // Comparing an effect's replay to its record is vacuous by construction,
    // so it is never counted as a passing check.
    expect(report.declaredNondeterministic.map((d) => d.node)).toEqual(["clock"]);
    expect(report.checked).toBe(2);
    expect(report.mismatches).toEqual([]);
  });

  it("reports zero checked for a run of only effect nodes, rather than a clean pass", async () => {
    const root = await fixture({
      ...EDGES,
      "nodes/clock.node": `label: Clock\ndescription: d\neffect: clock\ninput: Ask\noutput: Stamp\n`,
      "topology/main.topology": `clock: {}\n`,
    });
    const program = await elaborateWithImplementations(root, join(root, "impl"));
    const log = new InMemoryLog();
    const trace = new InMemoryTrace();

    await runNetlist(
      program,
      { correlationId: "c1", originPayloads: { clock: { label: "boot" } } },
      { log, trace, effects: { clock: async (a: { label: string }) => ({ label: a.label, at: "t" }) } },
    );

    const report = await verifyRun(trace.entries("c1"), program.nodes, join(root, "impl"));

    expect(report.checked).toBe(0);
    expect(report.declaredNondeterministic).toHaveLength(1);
  });
});
