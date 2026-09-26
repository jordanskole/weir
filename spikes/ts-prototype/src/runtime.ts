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
 * candidates — see the comment on that check for why the distinction is
 * kept even while the two are equivalent.
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
 * - **`allOf`-input nodes fire once per lineage group, not once per run.**
 *   The runtime gathers the unconsumed candidates for each declared edge
 *   (`eligibleForEdge`, the same arc rule a `single`-input node uses), asks
 *   `joinRows` which combinations belong together, and offers one candidate
 *   per row. A fan-out to several context nodes and a fan-in that assesses
 *   them together therefore works per item, which is the whole point:
 *   `firedAllOf` used to cap the fan-in at one firing, so it saw one item.
 *   That cap was deliberate while lineage did not exist — it does now
 *   (`lineage.ts`). Readiness still lands at snapshot time, since a row can
 *   only be built from instances already in the log, so an `allOf` node
 *   still fires in the pulse *after* its inputs appeared and its `step` is
 *   still one past the longest path feeding it.
 */

import { membrane } from "./membrane.js";
import type { InstanceEnvelope, InvocationContext, Log, LoggedInstance } from "./membrane.js";
import { joinRows } from "./lineage.js";
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
 * nodes' call shape (`nodeDef, bag, context` — the membrane no longer
 * resolves this bag itself; the runtime builds it and hands it in, same as
 * `AnySingleInvoke`'s payload one level down); `In` is erased here too.
 */
type AnySingleInvoke = (
  nodeDef: NodeDef,
  payload: unknown,
  context: InvocationContext,
) => Promise<{ result: unknown; envelope?: Envelope }>;
type AnyAllOfInvoke = (
  nodeDef: NodeDef,
  bag: Record<string, unknown>,
  context: InvocationContext,
) => Promise<{ result: unknown; envelope?: Envelope }>;

/**
 * One (node, input) pair a pulse may fire, as the snapshot found it.
 *
 * Which field is populated follows the node's InputSpec, not the caller's
 * convenience: a `single`-input node consumes one `instance` (absent for an
 * origin, whose payload comes from `originPayloads` and is not a logged
 * instance); an `allOf` node consumes a whole `row`, one instance per
 * declared edge, as chosen by `joinRows`. Modelled as two optional fields
 * rather than a discriminated union because `tryFire` already re-reads
 * `nodeDef.input.kind` — the real discriminant — to decide how to invoke.
 */
interface Candidate {
  nodeName: string;
  instance?: LoggedInstance;
  row?: Map<string, LoggedInstance>;
}

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

/**
 * The edge name the run root is logged under. Not a declared `.edge` today:
 * nothing references it from a `.node` file, and synthesizing it for every
 * program would add `Run` and `Failed_Run` to every edge table for no
 * current consumer. Promote it to a synthesized edge when something needs
 * to declare `input: Run`.
 */
export const RUN_ROOT_EDGE = "Run";

/** Generous enough that no correct run reaches it; small enough to fail a spin fast. See `Host.maxPulses`. */
const DEFAULT_MAX_PULSES = 10_000;

/**
 * Unconsumed instances of one edge that may fire one node, oldest first.
 *
 * The arc rule lives here rather than in either caller: a `single`-input
 * node asks about its one declared edge, an `allOf` node asks about each
 * of its declared edges in turn, and both want exactly the same answer.
 * Two copies would be two places for the rule to drift.
 */
export function eligibleForEdge(
  program: Program,
  log: Log,
  consumed: ReadonlySet<number>,
  nodeName: string,
  edgeName: string,
  correlationId: string,
): LoggedInstance[] {
  const consumers = (producer: string): string[] => program.wiring.feeds[producer] ?? [];
  return log.instances(edgeName, correlationId).filter((instance) => {
    if (consumed.has(instance.seq)) return false;
    const producer = instance.envelope?.node;
    if (producer === undefined) return true;
    return consumers(producer).includes(nodeName);
  });
}

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
  return eligibleForEdge(program, log, consumed, nodeDef.name, nodeDef.input.edge.name, correlationId);
}

export async function runNetlist(program: Program, run: Run, host: Host): Promise<RunResult> {
  const { correlationId, originPayloads, identity } = run;
  const { log, trace, budget, maxPulses = DEFAULT_MAX_PULSES } = host;

  // The run root: the external trigger represented as a token
  // (docs/superpowers/specs/2026-09-25-system-nodes-run-root-and-noop.md).
  // Appended before any node fires, so every origin output has something to
  // descend from and ancestry is total rather than partial. Deliberately
  // carries no envelope: an envelope records *an invocation*, and nothing
  // invoked this — `causationIds: []` would be true of the root rather than
  // the gap it used to be everywhere else. Deliberately does not carry the
  // trigger payload either: origin payloads already reach their nodes
  // through `originPayloads`, and copying them here would make the root's
  // shape depend on the program.
  const rootId = log.append(RUN_ROOT_EDGE, correlationId, {
    correlationId,
    triggeredAt: new Date().toISOString(),
  });

  const failures: RunResult["failures"] = [];
  const consumed = new Map<string, Set<number>>();
  const originsFired = new Set<string>();
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
   * Fires one candidate. A `single`-input node fires on one specific token —
   * *that* instance, not on whatever `log.latest` happens to hold by the time
   * it runs, which under iteration is a different thing entirely; `instance`
   * is absent for an origin node, whose payload comes from `originPayloads`
   * and is not a logged instance at all. An `allOf` node fires on one `row`:
   * the lineage group `joinRows` chose for it, one instance per declared
   * edge. The two are exclusive — `Candidate` carries whichever kind its
   * node's InputSpec calls for. Returns whether `Fn` actually ran: the
   * explicit `undefined` checks below can still decline a candidate this
   * function's caller offered, and quiescence is counted from this answer
   * rather than from the candidate list.
   */
  async function tryFire(
    { nodeName, instance, row }: Candidate,
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
      // `instance === undefined` means an origin node, whose payload came
      // from `originPayloads` rather than from the log. It cites the run
      // root: the trigger is what produced it.
      const causationIds = instance === undefined ? [rootId] : [instance.id];
      const invocation = await (membrane as AnySingleInvoke)(nodeDef, payload, {
        correlationId,
        identity,
        step: pulse,
        causationIds,
      });
      result = invocation.result;
      envelope = invocation.envelope;
    } else {
      // The bag and the causation both come from the row. The membrane no
      // longer resolves this bag itself (it only asserts it), and the row is
      // no longer latest-wins: `joinRows` chose these specific instances as
      // one lineage group, so reading `log.latest` here would silently
      // discard that choice and reintroduce exactly the cross-entity
      // mispairing the join exists to prevent. Causation is whoever resolved
      // the input recording what it consumed — the same rule the
      // `single`-input branch above follows, and the reason a row's
      // membership is recoverable from the log afterwards at all.
      if (row === undefined) return false;
      const bag: Record<string, unknown> = {};
      const causationIds: string[] = [];
      for (const edge of nodeDef.input.edges) {
        const instance = row.get(edge.name)!;
        bag[edge.name] = instance.payload;
        causationIds.push(instance.id);
      }
      input = bag;
      const invocation = await (membrane as AnyAllOfInvoke)(nodeDef, bag, {
        correlationId,
        identity,
        step: pulse,
        causationIds,
      });
      result = invocation.result;
      envelope = invocation.envelope;
    }

    // Mark what this firing consumed, now that it is known to have happened.
    // Every instance in the row, for an `allOf` node: consumption is what
    // stops the next pulse rebuilding the same group and firing it again,
    // now that nothing caps the node at one firing per run.
    if (nodeDef.input.kind !== "single") {
      for (const consumedInstance of row!.values()) consumedBy(nodeName).add(consumedInstance.seq);
    } else if (origins.has(nodeName)) originsFired.add(nodeName);
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
    const candidates: Candidate[] = [];
    for (const nodeName of scanned) {
      const nodeDef = program.nodes[nodeName];
      if (nodeDef.input.kind !== "single") {
        // An `allOf` node contributes one candidate per joined row. Gathering
        // is per *declared edge* — the same arc rule a `single`-input node
        // gets, so a node's own output is no more eligible for it here than
        // there — and `joinRows` decides which combinations across those
        // edges belong together. Both steps run against this pulse's
        // snapshot, which is what keeps `step` one past the longest path
        // feeding the node: a row can only be built from instances already
        // in the log, so a node whose inputs appeared during this pulse is
        // not offered until the next one. An incomplete group simply yields
        // no row, which is also how a group that never completes reaches
        // quiescence instead of spinning.
        const perEdge = new Map<string, LoggedInstance[]>();
        for (const edge of nodeDef.input.edges) {
          perEdge.set(
            edge.name,
            eligibleForEdge(program, log, consumedBy(nodeName), nodeName, edge.name, correlationId),
          );
        }
        for (const row of joinRows(log, perEdge)) {
          candidates.push({ nodeName, row });
        }
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
      const didFire = await tryFire(candidate, pulse);
      if (!didFire) continue;
      firedThisPulse += 1;
      firings += 1;
      if (budget !== undefined && firings >= budget) {
        return { failures, firings, pulses: pulse, stopped: "budget" };
      }
    }

    // Counting actual firings rather than candidates, even though the two
    // are currently equivalent: every `allOf` candidate carries the row it
    // will fire on, built by the snapshot, so `tryFire`'s `row === undefined`
    // check cannot decline one the scan produced, and nothing membrane does
    // is in the loop for readiness at all (it only asserts the bag `tryFire`
    // resolved). Kept anyway, deliberately, as a structural guard rather
    // than a currently-necessary one: a firing that declines after being
    // offered — a future rule re-checking the group at fire time, say —
    // would otherwise make an unsatisfiable candidate look like progress,
    // and a run that can never fire again would spin instead of reaching
    // quiescence.
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
