/**
 * A root topology declares its end
 * (docs/superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md).
 *
 * `residue` made a *stalled* run loud. This is the other half: the run that
 * consumed everything tidily and never produced what it was for. It needs a
 * declaration, because nothing in a wiring says which of several unconsumed
 * edges was the point — and for a topology whose nodes are rhombus-shaped,
 * nothing says which *instance* of an edge was the end either.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elaborate } from "./elaborate.js";
import { InMemoryLog } from "./membrane.js";
import { runNetlist } from "./runtime.js";
import { defineEdge, defineField, defineNode, allOf, oneOf, single } from "./define.js";
import type { Program } from "./implementation.js";

const utf8 = (label: string) => defineField({ type: "utf8", label, description: "d", nullable: false });

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fixture(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-ends-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

const EDGE = (name: string) =>
  `label: ${name}\ndescription: d\nfields:\n  v:\n    type: utf8\n    label: V\n    description: d\n    nullable: false\n`;
const NODE = (input: string, output: string) =>
  `label: N\ndescription: d\ninput: ${input}\noutput: ${output}\nexamples:\n  - given:\n      ${input}:\n        v: "x"\n    expect:\n      ${output}:\n        v: "x"\n`;

describe("a root topology declares its end — at elaboration", () => {
  /**
   * Spec Testing #1. The whole point of required: a root that declares no end
   * is the only boundary in weir that declares nothing, and this deletes the
   * exception rather than defaulting to something and hoping.
   *
   * Break-proof: making `output`/`terminals` optional in
   * `parseRootTopologyFile` let this elaborate cleanly, reddening it.
   */
  it("rejects a root topology that declares no end, naming the file", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "nodes/go.node": NODE("A", "B"),
      // Exactly what every root topology in this repo looked like until now.
      "topology/main.topology": `go: {}\n`,
    });

    await expect(elaborate(root)).rejects.toThrow(/main\.topology.*declares only|unrecognized top-level key "go"/s);
  });

  /**
   * Spec Testing #2 — the static half, which is `assertCompositeContracts`
   * extended to roots rather than a second implementation.
   *
   * Break-proof: skipping the root pass of `assertTopologyContracts` let this
   * elaborate, and the mistake would then only have surfaced as a run that
   * could never succeed.
   */
  it("rejects a root whose terminals cannot produce its declared output", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "edges/C.edge": EDGE("C"),
      "nodes/go.node": NODE("A", "B"),
      "topology/main.topology": `output: C\nterminals:\n  - go\nwiring:\n  go: {}\n`,
    });

    await expect(elaborate(root)).rejects.toThrow(/declares output "C".*terminals \(go\) produce/s);
  });

  /** Spec Testing #3 — the same message a composite gets, from the same routine. */
  it("rejects a root naming a terminal that is not a declared node", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "nodes/go.node": NODE("A", "B"),
      "topology/main.topology": `output: B\nterminals:\n  - nosuchnode\nwiring:\n  go: {}\n`,
    });

    await expect(elaborate(root)).rejects.toThrow(/terminal "nosuchnode" is not a declared node/);
  });

  /**
   * Not in the spec's list — found building it. A root's terminal may name a
   * **composite**, which is the natural thing to write when a topology ends on
   * one, and after inlining that name no longer exists. `expandTerminals`
   * rewrites it to the qualified inner nodes.
   *
   * Break-proof: removing the composite branch of `expandTerminals` made this
   * fail with `terminal "pair" is not a declared node` — the error a user
   * would have hit for writing the obvious thing.
   */
  it("accepts a terminal that names a composite, expanding it to the inlined nodes", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/L.edge": EDGE("L"),
      "edges/R.edge": EDGE("R"),
      "nodes/start.node": NODE("A", "A"),
      "nodes/toLeft.node": NODE("A", "L"),
      "nodes/toRight.node": NODE("A", "R"),
      "topology/pair.topology": `input: A\noutput:\n  allOf:\n    - L\n    - R\nterminals:\n  - toLeft\n  - toRight\nwiring:\n  toLeft: {}\n  toRight: {}\n`,
      "topology/main.topology": `output:\n  allOf:\n    - L\n    - R\nterminals:\n  - pair\nwiring:\n  start:\n    then:\n      pair: {}\n`,
    });

    const elaborated = await elaborate(root);
    expect(elaborated.ends[0]!.terminals.sort()).toEqual(["pair/toLeft", "pair/toRight"]);
  });

  /**
   * Also found building it: a terminal naming an `anyOf` node, which desugars
   * into `<name>__<edge>` shadows the author never wrote.
   */
  it("expands a terminal that names an anyOf node into its shadows", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "edges/Out.edge": EDGE("Out"),
      "nodes/makeA.node": NODE("Out", "A"),
      "nodes/handle.node": `label: H\ndescription: d\ninput:\n  anyOf:\n    - A\n    - B\noutput: Out\nexamples:\n  - given:\n      A:\n        v: "x"\n    expect:\n      Out:\n        v: "x"\n`,
      "topology/main.topology": `output: Out\nterminals:\n  - handle\nwiring:\n  makeA:\n    then:\n      handle: {}\n`,
    });

    const elaborated = await elaborate(root);
    expect(elaborated.ends[0]!.terminals.sort()).toEqual(["handle__A", "handle__B"]);
  });

  /** Spec Testing #9 — the guard against a rule strict enough to reject its own corpus. */
  it("still accepts every example, all six having been migrated", async () => {
    for (const name of ["recipe", "escalation", "manuscript-review", "soc-triage", "todo-list", "person-birthday"]) {
      const src = fileURLToPath(new URL(`../../../examples/${name}/src`, import.meta.url));
      const elaborated = await elaborate(src);
      expect(elaborated.ends).toHaveLength(1);
      expect(elaborated.ends[0]!.terminals.length).toBeGreaterThan(0);
    }
  });
});

describe("a root topology declares its end — at the end of a run", () => {
  const A = defineEdge({ name: "A", label: "A", description: "d", fields: { v: utf8("V") } });
  const B = defineEdge({ name: "B", label: "B", description: "d", fields: { v: utf8("V") } });
  const run = async (program: Program, originPayloads: Record<string, unknown>) => {
    const log = new InMemoryLog();
    const result = await runNetlist(program, { correlationId: "t", originPayloads }, { log, maxPulses: 10 });
    return { log, result };
  };

  /**
   * **Spec Testing #4, and the reason the spec exists.** `examples/todo-list`
   * has two nodes producing `TodoList`, so "an instance of the declared output
   * exists" is satisfied by an *intermediate* one emitted long before the run
   * finished. The end is met only by an instance whose `envelope.node` is a
   * declared terminal.
   *
   * Break-proof, and this is the one that matters: dropping the
   * `terminals.has(envelope.node)` clause — checking only that an instance of
   * the edge exists — made this **pass**, which is precisely the false green
   * the whole design is arranged to avoid. If this test ever goes green with
   * that clause removed, the check is decorative.
   */
  it("is not satisfied by an intermediate instance of the declared output edge", async () => {
    // `startList` and `finish` both produce B. Only `finish` is a terminal, and
    // only `startList` ever fires.
    const startList = defineNode({
      name: "startList",
      input: single(A),
      output: single(B),
      fn: (a) => ({ v: a.v }),
    });
    const finish = defineNode({
      name: "finish",
      input: single(B),
      output: single(B),
      fn: (b) => ({ v: `${b.v}!` }),
    });
    const program: Program = {
      fields: {},
      edges: { A, B },
      nodes: { startList },
      wiring: { origins: ["startList"], feeds: {} },
      ends: [{ name: "main", output: { kind: "single", edge: B }, terminals: ["finish"] }],
    };

    const { log, result } = await run(program, { startList: { v: "x" } });

    // A `B` genuinely exists — which is exactly why the naive check passes.
    expect(log.instances("B", "t")).toHaveLength(1);
    expect(log.instances("B", "t")[0]!.envelope?.node).toBe("startList");
    // And the end is still unmet, because no *terminal* produced it.
    expect(result.unmet).toEqual([{ topology: "main", missing: ["B"], terminals: ["finish"] }]);
    void finish;
  });

  it("is satisfied when a declared terminal produces the declared output", async () => {
    const go = defineNode({ name: "go", input: single(A), output: single(B), fn: (a) => ({ v: a.v }) });
    const program: Program = {
      fields: {},
      edges: { A, B },
      nodes: { go },
      wiring: { origins: ["go"], feeds: {} },
      ends: [{ name: "main", output: { kind: "single", edge: B }, terminals: ["go"] }],
    };

    const { result } = await run(program, { go: { v: "x" } });

    expect(result.unmet).toEqual([]);
    expect(result.residue).toEqual([]);
  });

  /**
   * Spec Testing #5. Under `oneOf` exactly one branch fires by construction,
   * so "every declared terminal fired" is the wrong rule — it would reject
   * `examples/person-birthday` on its very first run.
   *
   * Break-proof: requiring *all* declared output edges regardless of mode made
   * this redden with `missing: ["Fail"]`.
   */
  it("a oneOf end is met by one branch, and an unfired terminal is not an error", async () => {
    const Pass = defineEdge({ name: "Pass", label: "P", description: "d", fields: { v: utf8("V") } });
    const Fail = defineEdge({ name: "Fail", label: "F", description: "d", fields: { v: utf8("V") } });
    const decide = defineNode({
      name: "decide",
      input: single(A),
      output: oneOf(Pass, Fail),
      fn: (a) => ({ edge: "Pass", payload: { v: a.v } }),
    });
    const program: Program = {
      fields: {},
      edges: { A, Pass, Fail },
      nodes: { decide },
      wiring: { origins: ["decide"], feeds: {} },
      ends: [{ name: "main", output: { kind: "oneOf", edges: [Pass, Fail] }, terminals: ["decide"] }],
    };

    const { log, result } = await run(program, { decide: { v: "x" } });

    expect(log.instances("Fail", "t")).toHaveLength(0);
    expect(result.unmet).toEqual([]);
  });

  it("a oneOf end is unmet only when no branch appeared", async () => {
    const Pass = defineEdge({ name: "Pass", label: "P", description: "d", fields: { v: utf8("V") } });
    const Fail = defineEdge({ name: "Fail", label: "F", description: "d", fields: { v: utf8("V") } });
    const stall = defineNode({ name: "stall", input: single(A), output: single(B), fn: (a) => ({ v: a.v }) });
    const program: Program = {
      fields: {},
      edges: { A, B, Pass, Fail },
      nodes: { stall },
      wiring: { origins: ["stall"], feeds: {} },
      ends: [{ name: "main", output: { kind: "oneOf", edges: [Pass, Fail] }, terminals: ["stall"] }],
    };

    const { result } = await run(program, { stall: { v: "x" } });

    expect(result.unmet).toEqual([{ topology: "main", missing: ["Pass", "Fail"], terminals: ["stall"] }]);
  });

  /**
   * Spec Testing #6. `allOf` needs every declared edge, which is what
   * `examples/todo-list` and `examples/manuscript-review` both declare.
   *
   * Break-proof: treating every mode like `oneOf` (satisfied by any one edge)
   * made this report no unmet end at all.
   */
  it("an allOf end needs every declared edge", async () => {
    const C = defineEdge({ name: "C", label: "C", description: "d", fields: { v: utf8("V") } });
    const half = defineNode({ name: "half", input: single(A), output: single(B), fn: (a) => ({ v: a.v }) });
    const program: Program = {
      fields: {},
      edges: { A, B, C },
      nodes: { half },
      wiring: { origins: ["half"], feeds: {} },
      ends: [{ name: "main", output: { kind: "allOf", edges: [B, C] }, terminals: ["half"] }],
    };

    const { result } = await run(program, { half: { v: "x" } });

    expect(result.unmet).toEqual([{ topology: "main", missing: ["C"], terminals: ["half"] }]);
  });

  /**
   * Spec Testing #8. The two checks answer different questions and must not
   * stand in for one another: this run **reaches its end** and still strands a
   * side branch, which residue reports and the end check correctly does not.
   */
  it("reports residue and a met end independently", async () => {
    const C = defineEdge({ name: "C", label: "C", description: "d", fields: { v: utf8("V") } });
    const Joined = defineEdge({ name: "Joined", label: "J", description: "d", fields: { v: utf8("V") } });
    const go = defineNode({ name: "go", input: single(A), output: single(B), fn: (a) => ({ v: a.v }) });
    // Declares allOf[B, C] but only B ever arrives, so it never fires and B is
    // left waiting — while `go`'s B already satisfied the declared end.
    const join = defineNode({
      name: "join",
      input: allOf(B, C),
      output: single(Joined),
      fn: (bag) => ({ v: bag.B.v }),
    });
    const program: Program = {
      fields: {},
      edges: { A, B, C, Joined },
      nodes: { go, join },
      wiring: { origins: ["go"], feeds: { go: ["join"] } },
      ends: [{ name: "main", output: { kind: "single", edge: B }, terminals: ["go"] }],
    };

    const { result } = await run(program, { go: { v: "x" } });

    expect(result.unmet).toEqual([]);
    expect(result.residue).toEqual([{ node: "join", edge: "B", waiting: 1 }]);
  });

  /** A hand-built `Program` that declares no `ends` is not checked — the shape every readiness fixture uses. */
  it("checks nothing when a program declares no ends", async () => {
    const go = defineNode({ name: "go", input: single(A), output: single(B), fn: (a) => ({ v: a.v }) });
    const program: Program = {
      fields: {},
      edges: { A, B },
      nodes: { go },
      wiring: { origins: ["go"], feeds: {} },
    };

    const { result } = await run(program, { go: { v: "x" } });

    expect(result.unmet).toEqual([]);
  });
});
