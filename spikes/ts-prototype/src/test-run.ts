/**
 * Running a program's declared examples
 * (docs/superpowers/specs/2026-09-28-a-topology-can-be-tested.md).
 *
 * `design.md` §6 orders verification risk highest-first — ontology, topology,
 * examples, implementation — and until now the *second* item had the least
 * checking of any of them. A node declares examples, generated cases and
 * properties and an acceptance gate runs all three; a composite declared a
 * contract in the same vocabulary and the only thing that ever checked it was
 * one static rule, that its terminals could in principle produce the edges it
 * claims. Nothing ran it and compared.
 *
 * **This is testing, not acceptance**, and the distinction is why it is a
 * separate module rather than a branch inside `accept.ts`. The gate decides
 * whether a *drafted implementation* may persist. A composite has no drafted
 * implementation — its body is its wiring, already in the declaration a human
 * wrote — so there is nothing to accept and nothing to write. What it needs is
 * the other half: given implementations for its inner nodes, does the
 * composition do what the composite claims?
 *
 * Two paths on purpose: a node's example is **invoked** through the membrane, a
 * topology's is **run** through the pulse loop. That is the one real asymmetry
 * left in "a topology is a node", and it is made explicit here rather than
 * papered over.
 */

import { isDeepStrictEqual } from "node:util";
import { outputEdgeNames } from "./elaborate.js";
import type { CompositeDecl } from "./elaborate.js";
import { invokeWithInput } from "./invoke.js";
import { InMemoryLog } from "./membrane.js";
import { resolveTrigger, runNetlist } from "./runtime.js";
import type { Program } from "./implementation.js";
import type { NodeDecl, NodeDef } from "./types.js";

/**
 * A program partway through being implemented — which is what `weir test` has
 * while an agent drafts one node at a time.
 *
 * `Program.nodes` is `Record<string, NodeDef>`, meaning every node has an `fn`.
 * That is right for `runNetlist` (a program that cannot execute should not
 * start) and wrong here: this command's whole job includes reporting what is
 * *not* implemented yet. Saying so in the type is what keeps the skip path from
 * being a cast.
 */
export interface TestableProgram extends Omit<Program, "nodes"> {
  nodes: Record<string, NodeDecl | NodeDef>;
}

export interface ExampleResult {
  /** `node` or `topology` — which path ran it, which is also which kind declared it. */
  kind: "node" | "topology";
  name: string;
  index: number;
  outcome: "passed" | "failed" | "skipped";
  /** Present when it failed: what was declared against what came back. */
  expected?: unknown;
  actual?: unknown;
  /** Present when it failed or was skipped: why, in one line. */
  reason?: string;
}

export interface TestReport {
  results: ExampleResult[];
  passed: number;
  failed: number;
  skipped: number;
}

/**
 * Reads a finished run's answer: the instances of the declared output edges
 * **produced by declared terminals**.
 *
 * Byte for byte the rule the end check applies, because it is the same question
 * — *did this topology produce what it claims* — asked of one run rather than of
 * a program. Reading the latest instance of each edge instead would be the
 * rhombus false green one level up: a composite whose inner node takes and
 * returns the same edge would be satisfied by an intermediate that a
 * non-terminal emitted (2026-09-28-a-root-topology-declares-its-end.md §1).
 *
 * Shaped to match what `untagExamples` produces for the same `OutputSpec`, so an
 * `expect` can be compared with `isDeepStrictEqual` and nothing has to know the
 * encoding twice.
 */
function readAnswer(
  log: InMemoryLog,
  correlationId: string,
  topology: CompositeDecl,
): { ok: true; value: unknown } | { ok: false; missing: string[] } {
  const terminals = new Set(topology.terminals);
  const fromTerminal = (edgeName: string): unknown[] =>
    log
      .instances(edgeName, correlationId)
      .filter((i) => i.envelope !== undefined && terminals.has(i.envelope.node))
      .map((i) => i.payload);

  const declared = outputEdgeNames(topology.output);
  const found = new Map(declared.map((name) => [name, fromTerminal(name)]));
  const missing = declared.filter((name) => found.get(name)!.length === 0);

  if (topology.output.kind === "single" || topology.output.kind === "many") {
    if (missing.length > 0) return { ok: false, missing };
    return { ok: true, value: found.get(declared[0]!)![0] };
  }
  if (topology.output.kind === "oneOf") {
    // One branch is enough, which is what `oneOf` means everywhere else.
    const fired = declared.find((name) => found.get(name)!.length > 0);
    if (fired === undefined) return { ok: false, missing };
    return { ok: true, value: { edge: fired, payload: found.get(fired)![0] } };
  }
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, value: declared.map((edge) => ({ edge, payload: found.get(edge)![0] })) };
}

/**
 * Runs one topology's example: build a program from its own wiring, resolve the
 * trigger, run, read the answer.
 *
 * A composite plus the nodes it names *is* a program with one entry, so this
 * needs no machinery of its own — its inner nodes survive inlining under their
 * unqualified names, so the wiring resolves as written.
 *
 * A stalled run, an unmet end or a `Failed_*` are all **failing examples**
 * rather than thrown errors: each means the composition did not do what it
 * claimed, which is exactly what a failing example reports. The run's own
 * diagnosis is carried along as the reason.
 */
async function runTopologyExample(
  program: TestableProgram,
  topology: CompositeDecl,
  given: unknown,
  index: number,
): Promise<ExampleResult> {
  const base = { kind: "topology" as const, name: topology.name, index };

  // A topology can only be run when every node its wiring names is implemented.
  // Reported as a skip rather than executed into a confusing failure, for the
  // same reason an unimplemented node is: a check that examines nothing must
  // say so.
  const referenced = [...topology.wiring.origins, ...Object.values(topology.wiring.feeds).flat()];
  const unimplemented = [...new Set(referenced)].filter(
    (name) => typeof (program.nodes[name] as NodeDef | undefined)?.fn !== "function",
  );
  if (unimplemented.length > 0) {
    return { ...base, outcome: "skipped", reason: `no accepted implementation for ${unimplemented.join(", ")}` };
  }

  const correlationId = `test-${topology.name}-${index}`;
  const sub: Program = {
    fields: program.fields,
    edges: program.edges,
    nodes: program.nodes as Program["nodes"],
    wiring: topology.wiring,
    entries: [topology],
  };

  let originPayloads: Record<string, unknown>;
  try {
    originPayloads = resolveTrigger(sub, given);
  } catch (error) {
    return { ...base, outcome: "failed", reason: (error as Error).message };
  }

  const log = new InMemoryLog();
  const result = await runNetlist(sub, { correlationId, originPayloads }, { log, maxPulses: 200 });
  const answer = readAnswer(log, correlationId, topology);

  if (!answer.ok) {
    const why = [
      `produced no ${answer.missing.join(", ")} from ${topology.terminals.join(", ")}`,
      ...result.residue.map((r) => `${r.node} left waiting on ${r.edge}`),
    ];
    return { ...base, outcome: "failed", reason: `${result.stopped}: ${why.join("; ")}` };
  }
  return { ...base, outcome: "passed", actual: answer.value };
}

/**
 * Runs every declared example in a program — a node's through the membrane, a
 * topology's through a run.
 *
 * A node with no resolvable implementation is **skipped and said so**, never
 * counted as passing: `verify` takes the same care for the same reason, since a
 * check that quietly examines nothing is this repo's most frequent bug.
 */
export async function runExamples(program: TestableProgram, topologies: CompositeDecl[]): Promise<TestReport> {
  const results: ExampleResult[] = [];

  for (const [name, node] of Object.entries(program.nodes)) {
    for (const [index, example] of (node.examples ?? []).entries()) {
      const base = { kind: "node" as const, name, index };
      if (typeof (node as NodeDef).fn !== "function") {
        results.push({ ...base, outcome: "skipped", reason: "no accepted implementation" });
        continue;
      }
      const { result } = await invokeWithInput(node as NodeDef, example.given, {
        correlationId: `test-${name}-${index}`,
      });
      results.push(
        isDeepStrictEqual(result, example.expect)
          ? { ...base, outcome: "passed", actual: result }
          : { ...base, outcome: "failed", expected: example.expect, actual: result },
      );
    }
  }

  for (const topology of topologies) {
    for (const [index, example] of (topology.examples ?? []).entries()) {
      const outcome = await runTopologyExample(program, topology, example.given, index);
      if (outcome.outcome === "passed" && !isDeepStrictEqual(outcome.actual, example.expect)) {
        results.push({ ...outcome, outcome: "failed", expected: example.expect });
        continue;
      }
      results.push(outcome);
    }
  }

  return {
    results,
    passed: results.filter((r) => r.outcome === "passed").length,
    failed: results.filter((r) => r.outcome === "failed").length,
    skipped: results.filter((r) => r.outcome === "skipped").length,
  };
}
