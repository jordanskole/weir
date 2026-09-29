/**
 * A topology can be tested
 * (docs/superpowers/specs/2026-09-28-a-topology-can-be-tested.md).
 *
 * `design.md` §6 ranks topology as the second-riskiest artifact, and until now
 * it had the least checking of any of them: a composite's contract was verified
 * by reading. These run it and compare.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, allOf, oneOf, single } from "./define.js";
import { runExamples } from "./test-run.js";
import type { CompositeDecl } from "./elaborate.js";
import type { Program } from "./implementation.js";

const utf8 = (label: string) => defineField({ type: "utf8", label, description: "d", nullable: false });
const A = defineEdge({ name: "A", label: "A", description: "d", fields: { v: utf8("V") } });
const L = defineEdge({ name: "L", label: "L", description: "d", fields: { v: utf8("V") } });
const R = defineEdge({ name: "R", label: "R", description: "d", fields: { v: utf8("V") } });

const toLeft = defineNode({ name: "toLeft", input: single(A), output: single(L), fn: (a) => ({ v: `L:${a.v}` }) });
const toRight = defineNode({ name: "toRight", input: single(A), output: single(R), fn: (a) => ({ v: `R:${a.v}` }) });

const program = (nodes: Record<string, unknown>): Program =>
  ({ fields: {}, edges: { A, L, R }, nodes, wiring: { origins: [], feeds: {} } }) as Program;

/** A fan-out composite: one A in, an L and an R out, from two terminals. */
const pair = (examples: unknown[]): CompositeDecl =>
  ({
    name: "pair",
    input: { kind: "single", edge: A },
    output: { kind: "allOf", edges: [L, R] },
    terminals: ["toLeft", "toRight"],
    wiring: { origins: ["toLeft", "toRight"], feeds: {} },
    examples,
  }) as CompositeDecl;

describe("weir test — a topology's example", () => {
  /** Spec Testing #1 and #3 (the `allOf` half): every declared edge must match. */
  it("passes when the composition produces what the composite claims", async () => {
    const report = await runExamples(
      program({ toLeft, toRight }),
      [
        pair([
          {
            given: { v: "x" },
            expect: [
              { edge: "L", payload: { v: "L:x" } },
              { edge: "R", payload: { v: "R:x" } },
            ],
          },
        ]),
      ],
    );

    expect(report.failed).toBe(0);
    expect(report.passed).toBe(1);
  });

  /**
   * Spec Testing #2 — the guard against a check that passes by not looking.
   *
   * Break-proof: dropping the `isDeepStrictEqual` comparison in `runExamples`'
   * topology branch made this pass, since the run itself succeeds; the
   * composition produces *something*, just not what was claimed.
   */
  it("fails when the composition produces something else, naming both sides", async () => {
    const report = await runExamples(
      program({ toLeft, toRight }),
      [
        pair([
          {
            given: { v: "x" },
            expect: [
              { edge: "L", payload: { v: "L:x" } },
              { edge: "R", payload: { v: "WRONG" } },
            ],
          },
        ]),
      ],
    );

    expect(report.failed).toBe(1);
    expect(report.results[0]!.expected).toBeDefined();
    expect(report.results[0]!.actual).toEqual([
      { edge: "L", payload: { v: "L:x" } },
      { edge: "R", payload: { v: "R:x" } },
    ]);
  });

  /** Spec Testing #3, the `oneOf` half: one branch is enough. */
  it("is satisfied by the branch that fired, for a oneOf output", async () => {
    const decide = defineNode({
      name: "decide",
      input: single(A),
      output: oneOf(L, R),
      fn: (a) => ({ edge: "L", payload: { v: `L:${a.v}` } }),
    });
    const either: CompositeDecl = {
      name: "either",
      input: { kind: "single", edge: A },
      output: { kind: "oneOf", edges: [L, R] },
      terminals: ["decide"],
      wiring: { origins: ["decide"], feeds: {} },
      examples: [{ given: { v: "x" }, expect: { edge: "L", payload: { v: "L:x" } } }],
    } as CompositeDecl;

    const report = await runExamples(program({ decide }), [either]);

    expect(report.failed).toBe(0);
    expect(report.passed).toBe(1);
  });

  /**
   * **Spec Testing #4 — the rhombus case, one level up.** The answer is read
   * from *terminals*, not from the latest instance of the declared edge. A
   * composite with a rhombus-shaped inner node has two nodes producing the same
   * edge, and only one of them is the end.
   *
   * Break-proof: reading the latest instance of each edge instead of filtering
   * by `envelope.node` makes this **pass** with the intermediate's value —
   * exactly the false green the end check was designed around, reappearing here
   * because it is the same question asked of one run.
   */
  it("reads the answer from terminals, not from whatever last produced the edge", async () => {
    // `seed` and `refine` both produce L; only `refine` is a terminal.
    const seed = defineNode({ name: "seed", input: single(A), output: single(L), fn: (a) => ({ v: `seed:${a.v}` }) });
    const refine = defineNode({ name: "refine", input: single(L), output: single(L), fn: (l) => ({ v: `refine:${l.v}` }) });
    const chain: CompositeDecl = {
      name: "chain",
      input: { kind: "single", edge: A },
      output: { kind: "single", edge: L },
      terminals: ["refine"],
      wiring: { origins: ["seed"], feeds: { seed: ["refine"] } },
      examples: [{ given: { v: "x" }, expect: { v: "refine:seed:x" } }],
    } as CompositeDecl;

    const report = await runExamples(program({ seed, refine }), [chain]);

    expect(report.failed).toBe(0);
    expect(report.results[0]!.actual).toEqual({ v: "refine:seed:x" });
  });

  /**
   * Spec Testing #5. A composition that cannot finish is a **failing example**
   * with the run's own diagnosis, not a thrown error — the run did not do what
   * the composite claimed, which is what a failing example means.
   */
  it("reports a composition that never reaches its end as a failure, with the diagnosis", async () => {
    const stuck: CompositeDecl = {
      name: "stuck",
      input: { kind: "single", edge: A },
      // Claims an R its wiring cannot produce; `toLeft` is the only node.
      output: { kind: "allOf", edges: [L, R] },
      terminals: ["toLeft", "toRight"],
      wiring: { origins: ["toLeft"], feeds: {} },
      examples: [{ given: { v: "x" }, expect: [] }],
    } as CompositeDecl;

    const report = await runExamples(program({ toLeft, toRight }), [stuck]);

    expect(report.failed).toBe(1);
    expect(report.results[0]!.reason).toContain("produced no R");
    expect(report.results[0]!.reason).toContain("quiescence");
  });
});

describe("weir test — both kinds, and skips", () => {
  /** Spec Testing #6: a node's example is invoked, a topology's is run, both are reported. */
  it("runs node examples and topology examples together", async () => {
    const withExample = { ...toLeft, examples: [{ given: { v: "x" }, expect: { v: "L:x" } }] };
    const report = await runExamples(
      program({ toLeft: withExample, toRight }),
      [pair([{ given: { v: "x" }, expect: [{ edge: "L", payload: { v: "L:x" } }, { edge: "R", payload: { v: "R:x" } }] }])],
    );

    expect(report.passed).toBe(2);
    expect(report.results.map((r) => r.kind).sort()).toEqual(["node", "topology"]);
  });

  /**
   * Spec Testing #7. A node with no resolvable implementation is **skipped and
   * said so**, never counted as passing — `verify`'s rule, for the same reason.
   *
   * Break-proof: treating a missing `fn` as a pass made `passed` 1 and
   * `skipped` 0, which is the shape of every false green in this repo.
   */
  it("skips a node with no accepted implementation rather than passing it", async () => {
    // A `NodeDecl` as `elaborate` produces it: contract only, no `fn`.
    const unimplemented = {
      name: "toLeft",
      input: single(A),
      output: single(L),
      examples: [{ given: { v: "x" }, expect: { v: "L:x" } }],
    };

    const report = await runExamples(program({ toLeft: unimplemented }), []);

    expect(report.skipped).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.results[0]!.reason).toContain("no accepted implementation");
  });
});

describe("weir test — effect nodes and inlined duplicates", () => {
  /**
   * An effect node's `fn` is the deliberately-throwing stub
   * `resolveImplementationAt` supplies, since the runtime performs the effect
   * through a host handler instead. This is that stub, exactly.
   */
  const effectful = (calls: string[]) => ({
    name: "fetch",
    effect: "http",
    input: single(A),
    output: single(L),
    examples: [{ given: { v: "x" }, expect: { v: "L:x" } }],
    fn: () => {
      calls.push("called");
      throw new Error(`"fetch" is an effect ("http") — it is performed by the runtime's handler, never called as an ordinary Fn.`);
    },
  });

  /**
   * **Found by pointing `weir test` at the first real program anyone modelled.**
   * Six of its twelve cases failed for this reason alone, and no amount of
   * implementing could have fixed them: declaring an example on an effect node
   * was a permanent red.
   *
   * Break-proof: removing the `node.effect` guard reddens this, and the shape of
   * the failure is the point. The membrane catches the stub's throw and turns it
   * into a `Failed_` payload, so the example is reported as **failed** with
   * `actual.reason` set to the stub's own words — *"it is performed by the
   * runtime's handler, never called as an ordinary Fn"*. `weir test` was
   * printing the explanation of its own bug as if it were the author's mistake.
   *
   * This comment first claimed the throw escaped `runExamples` and rejected the
   * whole call. It does not; the membrane catches it. Corrected after running
   * the break, because a break-proof whose stated mechanism is wrong is the
   * false green this repo keeps finding, one level up.
   */
  it("does not invoke an effect node's stub, and reports it as its own category", async () => {
    const calls: string[] = [];
    const report = await runExamples(program({ fetch: effectful(calls) }), []);

    expect(calls).toEqual([]);
    expect(report.effects).toBe(1);
    expect(report.results[0]!.outcome).toBe("effect");
    expect(report.results[0]!.reason).toContain("http");
    // Never a pass: nothing was checked. And never a skip, which would block a
    // green tick forever.
    expect(report.passed).toBe(0);
    expect(report.failed).toBe(0);
    expect(report.skipped).toBe(0);
  });

  /**
   * `inlineComposites` leaves a composite's inner nodes under both the bare name
   * and the qualified position, so reading examples off the raw map ran each
   * declaration twice and reported it under two names.
   *
   * Break-proof: iterating `Object.entries(program.nodes)` instead of
   * `distinctContracts` returns two results here, `passed` 2, one of them named
   * `wrap/toLeft` — one declaration counted twice, which would also let a
   * duplicate quietly inflate a green run's numbers.
   */
  it("runs one declaration once, though inlining leaves it under two keys", async () => {
    const withExample = { ...toLeft, examples: [{ given: { v: "x" }, expect: { v: "L:x" } }] };

    const report = await runExamples(program({ toLeft: withExample, "wrap/toLeft": withExample }), []);

    expect(report.results).toHaveLength(1);
    expect(report.passed).toBe(1);
    expect(report.results[0]!.name).toBe("toLeft");
  });
});
