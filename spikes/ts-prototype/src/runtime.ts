/**
 * The runtime (docs/getting-started.md step 5): walks a `Program`'s
 * `wiring` in pulse order, calling each node through `membrane()` and
 * appending successful results to the `Log`. Implements the pulse/wave
 * model design-history.md already decided ("`every` lands; a pulse/wave
 * model settles graph-level scheduling") as real, numbered pulses. Each
 * pulse computes every (node, eligible instance) pair — over the nodes the
 * wiring actually reaches — against the log *as it stands*, then fires all
 * of them; instances emitted during a pulse are invisible until the next
 * one. It is a Petri net: edges are places, nodes
 * are transitions, an edge instance is a token, and `wiring.feeds` is the
 * arc set that says which tokens a transition may consume
 * (`eligibleInstances`).
 *
 * That snapshot is load-bearing twice over. It is why `envelope.step` is
 * simply the pulse number — a node fires in pulse N exactly when its input
 * became available in pulse N-1 — and it is why a node wired back to itself
 * fires once per pulse instead of draining its own output within one, with
 * no fairness rule needed. An earlier worklist stood in for this while every
 * node fired at most once; once nodes fire repeatedly the numbering stops
 * being redundant and the wave has to be real.
 *
 * The loop ends on quiescence (a pulse in which nothing fired) or on the
 * host's `budget` (a firing count). Quiescence counts *firings*, not
 * candidates: an `allOf` node is a candidate on every pulse until it fires,
 * and `membrane()`'s own readiness check may decline it on all of them.
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
 * - **A node fires once per unconsumed instance arriving on an arc wired to
 *   it**, so a topology wiring a node back to itself iterates until it
 *   emits a branch nothing routes back (`oneOf` supplies the base case).
 *   What that does *not* give you is positional repetition: a hand-authored
 *   `.topology` chain like `birthday.then.birthday.then.birthday` still runs
 *   `birthday` as one node, because `.topology`'s adjacency-list `Wiring`
 *   collapses to a flat parent→children map that cannot represent "the
 *   second birthday" at all (docs/open-questions.md). Termination there
 *   would be by construction; here it is by quiescence, with the host's
 *   `budget` as the backstop for a graph that never reaches it.
 * - **`allOf`-input nodes still fire at most once per run** (`firedAllOf`,
 *   the narrow remnant of the old global `fired` set), resolving their bag
 *   by `latest` as before. What did change is *when* they are offered: an
 *   `allOf` node is a candidate only once every edge it declared has a
 *   `latest` at snapshot time, so like every other node it fires in the
 *   pulse *after* its inputs appeared and its `step` is one past the longest
 *   path feeding it. Joining by lineage is a later spec and needs
 *   causation, which does not exist yet; iteration therefore works for
 *   single-input chains only. That is the honest boundary.
 */

import { membrane } from "./membrane.js";
import type { InstanceEnvelope, InvocationContext, Log, LoggedInstance } from "./membrane.js";
import type { Program } from "./implementation.js";
import type { AnyEdgeDef, Envelope, Failed, InputSpec, NodeDef, OutputSpec, PayloadOf } from "./types.js";
import { Identity, failedEdgeName, failedAllOfEdgeName } from "./types.js";
import { hashEdge } from "./hash.js";
import type { Trace } from "./trace.js";

/**
 * `program.nodes` stores heterogeneous NodeDefs in one `Record<string,
 * NodeDef>`, erasing each node's own literal `In`/`O` to the generic
 * default. `membrane()`'s argument and return types are a conditional on
 * `In`, which TS can't resolve from that erased generic even after
 * `nodeDef.input.kind` has been checked at the value level — a real TS
 * narrowing limitation, not a genuine call-shape ambiguity (checked at
 * runtime by the `kind` branch itself). These two aliases name the cast
 * instead of hiding it. `AnyAllOfInvoke` names the cast for `allOf`-input
 * nodes' call shape (`nodeDef, log, context`); `In` is erased here too.
 */
type AnySingleInvoke = (
  nodeDef: NodeDef,
  payload: unknown,
  context: InvocationContext,
) => Promise<{ result: unknown; envelope?: Envelope }>;
type AnyAllOfInvoke = (
  nodeDef: NodeDef,
  log: Log,
  context: InvocationContext,
) => Promise<{ result: unknown; envelope?: Envelope } | undefined>;

export interface RunResult {
  /** Currently always empty — the only InputSpec kind whose failures ever landed here (the removed `any` kind) no longer exists. Retained rather than removed, since deleting it would be a separate public-API change. */
  failures: { node: string; failed: Failed<InputSpec> }[];
  /** How many times any node's Fn was invoked this run. */
  firings: number;
  /** How many pulses ran. */
  pulses: number;
  /** Why the run ended: nothing left to fire, or the host's budget was spent. */
  stopped: "quiescence" | "budget";
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
 * §5). `undefined` when there's no edge to hash against (see `logOutput`'s
 * `oneOf` lookup and `tryFire`'s failure path — a missing synthesized edge,
 * an elaborator concern, not something worth failing a run over); this is
 * the common case in day-to-day operation. `undefined` also, separately,
 * when `envelope` itself is absent — `membrane.ts`'s `Invocation.envelope`
 * is optional precisely because `buildEnvelope` can throw on a bad `scope`
 * declaration (see `tryFire`'s comment above its own `envelope` check), and
 * a node with such a declaration reaches this function with `envelope`
 * genuinely `undefined`. This check is load-bearing, not defensive
 * boilerplate: without it, `{ ...envelope, schemaHash }` would spread
 * `undefined` into `{}` and silently mint a corrupt `InstanceEnvelope`
 * missing every real field (`id`, `correlationId`, `node`, …) instead of
 * cleanly logging with no envelope at all. Covered by
 * `runtime.test.ts`'s "a bad scope declaration" tests.
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
    // `find` returns undefined for a tag not among the declared edges —
    // `Tagged<E>` makes that type-unreachable from a well-behaved Fn, so
    // only a buggy one can land here. `instanceEnvelope` then returns
    // undefined too, and the instance logs with no envelope: provenance-free,
    // indistinguishable from a genuinely staged input (`membrane.ts`'s
    // `LoggedInstance` doc comment). Accepted rather than thrown — failing
    // an entire run over one node's bad tag would be the wrong trade.
    const edge = output.edges.find((e) => e.name === tagged.edge);
    log.append(tagged.edge, correlationId, tagged.payload, await instanceEnvelope(envelope, edge));
    return;
  }
  const tags = result as { edge: string; payload: unknown }[];
  for (const tagged of tags) {
    // Same tradeoff as the oneOf lookup above.
    const edge = output.edges.find((e) => e.name === tagged.edge);
    log.append(tagged.edge, correlationId, tagged.payload, await instanceEnvelope(envelope, edge));
  }
}

/**
 * What a trigger supplies: which run this is, what fired it, on whose
 * behalf. Paired with `Host` (what the execution environment supplies) so
 * `runNetlist` takes three parameters rather than eight.
 */
export interface Run {
  correlationId: string;
  originPayloads: Record<string, unknown>;
  identity?: PayloadOf<typeof Identity>;
}

/**
 * What the execution environment supplies: where instances live, where
 * invocations are recorded, and how much may be spent.
 *
 * `budget` lives here rather than in `Run` because bounding iteration is
 * the host's job, not the language's (design-history.md, "Iteration: it's
 * a Petri net"). Undefined means unbounded, which is the honest
 * run-to-quiescence semantics; a hosted runtime passes one because that is
 * where multi-tenancy and billing live.
 *
 * Deliberately not called `Zone`. A zone (design.md §7) is per-*node* —
 * where a node executes — and one run spans many. This is per-*run*.
 */
export interface Host {
  log: Log;
  trace?: Trace;
  budget?: number;
  /**
   * Maximum *pulses* before the run stops, defaulting to
   * `DEFAULT_MAX_PULSES`. A backstop, not a feature: `budget` counts
   * firings, so a loop that spins while firing nothing is unbounded by
   * construction, and that hole is invisible exactly while the quiescence
   * check is correct. A regression there should fail a suite, not wedge it —
   * an await loop that fires nothing starves the macrotask queue a test
   * timeout lives on, so it hangs rather than timing out. Bound in pulses
   * rather than wall-clock so it stays deterministic.
   */
  maxPulses?: number;
}

/** Generous enough that no correct run reaches it; small enough to fail a spin fast. See `Host.maxPulses`. */
export const DEFAULT_MAX_PULSES = 10_000;

/**
 * Which instances a `single`-input node may fire on right now.
 *
 * Readiness is `(arc, unconsumed instance)`, not `(edge type, unconsumed
 * instance)`, and the difference is load-bearing. `tryFire` used to
 * resolve input by edge *name* alone, with `wiring.feeds` driving only
 * queue order. That was harmless while every node fired once; under
 * fire-per-unconsumed-instance it diverges, because `birthday: Person →
 * Person` would observe its own output as a new unconsumed `Person` and
 * run away on the project's canonical example.
 *
 * A Petri net does not work that way: arcs connect specific places to
 * specific transitions, and a token is not eligible merely for having the
 * right type. `wiring.feeds` is weir's arc set, and every emitted instance
 * already records its producer in `envelope.node`.
 *
 * An instance with no envelope is eligible by type alone. That is not a
 * loophole — an absent envelope already means "staged or injected from
 * outside rather than produced by an arc" (see `LoggedInstance`), which is
 * exactly the case that has no producer to check.
 */
export function eligibleInstances(
  program: Program,
  log: Log,
  consumed: ReadonlySet<number>,
  nodeDef: NodeDef,
  correlationId: string,
): LoggedInstance[] {
  if (nodeDef.input.kind !== "single") return [];
  const consumers = (producer: string): string[] => program.wiring.feeds[producer] ?? [];
  return log.instances(nodeDef.input.edge.name, correlationId).filter((instance) => {
    if (consumed.has(instance.seq)) return false;
    const producer = instance.envelope?.node;
    if (producer === undefined) return true;
    return consumers(producer).includes(nodeDef.name);
  });
}

export async function runNetlist(program: Program, run: Run, host: Host): Promise<RunResult> {
  const { correlationId, originPayloads, identity } = run;
  const { log, trace, budget, maxPulses = DEFAULT_MAX_PULSES } = host;
  const failures: RunResult["failures"] = [];
  const consumed = new Map<string, Set<number>>();
  const originsFired = new Set<string>();
  const firedAllOf = new Set<string>();
  const origins = new Set(program.wiring.origins);

  /** The seqs `nodeName` has already eaten. Per node, never global: two nodes consuming the same instance each get their own turn at it (the fan-out case). */
  const consumedBy = (nodeName: string): Set<number> => {
    let seen = consumed.get(nodeName);
    if (!seen) {
      seen = new Set();
      consumed.set(nodeName, seen);
    }
    return seen;
  };

  /**
   * Fires one (node, instance) pair. `instance` is the specific token this
   * firing consumes — a `single`-input node fires on *that* instance, not on
   * whatever `log.latest` happens to hold by the time it runs, which under
   * iteration is a different thing entirely. It is absent for an origin node
   * (its payload comes from `originPayloads`, which is not a logged instance
   * and has no `seq`) and for an `allOf` node (membrane resolves that bag
   * itself). Returns whether `Fn` actually ran: `membrane()`'s own readiness
   * check can still decline an `allOf` candidate, and quiescence is counted
   * from this answer rather than from the candidate list.
   */
  async function tryFire(
    nodeName: string,
    instance: LoggedInstance | undefined,
    pulse: number,
  ): Promise<boolean> {
    const nodeDef = program.nodes[nodeName];

    let result: unknown;
    let envelope: Envelope | undefined;
    let input: unknown;
    if (nodeDef.input.kind === "single") {
      let payload: unknown;
      if (origins.has(nodeName)) {
        if (!(nodeName in originPayloads)) return false;
        payload = originPayloads[nodeName];
      } else {
        if (instance === undefined) return false;
        payload = instance.payload;
      }
      input = payload;
      const causationIds = instance === undefined ? [] : [instance.id];
      const invocation = await (membrane as AnySingleInvoke)(nodeDef, payload, {
        correlationId,
        identity,
        step: pulse,
        causationIds,
      });
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
      const invocation = await (membrane as AnyAllOfInvoke)(nodeDef, log, { correlationId, identity, step: pulse });
      if (invocation === undefined) return false;
      result = invocation.result;
      envelope = invocation.envelope;
    }

    // Mark what this firing consumed, now that it is known to have happened.
    if (nodeDef.input.kind !== "single") firedAllOf.add(nodeName);
    else if (origins.has(nodeName)) originsFired.add(nodeName);
    else if (instance !== undefined) consumedBy(nodeName).add(instance.seq);

    // `envelope` is present for every well-declared attempt now —
    // `membrane()` builds it before asserting the input (2026-09-24), so a
    // rejected input records a trace entry too, not only a completed `Fn`
    // run. `Invocation.envelope` (membrane.ts) stays optional, though, and
    // the only way `envelope` is still `undefined` here is `buildEnvelope`
    // itself throwing (a bad `scope` declaration) — a declaration bug with
    // nothing built to attach. This guard is what keeps that case from
    // recording a trace entry with no envelope, which would be worse than
    // recording none at all — not dead code left over from before the
    // reordering; delete it and a bad-scope node's firing corrupts the
    // trace instead of being cleanly excluded from it. Covered by
    // `runtime.test.ts`'s "a bad scope declaration" tests.
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

  // The pulse loop scans the wiring rather than `program.nodes`, so a
  // `wiring` naming a node no `.node` file declares would otherwise be
  // ignored rather than reported. Checked once here, up front, instead of on
  // every attempted firing.
  for (const nodeName of [...program.wiring.origins, ...Object.values(program.wiring.feeds).flat()]) {
    if (!(nodeName in program.nodes)) {
      throw new Error(`Wiring references "${nodeName}", but no .node file declares it.`);
    }
  }

  /**
   * Which nodes this run may fire: the transitive closure of `wiring.feeds`
   * from `wiring.origins`, computed once. Cycles are the point of this spec,
   * so the visited set is what terminates it.
   *
   * Scanning every entry in `program.nodes` instead would let a node that
   * appears nowhere in the topology fire, since `eligibleInstances` treats an
   * envelope-less instance as eligible by type (`§4`, second clause) and a
   * node with no incoming arc has nothing else to filter on. That bypass
   * exists for *staged or injected* inputs — `invoke.ts`, readiness fixtures
   * — not to let an unwired node self-start off a type match, which is the
   * type-soup behaviour arc-based readiness exists to eliminate. Restricting
   * the scan also keeps a program's behaviour a function of its topology
   * rather than of which node definitions happen to be in the map.
   */
  const reachable = new Set<string>();
  const frontier = [...program.wiring.origins];
  while (frontier.length > 0) {
    const nodeName = frontier.pop()!;
    if (reachable.has(nodeName)) continue;
    reachable.add(nodeName);
    for (const child of program.wiring.feeds[nodeName] ?? []) frontier.push(child);
  }
  /** Sorted, so a run is reproducible — order within a pulse cannot change *which* nodes fire (the snapshot fixed that), only `seq` assignment and the interleaving of appends. */
  const scanned = [...reachable].sort();

  let firings = 0;
  let pulse = 0;

  for (;;) {
    pulse += 1;

    // The snapshot. Every candidate is computed against the log as it
    // stands now, so an instance emitted during this pulse is invisible
    // until the next one. That is what makes `step` equal the pulse
    // number, and what stops a self-feeding node draining its own output
    // inside one pulse without needing a fairness rule.
    const candidates: { nodeName: string; instance?: LoggedInstance }[] = [];
    for (const nodeName of scanned) {
      const nodeDef = program.nodes[nodeName];
      if (nodeDef.input.kind !== "single") {
        if (firedAllOf.has(nodeName)) continue;
        // `allOf` readiness is evaluated *here*, against the same snapshot
        // every other candidate is computed against, rather than left
        // entirely to membrane's fire-time check. Otherwise a node whose
        // inputs only appeared during this pulse fires inside it and takes
        // that pulse's number as its `step` — the same `step` its own inputs
        // carry, when §8 requires one past the longest path feeding it.
        // membrane's check stays where it is and stays the authority on
        // whether the firing happens; this only decides whether to offer it.
        // Resolution is still latest-wins and firing is still at most once
        // per run (§5) — neither is touched.
        const ready = nodeDef.input.edges.every(
          (edge) => log.latest(edge.name, correlationId) !== undefined,
        );
        if (ready) candidates.push({ nodeName });
        continue;
      }
      if (origins.has(nodeName)) {
        if (!originsFired.has(nodeName) && nodeName in originPayloads) {
          candidates.push({ nodeName });
        }
        continue;
      }
      for (const instance of eligibleInstances(program, log, consumedBy(nodeName), nodeDef, correlationId)) {
        candidates.push({ nodeName, instance });
      }
    }

    let firedThisPulse = 0;
    for (const candidate of candidates) {
      const didFire = await tryFire(candidate.nodeName, candidate.instance, pulse);
      if (!didFire) continue;
      firedThisPulse += 1;
      firings += 1;
      if (budget !== undefined && firings >= budget) {
        return { failures, firings, pulses: pulse, stopped: "budget" };
      }
    }

    // Counting actual firings rather than candidates, even though the two
    // are currently equivalent: the `allOf` snapshot gate above (`ready`)
    // uses the same `latest !== undefined` predicate membrane's own
    // readiness check uses, so `tryFire` can no longer return `false` and
    // an empty candidate list is exactly when nothing fires. Kept anyway,
    // deliberately, as a structural guard rather than a currently-necessary
    // one: a future readiness rule that diverges from membrane's own check
    // — the gate above and membrane's check drifting out of sync — could
    // reintroduce a declined-but-offered candidate, and counting firings
    // rather than candidates is what keeps quiescence correct if that ever
    // happens again.
    if (firedThisPulse === 0) {
      return { failures, firings, pulses: pulse - 1, stopped: "quiescence" };
    }

    // The pulse backstop (see `Host.maxPulses`). Distinct from the firing
    // budget above, which cannot bound a pulse that fires nothing.
    if (pulse >= maxPulses) {
      return { failures, firings, pulses: pulse, stopped: "budget" };
    }
  }
}
