/**
 * The runtime (docs/getting-started.md step 5): walks a `Program`'s
 * `wiring` in pulse order, calling each reachable node through `membrane()`
 * and appending successful results to the `Log`. Implements the pulse/wave
 * model design-history.md already decided ("`every` lands; a pulse/wave
 * model settles graph-level scheduling") as a worklist rather than
 * precomputed pulse numbers: a node is attempted once after each of its
 * declared parents fires (every parent lists it again under its own
 * `then:`, per `.topology`'s own convention — design-history.md, "`.topology`
 * built"), and firing is idempotent (a `fired` set), so the *outcome* is
 * the same as running discrete pulses to a fixpoint without needing to
 * number them.
 *
 * Deliberately narrow, stated here rather than left implicit:
 * - **`Failed<In>` routing exists for `single`- and `every`-input nodes;
 *   `any`-input nodes still don't.** A `single`-input node's failure logs
 *   under `failedEdgeName(inputEdge)` (`Failed_Todo` for a `Todo`-input
 *   node, synthesized automatically by `elaborate()`'s
 *   `synthesizeFailedEdges`); an `every`-input node's bag-shaped failure
 *   (`{A: ..., B: ...}`) logs under `failedEveryEdgeName(edges)`
 *   (`Failed_A_B`, sorted and order-independent, synthesized by
 *   `synthesizeEveryFailedEdges` for whichever combos are actually
 *   declared) — both cases route through the same readiness mechanism a
 *   downstream node declaring that edge as its own input already uses, no
 *   new mechanism needed (docs/design-history.md, "The runtime, built
 *   narrow on purpose... `Failed<In>` routing"). An `any`-input node's
 *   `Failed<In>` is tagged (`{edge, payload}`) instead — no synthesized
 *   edge exists for that shape, and it still collects in `failures`,
 *   unrouted — a real, separate next increment, not silently dropped.
 * - **Disambiguating a real `Failed<In>` from a genuine `single`-output
 *   success value is a heuristic** (`looksLikeFailed`), not a real
 *   discriminant — the same open, undecided wire-format question. Safe
 *   for every real edge in this repo today (none has exactly `{input}` or
 *   `{input, reason}` as its full field set); would misfire against a
 *   hypothetical edge that did.
 * - **A node whose own name recurs as its own (transitive) descendant
 *   fires at most once per invocation**, not once per literal repetition
 *   a hand-authored `.topology` chain like `birthday.then.birthday.then.birthday`
 *   implies. Firing it repeatedly without a bound would loop forever —
 *   `.topology`'s adjacency-list `Wiring` can't distinguish "run it 3
 *   times" from "run it forever" once collapsed from nested YAML into a
 *   flat parent→children map, and design-history.md ("Weir has no loop
 *   construct") already flags that a real iteration-count bound isn't
 *   designed yet either. Firing once is the conservative, terminating
 *   default until that exists — not a claim the repeated-application case
 *   is actually supported.
 */

import { membrane } from "./membrane.js";
import type { Log } from "./membrane.js";
import type { Program } from "./implementation.js";
import type { Failed, InputSpec, OutputSpec, PayloadOf } from "./types.js";
import { Identity, failedEdgeName, failedEveryEdgeName } from "./types.js";

/**
 * `program.nodes` stores heterogeneous NodeDefs in one `Record<string,
 * NodeDef>`, erasing each node's own literal `In`/`O` to the generic
 * default. `membrane()`'s return type is a conditional on `In`, which TS
 * can't resolve from that erased generic even after `nodeDef.input.kind`
 * has been checked at the value level — a real TS narrowing limitation,
 * not a genuine call-shape ambiguity (checked at runtime by the `kind`
 * branch itself). These two aliases name the cast instead of hiding it.
 * `AnyMultiInvoke` covers both `every`- and `any`-input nodes — their
 * `membrane()` call shape is identical (`correlationId, log, identity?`);
 * only what's inside `In` differs, and that's erased here too. (Named
 * "Multi" rather than reusing the real `any` InputSpec kind's name, to
 * avoid the two meanings of "any" colliding in this file.)
 */
type AnySingleInvoke = (
  payload: unknown,
  correlationId: string,
  identity?: PayloadOf<typeof Identity>,
) => Promise<unknown>;
type AnyMultiInvoke = (
  correlationId: string,
  log: Log,
  identity?: PayloadOf<typeof Identity>,
) => Promise<unknown>;

export interface RunResult {
  failures: { node: string; failed: Failed<InputSpec> }[];
}

/**
 * A pragmatic, documented heuristic (see file header) — not a real
 * discriminant. `Failed<In>` is always exactly `{ input }` or
 * `{ input, reason }`; nothing else in this repo's edges collides.
 */
function looksLikeFailed(result: unknown): result is Failed<InputSpec> {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const keys = Object.keys(result);
  if (!keys.includes("input")) return false;
  return keys.every((key) => key === "input" || key === "reason");
}

/**
 * Logs a successful result under the right edge name(s) for its declared
 * output kind: `single`/`many` log the one result directly under the
 * declared edge's name (a `many` result is already one collection payload,
 * never N separate instances — docs/design-history.md, "`many` is a
 * collection, keyed by index, not an array"); `oneOf` logs only the branch
 * that actually tagged itself; `allOf` logs every tagged branch.
 */
function logOutput(log: Log, output: OutputSpec, result: unknown, correlationId: string): void {
  if (output.kind === "single" || output.kind === "many") {
    log.append(output.edge.name, correlationId, result);
    return;
  }
  if (output.kind === "oneOf") {
    const tagged = result as { edge: string; payload: unknown };
    log.append(tagged.edge, correlationId, tagged.payload);
    return;
  }
  const tags = result as { edge: string; payload: unknown }[];
  for (const tagged of tags) {
    log.append(tagged.edge, correlationId, tagged.payload);
  }
}

export async function runNetlist(
  program: Program,
  log: Log,
  correlationId: string,
  originPayloads: Record<string, unknown>,
  identity?: PayloadOf<typeof Identity>,
): Promise<RunResult> {
  const failures: RunResult["failures"] = [];
  const fired = new Set<string>();
  const origins = new Set(program.wiring.origins);

  async function tryFire(nodeName: string): Promise<boolean> {
    if (fired.has(nodeName)) return false;

    const nodeDef = program.nodes[nodeName];
    if (!nodeDef) {
      throw new Error(`Wiring references "${nodeName}", but no .node file declares it.`);
    }

    let result: unknown;
    if (nodeDef.input.kind === "single") {
      let payload: unknown;
      if (origins.has(nodeName)) {
        if (!(nodeName in originPayloads)) return false;
        payload = originPayloads[nodeName];
      } else {
        payload = log.latest(nodeDef.input.edge.name, correlationId);
        if (payload === undefined) return false;
      }
      result = await (membrane(nodeDef) as AnySingleInvoke)(payload, correlationId, identity);
    } else {
      const multi = await (membrane(nodeDef) as AnyMultiInvoke)(correlationId, log, identity);
      if (multi === undefined) return false;
      result = multi;
    }

    fired.add(nodeName);
    if (looksLikeFailed(result)) {
      if (nodeDef.input.kind === "single") {
        log.append(failedEdgeName(nodeDef.input.edge.name), correlationId, result);
      } else if (nodeDef.input.kind === "every") {
        // The synthesized combo edge is flat (elaborate.ts's synthesizeEveryFailedEdges:
        // {A, B, reason}, no `input` wrapper) — spread the bag alongside reason to match.
        const bag = result.input as Record<string, unknown>;
        log.append(failedEveryEdgeName(nodeDef.input.edges), correlationId, { ...bag, reason: result.reason });
      } else {
        // any-input Failed<In> is tagged ({edge, payload}); no synthesized edge yet
        // (elaborate.ts's synthesis covers single-input and every-combos only) —
        // still collected here.
        failures.push({ node: nodeName, failed: result });
      }
    } else {
      logOutput(log, nodeDef.output, result, correlationId);
    }
    return true;
  }

  const queue = [...program.wiring.origins];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const didFire = await tryFire(name);
    if (didFire) {
      for (const child of program.wiring.feeds[name] ?? []) {
        queue.push(child);
      }
    }
  }

  return { failures };
}
