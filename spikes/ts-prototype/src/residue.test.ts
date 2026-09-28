/**
 * Residue: quiescence is not success
 * (docs/superpowers/specs/2026-09-27-quiescence-is-not-success.md).
 *
 * A run that stalls and a run that finishes used to report the same thing —
 * `stopped: "quiescence"`, an always-empty `failures`, and `weir run` printing
 * a checkmark. The gap was never in the runtime's *rule* so much as in the
 * definition it was measured against: the readme says quiescence means "no node
 * has unconsumed input left", and the loop stops when nothing *fired*, which is
 * strictly weaker.
 *
 * Half these tests exist to prove the check fires, and half to prove it stays
 * quiet — a safeguard that cries wolf on every healthy run gets switched off,
 * which would be a worse outcome than not having it.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, allOf, gather, many, oneOf, single } from "./define.js";
import { InMemoryLog } from "./membrane.js";
import { runNetlist } from "./runtime.js";
import type { Program } from "./implementation.js";

/**
 * A root `.topology`: its contract plus its wiring, the shape required since
 * docs/superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md.
 * `output`/`terminals` say what finishing looks like; the wiring is indented
 * under `wiring:` exactly as a composite's is.
 */
const rootTopology = (output: string, terminals: string[], wiring: string): string =>
  `${output.includes("\n") ? `output:\n${output}` : `output: ${output}\n`}terminals:\n` +
  terminals.map((t) => `  - ${t}\n`).join("") +
  "wiring:\n" +
  wiring
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join("\n");


const utf8 = (label: string) => defineField({ type: "utf8", label, description: "d", nullable: false });

const Seed = defineEdge({ name: "Seed", label: "Seed", description: "d", fields: { v: utf8("V") } });
const Item = defineEdge({
  name: "Item",
  label: "Item",
  description: "d",
  index: "id",
  fields: { id: utf8("ID") },
});
const Looked = defineEdge({
  name: "Looked",
  label: "Looked",
  description: "d",
  index: "itemId",
  fields: { itemId: utf8("I") },
});
/** The dead end. A legitimate "not applicable" branch that no node consumes. */
const Skipped = defineEdge({
  name: "Skipped",
  label: "Skipped",
  description: "d",
  index: "itemId",
  fields: { itemId: utf8("I") },
});
const Summary = defineEdge({
  name: "Summary",
  label: "Summary",
  description: "d",
  fields: { n: defineField({ type: "uint8", label: "N", description: "d", nullable: false }) },
});

const explode = defineNode({
  name: "explode",
  input: single(Seed),
  output: many(Item),
  fn: () => ({ a: { id: "a" }, b: { id: "b" } }),
});

/** Item "a" is looked at; item "b" is skipped. Neither is a failure. */
const lookOrSkip = defineNode({
  name: "lookOrSkip",
  input: single(Item),
  output: oneOf(Looked, Skipped),
  fn: (i) =>
    i.id === "a"
      ? { edge: "Looked", payload: { itemId: i.id } }
      : { edge: "Skipped", payload: { itemId: i.id } },
});

const summarize = defineNode({
  name: "summarize",
  input: gather(Looked),
  output: single(Summary),
  fn: (c) => ({ n: Object.keys(c).length }),
});

const run = async (program: Program, originPayloads: Record<string, unknown>, opts = {}) => {
  const log = new InMemoryLog();
  const result = await runNetlist(program, { correlationId: "t", originPayloads }, { log, maxPulses: 10, ...opts });
  return { log, result };
};

describe("residue — the check fires", () => {
  /**
   * Spec Testing #1, and the program the whole spec exists for. `gather`'s §4
   * closed the case where an element *fails*; this is the case where an
   * element's subgraph simply **ends**, which leaves no failure to find, so the
   * barrier's count is never reached and no group ever dies.
   *
   * Break-proof: with `residueNow` returning `[]`, this reports exactly what it
   * reported before the check existed — `quiescence`, no `Summary`, and nothing
   * anywhere saying so — and reddens on the residue assertion only. Which is
   * the point: every other observable is identical between a healthy run and
   * this one.
   */
  it("reports a gather whose element ended on an unrouted branch", async () => {
    const program: Program = {
      fields: {},
      edges: { Seed, Item, Looked, Skipped, Summary },
      nodes: { explode, lookOrSkip, summarize },
      wiring: { origins: ["explode"], feeds: { explode: ["lookOrSkip"], lookOrSkip: ["summarize"] } },
    };

    const { log, result } = await run(program, { explode: { v: "x" } });

    // Everything that was already observable, unchanged — so the assertion
    // below is carrying the whole weight.
    expect(result.stopped).toBe("quiescence");
    expect(log.instances("Summary", "t")).toHaveLength(0);

    expect(result.residue).toEqual([{ node: "summarize", edge: "Looked", waiting: 1 }]);
  });

  /**
   * Spec Testing #5. `joinRows` deliberately leaves unmatched candidates
   * unconsumed "until their partners arrive"; at quiescence they never will.
   *
   * Break-proof: dropping the `waiting > 0` guard so every node reported a row
   * turned this into a list including every node in the program, reddening on
   * the exact-equality assertion — which is why the assertion is exact rather
   * than a `toContainEqual`.
   */
  it("reports a ragged allOf leftover", async () => {
    const Left = defineEdge({ name: "Left", label: "L", description: "d", fields: { v: utf8("V") } });
    const Right = defineEdge({ name: "Right", label: "R", description: "d", fields: { v: utf8("V") } });
    const Joined = defineEdge({ name: "Joined", label: "J", description: "d", fields: { v: utf8("V") } });

    // Two Lefts, one Right: the join fires once and one Left is stranded.
    const twoLefts = defineNode({
      name: "twoLefts",
      input: single(Seed),
      output: many(Item),
      fn: () => ({ a: { id: "a" }, b: { id: "b" } }),
    });
    const toLeft = defineNode({
      name: "toLeft",
      input: single(Item),
      output: single(Left),
      fn: (i) => ({ v: i.id }),
    });
    const oneRight = defineNode({
      name: "oneRight",
      input: single(Item),
      output: oneOf(Right, Skipped),
      fn: (i) =>
        i.id === "a" ? { edge: "Right", payload: { v: i.id } } : { edge: "Skipped", payload: { itemId: i.id } },
    });
    const join = defineNode({
      name: "join",
      input: allOf(Left, Right),
      output: single(Joined),
      fn: (bag) => ({ v: `${bag.Left.v}+${bag.Right.v}` }),
    });
    const program: Program = {
      fields: {},
      edges: { Seed, Item, Left, Right, Skipped, Joined },
      nodes: { twoLefts, toLeft, oneRight, join },
      wiring: {
        origins: ["twoLefts"],
        feeds: { twoLefts: ["toLeft", "oneRight"], toLeft: ["join"], oneRight: ["join"] },
      },
    };

    const { log, result } = await run(program, { twoLefts: { v: "x" } });

    // The join did fire — once — so this is a partial success, not a dead run.
    expect(log.instances("Joined", "t")).toHaveLength(1);
    expect(result.residue).toEqual([{ node: "join", edge: "Left", waiting: 1 }]);
  });

  /**
   * Spec Testing #7. A bounded run has unconsumed input by construction, so
   * residue there is ordinary rather than a stall. The two must stay
   * distinguishable in the report — collapsing them into one "error" flag would
   * make every budget-limited run look broken.
   *
   * Break-proof: computing residue only on the quiescence exit left this empty,
   * reddening the length assertion — which is what the shared `finish` helper
   * exists to prevent a future exit from reintroducing.
   */
  it("reports residue for a budget-stopped run too, without calling it quiescence", async () => {
    const program: Program = {
      fields: {},
      edges: { Seed, Item, Looked, Skipped, Summary },
      nodes: { explode, lookOrSkip, summarize },
      wiring: { origins: ["explode"], feeds: { explode: ["lookOrSkip"], lookOrSkip: ["summarize"] } },
    };

    const { result } = await run(program, { explode: { v: "x" } }, { budget: 2 });

    expect(result.stopped).toBe("budget");
    // `explode` fired and one `lookOrSkip` fired; the second Item is still
    // waiting, which is a consequence of the budget and not a defect.
    expect(result.residue.length).toBeGreaterThan(0);
    expect(result.residue).toContainEqual({ node: "lookOrSkip", edge: "Item", waiting: 1 });
  });
});

describe("residue — the check stays quiet", () => {
  /**
   * Spec Testing #3 and #4 together, because they are the same claim about two
   * different shapes: an instance nothing *declares* as input is not residue,
   * however long it sits there. A terminal output is the answer, and an
   * unrouted `oneOf` branch is an ordinary routing decision.
   *
   * This is the assertion that keeps the check usable. Reported as residue,
   * both would fire on essentially every real program.
   *
   * Break-proof: replacing `eligibleForEdge` with "every unconsumed instance of
   * every logged edge" reported `Skipped` and `Summary` here, reddening it.
   */
  it("does not report a terminal output or an unrouted oneOf branch", async () => {
    // Both items are looked at, so the gather completes and `Summary` is
    // produced — and `Skipped` never fires. Then a second run where one is
    // skipped but nothing gathers, so the skip is the only leftover.
    const lookAll = defineNode({
      name: "lookAll",
      input: single(Item),
      output: oneOf(Looked, Skipped),
      fn: (i) => ({ edge: "Looked", payload: { itemId: i.id } }),
    });
    const program: Program = {
      fields: {},
      edges: { Seed, Item, Looked, Skipped, Summary },
      nodes: { explode, lookAll, summarize },
      wiring: { origins: ["explode"], feeds: { explode: ["lookAll"], lookAll: ["summarize"] } },
    };

    const { log, result } = await run(program, { explode: { v: "x" } });

    // `Summary` is produced and consumed by nobody — the answer, sitting there.
    expect(log.instances("Summary", "t")).toHaveLength(1);
    expect(result.residue).toEqual([]);

    // And with a skip but no gather downstream, the skipped branch is a dead
    // end nothing declares, so it is still not residue.
    const noGather: Program = {
      fields: {},
      edges: { Seed, Item, Looked, Skipped },
      nodes: { explode, lookOrSkip },
      wiring: { origins: ["explode"], feeds: { explode: ["lookOrSkip"] } },
    };
    const second = await run(noGather, { explode: { v: "x" } });
    expect(second.log.instances("Skipped", "t")).toHaveLength(1);
    expect(second.result.residue).toEqual([]);
  });

  /**
   * Spec Testing #2, stated where it can actually be checked.
   *
   * The examples are run with implementations in `runtime.test.ts`, so that is
   * where `expect(result.residue).toEqual([])` belongs and where it now sits —
   * on escalation (iteration), manuscript-review (a per-lineage join), and both
   * soc-triage tests (spread and gather), plus the twelve simpler runs that
   * already carried the assertion back when it was named `failures` and was
   * always empty by construction.
   *
   * This test guards the *list*, which is the part a future example can silently
   * fall off: every root under `examples/` must be asserted residue-free
   * somewhere. A new example that runs to quiescence holding waiting input is
   * exactly the thing this whole spec exists to make loud, and it would be
   * absurd for the repo's own corpus to be the place nobody checks.
   */
  it("every example root is asserted residue-free by some test", async () => {
    const examplesDir = fileURLToPath(new URL("../../../examples", import.meta.url));
    const roots = (await readdir(examplesDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
    // Guard against the check examining nothing if the layout ever moves.
    expect(roots.length).toBeGreaterThan(4);

    const runtimeTests = await readFile(new URL("./runtime.test.ts", import.meta.url), "utf8");
    // A root is covered when some test names it and asserts residue. Crude on
    // purpose: it reads the test file rather than the graph, because the thing
    // being guarded is that somebody wrote the assertion, not that a particular
    // run behaves.
    const uncovered = roots.filter((root) => {
      const constant = root.replace(/-/g, "_").toUpperCase();
      const named = runtimeTests.includes(`examples/${root}/src`) || runtimeTests.includes(`${constant}_SRC`);
      return !named;
    });
    expect(uncovered).toEqual([]);
    expect(runtimeTests).toContain("result.residue");
  });
});
