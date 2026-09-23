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
 * - **`Failed<In>` routing exists for `single`- and `allOf`-input nodes —
 *   every InputSpec kind there is.** A `single`-input node's failure logs
 *   under `failedEdgeName(inputEdge)` (`Failed_Todo` for a `Todo`-input
 *   node, synthesized automatically by `elaborate()`'s
 *   `synthesizeFailedEdges`); an `allOf`-input node's bag-shaped failure
 *   (`{A: ..., B: ...}`) logs under `failedAllOfEdgeName(edges)`
 *   (`Failed_A_B`, sorted and order-independent, synthesized by
 *   `synthesizeAllOfFailedEdges` for whichever combos are actually
 *   declared) — both cases route through the same readiness mechanism a
 *   downstream node declaring that edge as its own input already uses, no
 *   new mechanism needed (docs/design-history.md, "The runtime, built
 *   narrow on purpose... `Failed<In>` routing").
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
import type { InstanceEnvelope, Log } from "./membrane.js";
import type { Program } from "./implementation.js";
import type { AnyEdgeDef, Envelope, Failed, InputSpec, OutputSpec, PayloadOf } from "./types.js";
import { Identity, failedEdgeName, failedAllOfEdgeName } from "./types.js";
import { hashEdge } from "./hash.js";
import type { Trace } from "./trace.js";

/**
 * `program.nodes` stores heterogeneous NodeDefs in one `Record<string,
 * NodeDef>`, erasing each node's own literal `In`/`O` to the generic
 * default. `membrane()`'s return type is a conditional on `In`, which TS
 * can't resolve from that erased generic even after `nodeDef.input.kind`
 * has been checked at the value level — a real TS narrowing limitation,
 * not a genuine call-shape ambiguity (checked at runtime by the `kind`
 * branch itself). These two aliases name the cast instead of hiding it.
 * `AnyAllOfInvoke` names the cast for `allOf`-input nodes' call shape
 * (`correlationId, log, identity?`); `In` is erased here too.
 */
type AnySingleInvoke = (
  payload: unknown,
  correlationId: string,
  identity?: PayloadOf<typeof Identity>,
) => Promise<{ result: unknown; envelope?: Envelope }>;
type AnyAllOfInvoke = (
  correlationId: string,
  log: Log,
  identity?: PayloadOf<typeof Identity>,
) => Promise<{ result: unknown; envelope?: Envelope } | undefined>;

export interface RunResult {
  /** Currently always empty — the only InputSpec kind whose failures ever landed here (the removed `any` kind) no longer exists. Retained rather than removed, since deleting it would be a separate public-API change. */
  failures: { node: string; failed: Failed<InputSpec> }[];
}

/**
 * A pragmatic, documented heuristic (see file header) — not a real
 * discriminant. `Failed<In>` is always exactly `{ input }` or
 * `{ input, reason }`; nothing else in this repo's edges collides.
 */
export function looksLikeFailed(result: unknown): result is Failed<InputSpec> {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const keys = Object.keys(result);
  if (!keys.includes("input")) return false;
  return keys.every((key) => key === "input" || key === "reason");
}

/**
 * Builds the `InstanceEnvelope` for one emitted instance of `edge` — the
 * invocation's `Envelope` plus that edge's own schema hash (docs/design.md
 * §5). `undefined` when there's no base envelope to extend (Fn never ran)
 * or no edge to hash against (see `logOutput`'s `oneOf` lookup and
 * `tryFire`'s failure path — a missing synthesized edge, an elaborator
 * concern, not something worth failing a run over).
 */
async function instanceEnvelope(
  envelope: Envelope | undefined,
  edge: AnyEdgeDef | undefined,
): Promise<InstanceEnvelope | undefined> {
  if (!envelope || !edge) return undefined;
  return { ...envelope, schemaHash: (await hashEdge(edge)).hash };
}

/**
 * Logs a successful result under the right edge name(s) for its declared
 * output kind: `single`/`many` log the one result directly under the
 * declared edge's name (a `many` result is already one collection payload,
 * never N separate instances — docs/design-history.md, "`many` is a
 * collection, keyed by index, not an array"); `oneOf` logs only the branch
 * that actually tagged itself; `allOf` logs every tagged branch. Each
 * logged instance carries its own `InstanceEnvelope`, hashed against the
 * specific edge it was written under — `envelope` here is the invocation's
 * envelope (same `id` for every instance an `allOf`-output node emits;
 * different `schemaHash` per instance, see `instanceEnvelope`).
 */
async function logOutput(
  log: Log,
  output: OutputSpec,
  result: unknown,
  correlationId: string,
  envelope: Envelope | undefined,
): Promise<void> {
  if (output.kind === "single" || output.kind === "many") {
    log.append(output.edge.name, correlationId, result, await instanceEnvelope(envelope, output.edge));
    return;
  }
  if (output.kind === "oneOf") {
    const tagged = result as { edge: string; payload: unknown };
    const edge = output.edges.find((e) => e.name === tagged.edge);
    log.append(tagged.edge, correlationId, tagged.payload, await instanceEnvelope(envelope, edge));
    return;
  }
  const tags = result as { edge: string; payload: unknown }[];
  for (const tagged of tags) {
    const edge = output.edges.find((e) => e.name === tagged.edge);
    log.append(tagged.edge, correlationId, tagged.payload, await instanceEnvelope(envelope, edge));
  }
}

export async function runNetlist(
  program: Program,
  log: Log,
  correlationId: string,
  originPayloads: Record<string, unknown>,
  identity?: PayloadOf<typeof Identity>,
  trace?: Trace,
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
    let envelope: Envelope | undefined;
    let input: unknown;
    if (nodeDef.input.kind === "single") {
      let payload: unknown;
      if (origins.has(nodeName)) {
        if (!(nodeName in originPayloads)) return false;
        payload = originPayloads[nodeName];
      } else {
        payload = log.latest(nodeDef.input.edge.name, correlationId);
        if (payload === undefined) return false;
      }
      input = payload;
      const invocation = await (membrane(nodeDef) as AnySingleInvoke)(payload, correlationId, identity);
      result = invocation.result;
      envelope = invocation.envelope;
    } else {
      // membrane()'s allOf invoke resolves the bag internally and never
      // hands it back — rebuild it the same way (one log.latest per
      // declared edge) so the trace entry's `input` is the actual bag Fn
      // ran on, not a re-derivation that could drift from it.
      const bag: Record<string, unknown> = {};
      for (const edge of nodeDef.input.edges) {
        bag[edge.name] = log.latest(edge.name, correlationId);
      }
      input = bag;
      const invocation = await (membrane(nodeDef) as AnyAllOfInvoke)(correlationId, log, identity);
      if (invocation === undefined) return false;
      result = invocation.result;
      envelope = invocation.envelope;
    }

    fired.add(nodeName);
    if (envelope !== undefined) {
      trace?.record({ envelope, input, result });
    }
    if (looksLikeFailed(result)) {
      // The synthesized Failed_* edge is a real emitted instance too — hash
      // it the same way, but it's the *elaborator*'s job to have synthesized
      // it into program.edges (synthesizeFailedEdges/synthesizeAllOfFailedEdges).
      // If it isn't there, log with no envelope rather than throw: a missing
      // synthesized edge is an elaborator concern, not something worth
      // failing an entire run over.
      const failedName =
        nodeDef.input.kind === "single"
          ? failedEdgeName(nodeDef.input.edge.name)
          : failedAllOfEdgeName(nodeDef.input.edges);
      const failedEnvelope = await instanceEnvelope(envelope, program.edges[failedName]);
      if (nodeDef.input.kind === "single") {
        log.append(failedName, correlationId, result, failedEnvelope);
      } else {
        // The synthesized combo edge is flat (elaborate.ts's synthesizeAllOfFailedEdges:
        // {A, B, reason}, no `input` wrapper) — spread the bag alongside reason to match.
        const bag = result.input as Record<string, unknown>;
        log.append(failedName, correlationId, { ...bag, reason: result.reason }, failedEnvelope);
      }
    } else {
      await logOutput(log, nodeDef.output, result, correlationId, envelope);
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
