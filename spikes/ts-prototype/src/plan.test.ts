/**
 * The planner (docs/superpowers/specs/2026-09-28-the-planner.md, design.md §8).
 *
 * Type-directed search: candidate routes from one edge to another, each a real
 * wiring. The design point these tests exist to protect is that it is the **pulse
 * loop over types**, not a path-finder — a path cannot cross an `allOf` node,
 * because reaching one needs two edges available and a path carries one.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, allOf, single } from "./define.js";
import { elaborate } from "./elaborate.js";
import { InMemoryLog } from "./membrane.js";
import { plan } from "./plan.js";
import { runNetlist } from "./runtime.js";
import type { Program } from "./implementation.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples", import.meta.url));
const example = (name: string) => elaborate(join(EXAMPLES, name, "src"));
const utf8 = (label: string) => defineField({ type: "utf8", label, description: "d", nullable: false });

describe("plan — finding routes", () => {
  /** Spec Testing #1: the simple case, and the shape of the answer. */
  it("finds a route and returns it as a real wiring", async () => {
    const routes = plan(await example("recipe"), "Recipe", "Cookies");

    expect(routes).toHaveLength(1);
    expect(routes[0]!.nodes.sort()).toEqual(["bake", "cool", "mix", "preheatOven"]);
    expect(routes[0]!.wiring.origins).toEqual(["mix", "preheatOven"]);
    expect(routes[0]!.wiring.feeds).toEqual({
      mix: ["bake"],
      preheatOven: ["bake"],
      bake: ["cool"],
    });
  });

  /**
   * **Spec Testing #2 — the case the whole design exists for.** `bake` declares
   * `allOf[Dough, Oven]`, so reaching it needs *both* arms available. A
   * path-based planner carries one edge at a time and would route around it.
   *
   * Break-proof: replacing the applicability test with "any declared input edge
   * is available" (`some` for `every`) produces a route omitting `preheatOven`,
   * because `bake` looks reachable from `Dough` alone — which then derives a
   * wiring that cannot run.
   */
  it("routes through an allOf node, including both arms", async () => {
    const routes = plan(await example("recipe"), "Recipe", "Cookies");

    expect(routes[0]!.nodes).toContain("mix");
    expect(routes[0]!.nodes).toContain("preheatOven");
    // Both feed the join, which is what "both arms" means structurally.
    expect(routes[0]!.wiring.feeds.mix).toEqual(["bake"]);
    expect(routes[0]!.wiring.feeds.preheatOven).toEqual(["bake"]);
  });

  /**
   * Spec Testing #3. A `gather` is just a node whose declared input names one
   * edge, so it needs no case of its own — and the route it finds is exactly
   * `soc-triage`'s hand-written topology, rediscovered from edge types alone.
   */
  it("routes through a spread and a gather", async () => {
    const routes = plan(await example("soc-triage"), "Alert", "AlertAssessment");

    expect(routes).toHaveLength(1);
    expect(routes[0]!.nodes).toContain("extractEntities");
    expect(routes[0]!.nodes).toContain("summarizeAlert");
    expect(routes[0]!.depth).toBe(5);
  });

  /** Spec Testing #4. */
  it("returns no routes for an unreachable target", async () => {
    // `Alert` is an origin's input; nothing produces one, so nothing can reach it.
    expect(plan(await example("soc-triage"), "Assessment", "Alert")).toEqual([]);
  });

  /**
   * Spec Testing #5 — and the mechanism is not the one the spec named.
   *
   * Break-proof: dropping the `Failed_` filter in `produces` reddens **nothing**.
   * `outputEdgeNames` returns only *declared* outputs, and a `Failed_X` is
   * synthesized and emitted implicitly, never declared — so the planner never
   * sees one and the filter never fires. This test passes because failure edges
   * were never candidates, not because they were filtered out.
   *
   * Said plainly rather than left looking like proof: a green test whose stated
   * cause is not its real cause is the same false green in a new place.
   */
  it("does not route through failure edges — because they are never declared outputs", async () => {
    expect(plan(await example("recipe"), "Recipe", "Failed_Recipe")).toEqual([]);
  });

  /**
   * What the filter *does* guard: an author declaring `output: Failed_X`
   * explicitly, which the elaborator permits since the synthesized edges are
   * real. This is the only case where removing it changes an answer.
   */
  it("does not route through a failure edge even when a node declares one as its output", () => {
    const A = defineEdge({ name: "A", label: "A", description: "d", fields: { v: utf8("V") } });
    const FailedA = defineEdge({ name: "Failed_A", label: "F", description: "d", fields: { v: utf8("V") } });
    const emitsFailure = defineNode({ name: "emitsFailure", input: single(A), output: single(FailedA), fn: (a) => a });

    expect(plan({ nodes: { emitsFailure } } as never, "A", "Failed_A")).toEqual([]);
  });

  /**
   * Spec Testing #6. `mix` then `preheatOven` and the reverse are the same
   * route; returning both would be a factorial of orderings.
   *
   * Break-proof: keying `found` by the applied *sequence* rather than the sorted
   * set reddens **nothing** — `seenStates` already prunes by the same sorted set
   * before a second ordering can reach the result. Recorded rather than claimed:
   * the sort defines the result and the state check bounds the search, and today
   * only one of them is load-bearing for this assertion.
   */
  it("reports two orderings of the same node set as one route", async () => {
    const routes = plan(await example("recipe"), "Recipe", "Cookies");

    expect(routes).toHaveLength(1);
    expect(new Set(routes.map((r) => [...r.nodes].sort().join(" "))).size).toBe(1);
  });

  /**
   * Not in the spec — found on the first run. Inlining leaves a composite's
   * inner nodes under two keys, and searching both produced combinatorially many
   * routes differing only in which copy they named (three, for `soc-triage`,
   * where one is right).
   *
   * Break-proof: searching `program.nodes` instead of `distinctContracts`
   * returns multiple routes here, all equivalent.
   */
  it("searches distinct contracts, not a composite's inlined duplicates", async () => {
    const routes = plan(await example("soc-triage"), "Alert", "AlertAssessment");

    expect(routes).toHaveLength(1);
    expect(routes[0]!.nodes.filter((n) => n.includes("/"))).toEqual([]);
  });
});

describe("plan — annotations and ordering", () => {
  const A = defineEdge({ name: "A", label: "A", description: "d", fields: { v: utf8("V") } });
  const B = defineEdge({ name: "B", label: "B", description: "d", fields: { v: utf8("V") } });
  const C = defineEdge({ name: "C", label: "C", description: "d", fields: { v: utf8("V") } });

  /**
   * Spec Testing #7. Depth counts **pulses**, not nodes: a wide route that runs
   * in two pulses is genuinely better than a narrow one that runs in three, and
   * sorting by node count would invert that.
   *
   * Break-proof: ordering by `nodes.length` puts the three-node chain first.
   */
  it("orders by pulses, so a wider shallower route beats a longer chain", () => {
    // Wide: two nodes from A produce B and C in one pulse, joined in the next.
    const toB = defineNode({ name: "toB", input: single(A), output: single(B), fn: (a) => a });
    const toC = defineNode({ name: "toC", input: single(A), output: single(C), fn: (a) => a });
    const join = defineNode({ name: "join", input: allOf(B, C), output: single(C), fn: () => ({ v: "x" }) });
    // Narrow: a three-step chain to the same target.
    const s1 = defineNode({ name: "s1", input: single(A), output: single(B), fn: (a) => a });
    const s2 = defineNode({ name: "s2", input: single(B), output: single(B), fn: (a) => a });
    const s3 = defineNode({ name: "s3", input: single(B), output: single(C), fn: (a) => a });
    const program = { nodes: { toB, toC, join, s1, s2, s3 } };

    const routes = plan(program as never, "A", "C");

    expect(routes.length).toBeGreaterThan(1);
    // The shallowest is first, and it is not the one with fewest nodes.
    expect(routes[0]!.depth).toBeLessThanOrEqual(routes[1]!.depth);
    expect(routes.map((r) => r.depth)).toEqual([...routes.map((r) => r.depth)].sort((a, b) => a - b));
  });

  /** Spec Testing #9. `effect:` is derivable; `lossy` deliberately is not reported at all (spec §4). */
  it("reports effectful nodes on a route, and claims nothing about lossiness", () => {
    const pure = defineNode({ name: "pure", input: single(A), output: single(B), fn: (a) => a });
    const clock = { ...defineNode({ name: "clock", input: single(B), output: single(C), fn: (b) => b }), effect: "clock" };

    const routes = plan({ nodes: { pure, clock } } as never, "A", "C");

    expect(routes[0]!.effectful).toEqual(["clock"]);
    expect(routes[0]!).not.toHaveProperty("lossy");

    const pureOnly = plan({ nodes: { pure } } as never, "A", "B");
    expect(pureOnly[0]!.effectful).toEqual([]);
  });
});

describe("plan — a route is a topology", () => {
  /**
   * **Spec Testing #8, and the assertion that keeps "a route is a topology" from
   * being a figure of speech.** Take the planner's derived wiring, run it, and
   * the target edge appears.
   *
   * Break-proof: deriving `origins` as "the first node applied" rather than "the
   * nodes nothing feeds" leaves `preheatOven` unwired, the run reaches
   * quiescence without firing `bake`, and no `C` is produced.
   */
  it("produces a wiring that actually runs and yields the target edge", async () => {
    const A = defineEdge({ name: "A", label: "A", description: "d", fields: { v: utf8("V") } });
    const B = defineEdge({ name: "B", label: "B", description: "d", fields: { v: utf8("V") } });
    const D = defineEdge({ name: "D", label: "D", description: "d", fields: { v: utf8("V") } });
    const C = defineEdge({ name: "C", label: "C", description: "d", fields: { v: utf8("V") } });
    const toB = defineNode({ name: "toB", input: single(A), output: single(B), fn: (a) => ({ v: `B:${a.v}` }) });
    const toD = defineNode({ name: "toD", input: single(A), output: single(D), fn: (a) => ({ v: `D:${a.v}` }) });
    const join = defineNode({
      name: "join",
      input: allOf(B, D),
      output: single(C),
      fn: (bag) => ({ v: `${bag.B.v}+${bag.D.v}` }),
    });
    const nodes = { toB, toD, join };

    const routes = plan({ nodes } as never, "A", "C");
    expect(routes).toHaveLength(1);

    // Run the planner's own output.
    const program: Program = { fields: {}, edges: { A, B, D, C }, nodes, wiring: routes[0]!.wiring };
    const log = new InMemoryLog();
    const originPayloads = Object.fromEntries(routes[0]!.wiring.origins.map((o) => [o, { v: "x" }]));
    const result = await runNetlist(program, { correlationId: "t", originPayloads }, { log, maxPulses: 10 });

    expect(result.stopped).toBe("quiescence");
    expect(log.instances("C", "t")).toHaveLength(1);
    expect(log.instances("C", "t")[0]!.payload).toEqual({ v: "B:x+D:x" });
    // And the planner's depth was the real pulse count.
    expect(routes[0]!.depth).toBe(result.pulses);
  });
});
