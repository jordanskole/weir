import { describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, allOf, single } from "./define.js";
import { InMemoryLog } from "./membrane.js";
import { runNetlist } from "./runtime.js";
import { ancestorsOf } from "./lineage.js";
import type { Program } from "./implementation.js";
import type { NodeDef } from "./types.js";

/**
 * Same `programWith` idiom `runtime.test.ts` uses: a Program is more than
 * `nodes`/`wiring`, but nothing in this file's fixtures needs `fields` or
 * `edges` populated — success-path firing hashes each node's own declared
 * output edge, never `program.edges` (see `runtime.ts`'s `instanceEnvelope`
 * call sites, which only reach `program.edges` on a failure path none of
 * these fixtures exercise).
 */
function programWith(nodes: Record<string, NodeDef>, wiring: Program["wiring"]): Program {
  return { fields: {}, edges: {}, nodes, wiring };
}

// A straight three-node chain: origin -> doubled -> tripled. Exercises the
// simple case, a linear ancestor chain with no fan-in.
const Value = defineEdge({
  name: "Value",
  label: "Value",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Doubled = defineEdge({
  name: "Doubled",
  label: "Doubled",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Tripled = defineEdge({
  name: "Tripled",
  label: "Tripled",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const chainOrigin = defineNode({
  name: "chainOrigin",
  input: single(Value),
  output: single(Value),
  fn: (v) => v,
});
const doubled = defineNode({
  name: "doubled",
  input: single(Value),
  output: single(Doubled),
  fn: (v) => ({ value: `${v.value}${v.value}` }),
});
const tripled = defineNode({
  name: "tripled",
  input: single(Doubled),
  output: single(Tripled),
  fn: (d) => ({ value: `${d.value}${d.value}${d.value}` }),
});
const chainProgram = programWith(
  { chainOrigin, doubled, tripled },
  { origins: ["chainOrigin"], feeds: { chainOrigin: ["doubled"], doubled: ["tripled"] } },
);

// A diamond: source feeds both left and right; join (allOf) consumes both.
// source is reachable from joined by two separate paths and must appear
// exactly once in joined's ancestors.
const Source = defineEdge({
  name: "Source",
  label: "Source",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Left = defineEdge({
  name: "Left",
  label: "Left",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Right = defineEdge({
  name: "Right",
  label: "Right",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Joined = defineEdge({
  name: "Joined",
  label: "Joined",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const diamondSource = defineNode({
  name: "diamondSource",
  input: single(Source),
  output: single(Source),
  fn: (s) => s,
});
const left = defineNode({
  name: "left",
  input: single(Source),
  output: single(Left),
  fn: (s) => ({ value: `left-${s.value}` }),
});
const right = defineNode({
  name: "right",
  input: single(Source),
  output: single(Right),
  fn: (s) => ({ value: `right-${s.value}` }),
});
const join = defineNode({
  name: "join",
  input: allOf(Left, Right),
  output: single(Joined),
  fn: ({ Left: l, Right: r }) => ({ value: `${l.value}+${r.value}` }),
});
const diamondProgram = programWith(
  { diamondSource, left, right, join },
  { origins: ["diamondSource"], feeds: { diamondSource: ["left", "right"], left: ["join"], right: ["join"] } },
);

// countToThree: the topology has a real cycle (countToThree wired back to
// itself), but each firing consumes a strictly earlier instance, so the
// *instance* graph is a DAG even though the *node* graph is not. Same
// fixture shape as runtime.test.ts's countToThreeProgram.
const Continue = defineEdge({
  name: "Continue",
  label: "Continue",
  description: "d",
  fields: { n: defineField({ type: "uint8", label: "n", description: "d", nullable: false }) },
});
const Done = defineEdge({
  name: "Done",
  label: "Done",
  description: "d",
  fields: { n: defineField({ type: "uint8", label: "n", description: "d", nullable: false }) },
});
const seed = defineNode({
  name: "seed",
  input: single(Continue),
  output: single(Continue),
  fn: (c) => c,
});
const countToThree = defineNode({
  name: "countToThree",
  input: single(Continue),
  output: { kind: "oneOf", edges: [Continue, Done] },
  fn: (c) =>
    c.n >= 3 ? { edge: "Done" as const, payload: c } : { edge: "Continue" as const, payload: { n: c.n + 1 } },
});
const countToThreeProgram = programWith(
  { seed, countToThree },
  { origins: ["seed"], feeds: { seed: ["countToThree"], countToThree: ["countToThree"] } },
);

describe("ancestorsOf", () => {
  it("returns an instance's transitive ancestors, oldest first", async () => {
    const log = new InMemoryLog();
    await runNetlist(chainProgram, { correlationId: "c1", originPayloads: { chainOrigin: { value: "a" } } }, { log, budget: 20 });
    const last = log.instances("Tripled", "c1")[0];

    expect(ancestorsOf(log, last.id).map((i) => i.payload)).toEqual([
      { value: "a" },
      { value: "aa" },
    ]);
  });

  it("returns a diamond's shared ancestor once, not twice", async () => {
    // left and right both descend from the same source; join consumes both.
    // A dedup keyed on the wrong thing returns the source twice.
    const log = new InMemoryLog();
    await runNetlist(diamondProgram, { correlationId: "c1", originPayloads: { diamondSource: { value: "a" } } }, { log, budget: 20 });
    const joined = log.instances("Joined", "c1")[0];

    const ids = ancestorsOf(log, joined.id).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Not just deduped but present: left, right, and the shared source —
    // three, not fewer. A dedup so aggressive it dropped a branch entirely
    // would still pass the Set-size check above without this.
    expect(ids.length).toBe(3);
  });

  it("terminates on a topology with a cycle, returning each ancestor once", async () => {
    const log = new InMemoryLog();
    await runNetlist(countToThreeProgram, { correlationId: "c1", originPayloads: { seed: { n: 0 } } }, { log, budget: 20 });
    const done = log.instances("Done", "c1")[0];

    const ids = ancestorsOf(log, done.id).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(1);
  });

  it("returns an empty array for an instance nothing caused", async () => {
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(ancestorsOf(log, id)).toEqual([]);
  });
});

describe("Log.instanceById", () => {
  it("finds an instance by the id append returned", () => {
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(log.instanceById(id)?.payload).toEqual({ value: "a" });
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(new InMemoryLog().instanceById("nope")).toBeUndefined();
  });
});
