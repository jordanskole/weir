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
 * - **`Failed<In>` routing exists for every InputSpec kind.** A
 *   `single`-input node's failure logs under `failedEdgeName(inputEdge)`
 *   (`Failed_Todo` for a `Todo`-input node, synthesized automatically by
 *   `elaborate()`'s `synthesizeFailedEdges`); an `allOf`-input node's
 *   bag-shaped failure (`{A: ..., B: ...}`) logs under
 *   `failedAllOfEdgeName(edges)` (`Failed_A_B`, sorted and
 *   order-independent, synthesized by `synthesizeAllOfFailedEdges` for
 *   whichever combos are actually declared); a `gather`-input node's
 *   collection-shaped failure logs under
 *   `failedGatherEdgeName(gatheredEdge)` (`Failed_Many_Assessment`,
 *   synthesized by `synthesizeGatherFailedEdges` for whichever edges are
 *   actually gathered). All three route through the same readiness mechanism
 *   a downstream node declaring that edge as its own input already uses, no
 *   new mechanism needed (docs/design-history.md, "The runtime, built
 *   narrow on purpose... `Failed<In>` routing"). This list said "every
 *   InputSpec kind there is" while there were two; `gather` made it three,
 *   which is why the claim is now written as a property rather than a census.
 * - **`gather`-input nodes fire once per *barrier*.** The runtime offers the
 *   unconsumed candidates on the declared arc (`eligibleForEdge`, unchanged)
 *   to `gatherGroups`, which groups them by the `Many_*` collection token
 *   they descend from and reports the groups whose size matches that
 *   collection's entry count. A group that can no longer complete — some
 *   element has a `Failed_*` descendant — fires a failure instead of waiting,
 *   because a gather is `sequence` and a silent stall is the worse outcome
 *   (docs/superpowers/specs/2026-09-27-gather.md).
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

import { assertOutput, assertPayload, membrane } from "./membrane.js";
import type { InstanceEnvelope, InvocationContext, Log, LoggedInstance } from "./membrane.js";
import { outputEdgeNames } from "./elaborate.js";
import { gatherGroups, joinRows, selfAndAncestorIds } from "./lineage.js";
import type { GatherGroup } from "./lineage.js";
import type { Program } from "./implementation.js";
import type { AnyEdgeDef, Envelope, Failed, InputSpec, NodeDef, OutputSpec, PayloadOf } from "./types.js";
import { Identity, failedEdgeName, failedAllOfEdgeName, failedGatherEdgeName, inputEdgeNames, manyEdgeName } from "./types.js";
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
 * `AnyAllOfInvoke`'s shape exactly — one object argument — but named
 * separately because what the object *is* differs: a bag keyed by edge name
 * there, a collection keyed by the gathered edge's own `index` here. Two
 * names for one call shape, so a call site reads as the thing it is.
 */
type AnyGatherInvoke = AnyAllOfInvoke;

/**
 * One (node, input) pair a pulse may fire, as the snapshot found it.
 *
 * Which field is populated follows the node's InputSpec, not the caller's
 * convenience: a `single`-input node consumes one `instance` (absent for an
 * origin, whose payload comes from `originPayloads` and is not a logged
 * instance); an `allOf` node consumes a whole `row`, one instance per
 * declared edge, as chosen by `joinRows`; a `gather` node consumes a whole
 * `group`, every instance of one edge descended from one spread, as chosen by
 * `gatherGroups`. Modelled as optional fields rather than a discriminated
 * union because `tryFire` already re-reads `nodeDef.input.kind` — the real
 * discriminant — to decide how to invoke.
 */
interface Candidate {
  nodeName: string;
  instance?: LoggedInstance;
  row?: Map<string, LoggedInstance>;
  group?: GatherGroup;
}

/**
 * A node still waiting when the run stopped
 * (docs/superpowers/specs/2026-09-27-quiescence-is-not-success.md).
 *
 * `stopped: "quiescence"` with residue is a **stall**: nothing fired, and
 * something is waiting that nothing will ever deliver. `stopped: "budget"` with
 * residue is ordinary — a bounded run has unconsumed input by construction —
 * which is why the two are reported separately rather than collapsed into one
 * error flag.
 */
export interface Residue {
  /** The waiting node, keyed as `program.nodes` keys it — an inlined composite's inner node by *position*, so the name matches the wiring and the trace. */
  node: string;
  /** Which declared input edge the instances are waiting on. */
  edge: string;
  /**
   * How many unconsumed instances are eligible for it. A count, not the
   * instances: the log already holds those, and a `RunResult` that embedded
   * payloads would be a second copy of the thing that is supposed to be the
   * source of truth.
   */
  waiting: number;
}

/**
 * A declared end the run did not reach
 * (docs/superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md).
 */
export interface UnmetEnd {
  /** The root topology that declared it. */
  topology: string;
  /** The declared output edges no terminal produced. For a `oneOf` end, present only when *no* branch appeared. */
  missing: string[];
  /** The terminals that were supposed to produce them, for the error message. */
  terminals: string[];
}

export interface RunResult {
  /**
   * Nodes left holding eligible unconsumed input when the run stopped. Empty is
   * the healthy answer for a run that reached quiescence.
   *
   * Replaces a `failures` field that was always empty — the only InputSpec kind
   * whose failures landed there was removed long ago, and its comment said
   * deleting it would be "a separate public-API change". This is that change,
   * and the reason to take it now is that shipping a field named `failures`
   * beside one that reports the failure a run actually had would be worse than
   * the churn.
   */
  residue: Residue[];
  /**
   * Declared ends the run did not reach. Empty is the healthy answer, and also
   * the answer for a `Program` that declares no `ends` at all.
   *
   * Independent of `residue`, deliberately: a run can stall *and* miss its end,
   * or reach its end while leaving a side branch stranded, and the two
   * questions have different answers. Neither message replaces the other.
   */
  unmet: UnmetEnd[];
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
/**
 * Strips a payload to its declared fields on the way into the log, and reports
 * what it removed (docs/superpowers/specs/2026-09-29-drift-and-fork.md §2-§3).
 *
 * **Here rather than at the assertion sites**, which is a correction to the
 * spec's own framing. It put the strip on `assertPayload`'s callers — but a
 * *pure* node's output is never asserted at all (the acceptance gate covers it,
 * per 2026-09-27-effects-are-data.md), and stripping a node's *input* does not
 * clean the log, because the instance was written when it was produced. The one
 * place every instance of every output kind reaches the log is this function,
 * so this is the only place that makes the log's contents match the
 * declarations.
 *
 * A payload that fails assertion is logged **unchanged**. Asserting is not this
 * function's job — the membrane and the effect wrapper do it, and throwing here
 * would turn a reporting step into a second, later gate with worse messages.
 */
function stripForLog(
  edge: AnyEdgeDef | undefined,
  payload: unknown,
): { payload: unknown; undeclared: string[] } {
  if (edge === undefined) return { payload, undeclared: [] };
  const undeclared: string[] = [];
  try {
    return { payload: assertPayload(edge, payload, undeclared), undeclared };
  } catch {
    return { payload, undeclared: [] };
  }
}

/** The instance envelope, carrying whatever the strip removed. */
function withDrift(
  envelope: InstanceEnvelope | undefined,
  undeclared: string[],
): InstanceEnvelope | undefined {
  if (envelope === undefined || undeclared.length === 0) return envelope;
  return { ...envelope, undeclared };
}

async function logOutput(
  log: Log,
  output: OutputSpec,
  result: unknown,
  correlationId: string,
  envelope: Envelope | undefined,
): Promise<void> {
  if (output.kind === "single") {
    const clean = stripForLog(output.edge, result);
    log.append(
      output.edge.name,
      correlationId,
      clean.payload,
      withDrift(await instanceEnvelope(envelope, output.edge), clean.undeclared),
    );
    return;
  }

  if (output.kind === "many") {
    // Spread. The collection is logged as a token under a reserved name, and
    // each of its entries is logged as a real instance under the declared
    // edge name — see the spec
    // (docs/superpowers/specs/2026-09-26-spread-materializes-elements.md).
    //
    // Materializing is not an optimization detail, it is the feature. Firing
    // a downstream node N times against the one collection token would give
    // every element's descendants the *same* nearest common ancestor, so a
    // later fan-in would pair across elements — the exact mispairing
    // `joinRows` exists to prevent, reintroduced by the mechanism meant to
    // make per-element work possible. With real instances, two elements'
    // descendants have different nearest common ancestors (their own
    // elements) and the existing join separates them with no new machinery.
    //
    // Elements cite the *collection*, not what the producing invocation
    // consumed. Citing the invocation's own causation would make every
    // element a sibling at the same depth, which is the tighter of the two
    // ancestors and the one that makes element lineage nest.
    const schemaHash = await instanceEnvelope(envelope, output.edge);
    const collectionId = log.append(manyEdgeName(output.edge.name), correlationId, result, schemaHash);
    if (typeof result !== "object" || result === null || Array.isArray(result)) return;
    for (const entry of Object.values(result as Record<string, unknown>)) {
      const clean = stripForLog(output.edge, entry);
      log.append(
        output.edge.name,
        correlationId,
        clean.payload,
        schemaHash === undefined
          ? undefined
          : withDrift({ ...schemaHash, causationIds: [collectionId] }, clean.undeclared),
      );
    }
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
    const clean = stripForLog(edge, tagged.payload);
    log.append(
      tagged.edge,
      correlationId,
      clean.payload,
      withDrift(await instanceEnvelope(envelope, edge), clean.undeclared),
    );
    return;
  }
  const tags = result as { edge: string; payload: unknown }[];
  for (const tagged of tags) {
    // Same tradeoff as the oneOf lookup above.
    const edge = output.edges.find((e) => e.name === tagged.edge);
    const clean = stripForLog(edge, tagged.payload);
    log.append(
      tagged.edge,
      correlationId,
      clean.payload,
      withDrift(await instanceEnvelope(envelope, edge), clean.undeclared),
    );
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
  /**
   * The run this one was forked from, recorded on the `Run` root.
   *
   * Present only on a fork. The parent is never modified — the log is
   * append-only and the recorded run is the historical record of what actually
   * crossed the wire — so a fork is a second traversal, which is a second run
   * (docs/superpowers/specs/2026-09-29-drift-and-fork.md §4).
   */
  forkedFrom?: string;
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
  /**
   * Handlers for the program's declared effects, keyed by the name a
   * `.node`'s `effect:` field gives
   * (docs/superpowers/specs/2026-09-27-effects-are-data.md §2). An effect is
   * where nondeterminism legitimately enters: the runtime performs it, the
   * result is logged as an ordinary edge instance, and replay feeds that
   * record back rather than performing again.
   *
   * Checked against the program before pulse 1, not at fire time. A program
   * whose effects cannot be performed should not begin — discovering it
   * three pulses in leaves a half-written log, which is worse than a refused
   * start.
   */
  effects?: Record<string, (payload: unknown) => Promise<unknown> | unknown>;
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

/**
 * Re-exported rather than defined here, where it used to live: `gather` made
 * the `Many_` prefix a convention this module shares with `lineage.ts` and
 * with `failedGatherEdgeName`, so it moved to `types.ts` alongside
 * `failedEdgeName` and `failedAllOfEdgeName` — the other synthesized-name
 * conventions two modules have to agree on.
 */
export { manyEdgeName };

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
    // A *staged* instance is eligible by type alone: it was supplied from
    // outside rather than produced by an arc, so there is no producer to check
    // the wiring against. This used to key on `envelope === undefined`, which
    // also caught an emission whose envelope could not be built — the two
    // wanted opposite treatment, and a durable log made the ambiguity permanent
    // (2026-09-26-a-log-that-outlives-the-process.md §3).
    if (instance.staged === true) return true;
    const producer = instance.envelope?.node;
    // No envelope and not staged: a node emitted this and its provenance could
    // not be built (a bad `scope` declaration). Its producer is unknown, so the
    // arc rule cannot pass it — and it is left unconsumed rather than admitted
    // on a technicality, which `residue` now reports instead of swallowing.
    if (producer === undefined) return false;
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
  /**
   * The node's key in `program.nodes` and `wiring.feeds`, which is not always
   * `nodeDef.name`. An inlined composite's nodes are keyed by position
   * (`investigate/investigateIdentity`) while keeping their original `name`,
   * because `name` is in the contract hash and is the implementation
   * resolution path. The arc rule is about *position*, so it must use the
   * key; passing `name` here silently made every composite's inner nodes
   * ineligible, and the run reached quiescence having fired only the origin.
   */
  nodeName: string = nodeDef.name,
): LoggedInstance[] {
  if (nodeDef.input.kind !== "single") return [];
  return eligibleForEdge(program, log, consumed, nodeName, nodeDef.input.edge.name, correlationId);
}

/**
 * Resolves one external event into the per-origin payloads `runNetlist` takes
 * (docs/superpowers/specs/2026-09-28-a-topology-declares-its-beginning.md §3).
 *
 * `design.md` §5: *"there is exactly one call to the graph's outer membrane per
 * external event, and every origin-shaped edge it declares needing resolves
 * from that single payload at once."* The outer membrane is the **host**
 * boundary; `runNetlist` sits below it and receives already-resolved inputs. So
 * this lives beside the runtime rather than inside it, is a pure function of a
 * declaration and a value, and leaves `Run.originPayloads` untouched — which is
 * also why every hand-built `Program` in the test suite keeps working unchanged.
 *
 * For a `single` entry input the payload *is* the edge's payload, and every
 * origin declaring that edge gets it — which is the case `examples/recipe` has
 * been writing twice, once per origin, for as long as it has existed. For an
 * `allOf` entry the payload is a bag keyed by edge name, the same bag shape an
 * `allOf`-input node receives, so no new encoding is introduced.
 */
export function resolveTrigger(
  program: Pick<Program, "nodes" | "wiring" | "entries">,
  payload: unknown,
): Record<string, unknown> {
  const entries = program.entries ?? [];
  if (entries.length === 0) {
    throw new Error(
      `This program declares no topology entry, so there is nothing to resolve a trigger against. Supply originPayloads directly.`,
    );
  }

  /** Which edge each origin wants, and what the trigger holds for it. */
  const byEdge = new Map<string, unknown>();
  for (const entry of entries) {
    if (entry.input.kind === "single" || entry.input.kind === "gather") {
      byEdge.set(entry.input.edge.name, payload);
      continue;
    }
    const bag = (payload ?? {}) as Record<string, unknown>;
    for (const edge of entry.input.edges) {
      if (!(edge.name in bag)) {
        throw new Error(
          `Trigger is missing "${edge.name}" — topology "${entry.name}" declares input allOf ${entry.input.edges.map((e) => `"${e.name}"`).join(", ")}, so the payload is a bag keyed by edge name.`,
        );
      }
      byEdge.set(edge.name, bag[edge.name]);
    }
  }

  const resolved: Record<string, unknown> = {};
  for (const origin of program.wiring.origins) {
    const decl = program.nodes[origin];
    if (decl === undefined) continue;
    // An origin declares one edge at single multiplicity; `inputEdgeNames`
    // covers the other kinds for free rather than assuming.
    for (const edgeName of inputEdgeNames(decl.input)) {
      if (byEdge.has(edgeName)) resolved[origin] = byEdge.get(edgeName);
    }
  }
  return resolved;
}

export async function runNetlist(program: Program, run: Run, host: Host): Promise<RunResult> {
  const { correlationId, originPayloads, identity, forkedFrom } = run;
  const { log, trace, budget, maxPulses = DEFAULT_MAX_PULSES, effects = {} } = host;

  // Before anything is appended, including the run root: a program whose
  // effects cannot be performed should not begin.
  const unhandled = [
    ...new Set(Object.values(program.nodes).flatMap((n) => (n.effect === undefined ? [] : [n.effect]))),
  ].filter((name) => typeof effects[name] !== "function");
  if (unhandled.length > 0) {
    throw new Error(
      `No handler for effect(s) ${unhandled.map((e) => `"${e}"`).join(", ")}. ` +
        `Supply them as \`host.effects\` — an effect is performed by the runtime, not by a drafted implementation.`,
    );
  }

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
    // Present only on a fork. Cross-run ancestry, explicit and queryable,
    // without disturbing `log.instances(edge, correlationId)` — which every
    // reader in the system uses, and which a shared-run representation would
    // have broken (docs/superpowers/specs/2026-09-29-drift-and-fork.md §4).
    ...(forkedFrom !== undefined && { forkedFrom }),
  });

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
    { nodeName, instance, row, group }: Candidate,
    pulse: number,
  ): Promise<boolean> {
    const nodeDef = program.nodes[nodeName];

    let result: unknown;
    let envelope: Envelope | undefined;
    let input: unknown;
    /**
     * What an effect handler returned, before its result was asserted.
     *
     * Only ever set on the effect path, and only read when the invocation
     * failed — a successful one's `result` already *is* the raw value.
     */
    let rawEffectResult: unknown;
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
      const context = { correlationId, identity, step: pulse, causationIds, nodeName };
      // An effect node's behaviour is the host's handler. It still goes
      // through the membrane — the input is asserted, the output is asserted
      // against the declared edge, a throw becomes `Failed<In>`, and an
      // envelope is built — because a handler is host code and no more
      // trusted than a drafted `Fn`. What differs is only where the function
      // came from.
      const invocation =
        nodeDef.effect === undefined
          ? await (membrane as AnySingleInvoke)(nodeDef, payload, context)
          : await (membrane as AnySingleInvoke)(
              {
                ...nodeDef,
                // The handler is wrapped so its result is asserted against
                // the declared output edge before it can reach the log. A
                // drafted implementation's output is guaranteed by the
                // acceptance gate; an effect handler never passes through
                // it, so this is the only place the equivalent check can
                // live. A throw here becomes `Failed<In>` like any other,
                // which is why the wrap goes inside the membrane rather than
                // around it.
                fn: async (input: unknown) => {
                  const produced = await effects[nodeDef.effect!]!(input);
                  // Captured **before** asserting, so a rejected result is not
                  // erased by its own rejection. Without this the trace records
                  // the `Failed_X` payload and the shape the handler actually
                  // returned is recorded nowhere — not the log, not the trace —
                  // so there is nothing to re-validate against a widened
                  // declaration, which is exactly the run most worth forking
                  // (docs/superpowers/specs/2026-09-29-drift-and-fork.md §3).
                  rawEffectResult = produced;
                  assertOutput(nodeDef.output, produced);
                  return produced;
                },
              } as NodeDef,
              payload,
              context,
            );
      result = invocation.result;
      envelope = invocation.envelope;
    } else if (nodeDef.input.kind === "gather") {
      if (group === undefined) return false;
      const gatheredEdge = nodeDef.input.edge;
      // The collection is keyed by each member's own `index`, the same key
      // the spread that produced them used — a gather's payload is the shape
      // a `many` output produces, not a new one (design-history.md, "`many`
      // is a collection, keyed by index, not an array"). `index` is required
      // of a gathered edge at elaboration (`resolveInputSpec`); the fallback
      // exists only for a directly constructed `NodeDef` that skipped it, and
      // the membrane rejects that collection anyway rather than inventing a
      // key convention of its own.
      const collection: Record<string, unknown> = {};
      // The collection token first, then the members. Citing the barrier as
      // well as its contents is what puts the gather's output *downstream of
      // the spread* in lineage rather than merely downstream of N elements —
      // which is what a later reader needs to answer "which spread was this
      // the gather of". The members alone would give the same nearest common
      // ancestor, so this costs one id and buys a directly recorded answer.
      const causationIds: string[] = [group.collection.id];
      for (const member of group.members) {
        const payload = member.payload as Record<string, unknown>;
        collection[gatheredEdge.index === undefined ? member.id : String(payload[gatheredEdge.index])] = payload;
        causationIds.push(member.id);
      }
      input = collection;
      const invocation = await (membrane as AnyGatherInvoke)(
        // A dead group fires a *failure*, and it fires it through the
        // membrane rather than around it: wrapping `fn` so it throws reuses
        // the whole path — the envelope is built, the throw becomes
        // `Failed<In>` carrying the partial collection, the trace records the
        // attempt — instead of hand-assembling a failure instance that would
        // be the one failure in the system with no invocation behind it. Same
        // wrapping trick the effect branch above uses, for the same reason.
        group.dead
          ? ({
              ...nodeDef,
              fn: () => {
                throw new Error(
                  `gather of "${gatheredEdge.name}" can no longer complete: ` +
                    `${group.members.length} of ${group.size} arrived and an element failed. ` +
                    `A gather is \`sequence\`, so one element's failure is the whole result's ` +
                    `(docs/superpowers/specs/2026-09-27-gather.md §4).`,
                );
              },
            } as NodeDef)
          : nodeDef,
        collection,
        { correlationId, identity, step: pulse, causationIds, nodeName },
      );
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
        nodeName,
      });
      result = invocation.result;
      envelope = invocation.envelope;
    }

    // Mark what this firing consumed, now that it is known to have happened.
    // Every instance in the row, for an `allOf` node: consumption is what
    // stops the next pulse rebuilding the same group and firing it again,
    // now that nothing caps the node at one firing per run.
    if (nodeDef.input.kind === "allOf") {
      for (const consumedInstance of row!.values()) consumedBy(nodeName).add(consumedInstance.seq);
    } else if (nodeDef.input.kind === "gather") {
      // The whole group, *and the collection token itself*. The token is what
      // makes this total: an empty collection has no members, so consuming
      // only members would leave the barrier eligible every pulse and fire an
      // empty gather forever. The token is the barrier's identity, so
      // consuming it is what "this barrier has fired" means.
      consumedBy(nodeName).add(group!.collection.seq);
      for (const member of group!.members) consumedBy(nodeName).add(member.seq);
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
      // A failed effect records what the handler *returned*, not the failure
      // built from it. `fork` re-validates a recorded result against the
      // current declarations, and a run that failed assertion is the one whose
      // recorded result most needs to be the observed shape (spec §3, §5b).
      const recorded =
        rawEffectResult !== undefined && looksLikeFailed(result) ? rawEffectResult : result;
      trace?.record({ envelope, input, result: recorded });
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
          : nodeDef.input.kind === "gather"
            ? failedGatherEdgeName(nodeDef.input.edge.name)
            : failedAllOfEdgeName(nodeDef.input.edges);
      const failedEnvelope = await instanceEnvelope(envelope, program.edges[failedName]);
      if (nodeDef.input.kind === "single" || nodeDef.input.kind === "gather") {
        // Both are `{ input, reason }` already — nested, not flat. A gather's
        // `input` is the collection it was holding, which `Failed_Many_<X>`
        // declares as a `many` field (see `failedGatherEdgeName`), so the
        // shape the membrane produced is the shape the edge expects with no
        // reassembly.
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

  /**
   * Where a gather's barriers can be: the reserved collection name of every
   * `many` output the program declares. Derived from the nodes rather than
   * scanned for by prefix, so it names exactly the collections something in
   * this program can actually produce.
   *
   * Computed once, outside the loop, because it is a property of the program
   * rather than of the log.
   */
  const collectionEdgeNames = [
    ...new Set(
      Object.values(program.nodes).flatMap((node) =>
        node.output.kind === "many" ? [manyEdgeName(node.output.edge.name)] : [],
      ),
    ),
  ];

  /**
   * Every synthesized failure edge in the program — what a gather reads to
   * decide a group has died (spec §4). By prefix rather than by re-deriving
   * each name from the nodes, because a failure edge is synthesized for
   * *every* declared edge (`synthesizeFailedEdges`) plus each declared `allOf`
   * combo and gather, and the union of those is exactly "the names starting
   * with `Failed_`".
   */
  const failedEdgeNames = Object.keys(program.edges).filter((name) => name.startsWith(failedEdgeName("")));

  /**
   * Which nodes are still waiting, right now
   * (docs/superpowers/specs/2026-09-27-quiescence-is-not-success.md §2).
   *
   * The predicate is exactly `eligibleForEdge` returning something — the same
   * question the candidate scan asks every pulse, asked once more at the end.
   * What makes it usable is what it excludes *by construction* rather than by
   * special case: a terminal output (`Cookies`) and an unrouted `oneOf` branch
   * (a "not applicable" decision nothing consumes) are declared as input by
   * nobody, so no node is ever waiting on them. What is left is a node that
   * genuinely cannot proceed: a ragged `allOf` leftover whose partner never
   * arrived, or a `gather` group that never reached its barrier's count.
   *
   * Written over **every** input kind rather than narrowed to the multi-input
   * ones, even though only those can realistically populate it. A
   * `single`-input node with an eligible unconsumed instance at quiescence
   * should be impossible — the pulse loop would have offered it as a candidate
   * and fired it — so if one ever shows up here, the pulse loop dropped
   * something. Generality costs nothing and buys that invariant.
   */
  /**
   * For each edge, the *other* edges of the same `oneOf` output — the branches
   * a producer chose between.
   *
   * Half of the branch rule below; the log supplies the other half. Read off
   * the declarations, so it costs one pass and is exact: `oneOf` is right there
   * in the producing node's output spec.
   */
  const oneOfSiblings = new Map<string, string[]>();
  for (const node of Object.values(program.nodes)) {
    if (node.output.kind !== "oneOf") continue;
    const names = node.output.edges.map((edge) => edge.name);
    for (const name of names) {
      const seen = oneOfSiblings.get(name) ?? [];
      oneOfSiblings.set(name, [...new Set([...seen, ...names.filter((other) => other !== name)])]);
    }
  }

  /** Does any instance of `edgeName` descend from `instanceId` (or is it that instance)? */
  const inLineageOf = (edgeName: string, instanceId: string): boolean =>
    log
      .instances(edgeName, correlationId)
      .some((candidate) => selfAndAncestorIds(log, candidate.id).has(instanceId));

  /**
   * **Is this held instance explained by a branch that was not taken?**
   *
   * A node whose sibling arm came from a `oneOf` holds its other arm forever
   * when the producer chose the other branch — and that is the correct
   * behaviour of a correct program, not a stall. Routing to one of N handlers
   * is the most ordinary branching topology there is, and every instance of it
   * in weir exited non-zero before this
   * (docs/open-questions/branching-makes-every-run-red.md).
   *
   * **Per lineage group, not per node pair**, which is the part that took a
   * second fixture to see. Put a spread above the branch and *both* joins fire
   * correctly while both still hold the other element's token — so neither node
   * is "the loser", and a node-level exclusivity rule has nothing to key on.
   * The question is asked of one held instance at a time: for *this* token, did
   * the producer route the missing edge's sibling instead?
   *
   * Deliberately strict in two ways, because the check this suppresses is the
   * one that catches real stalls:
   *
   * - **Every** absent edge must be explained. A node missing both a
   *   branch-not-taken *and* an arm that genuinely never arrived is still
   *   stalled, and `some` rather than `every` would hide it.
   * - At least one edge must actually be absent. If everything this node needs
   *   is present in this token's lineage and it still did not fire, that is a
   *   pulse-loop bug and must stay visible.
   */
  const explainedByBranch = (nodeName: string, heldEdge: string, instanceId: string): boolean => {
    const others = inputEdgeNames(program.nodes[nodeName].input).filter((name) => name !== heldEdge);
    const absent = others.filter((other) => !inLineageOf(other, instanceId));
    if (absent.length === 0) return false;
    return absent.every((missing) =>
      (oneOfSiblings.get(missing) ?? []).some((sibling) => inLineageOf(sibling, instanceId)),
    );
  };

  const residueNow = (): Residue[] => {
    const found: Residue[] = [];
    for (const nodeName of scanned) {
      for (const edgeName of inputEdgeNames(program.nodes[nodeName].input)) {
        const eligible = eligibleForEdge(
          program,
          log,
          consumedBy(nodeName),
          nodeName,
          edgeName,
          correlationId,
        );
        const waiting = eligible.filter(
          (instance) => !explainedByBranch(nodeName, edgeName, instance.id),
        ).length;
        if (waiting > 0) found.push({ node: nodeName, edge: edgeName, waiting });
      }
    }
    return found;
  };

  /**
   * Which declared ends the run failed to reach
   * (docs/superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md §2).
   *
   * **An instance of the declared output, produced by a declared terminal.**
   * Both halves are load-bearing. Asking only "does an instance of this edge
   * exist" is a false green for any topology whose nodes are rhombus-shaped:
   * `examples/todo-list` has two nodes producing `TodoList`, so an
   * *intermediate* one from `startList` would satisfy an end that `startList`
   * has nothing to do with. `envelope.node` records the producer, so naming
   * the terminal makes the question instance-level rather than type-level.
   *
   * A `oneOf` end is met by **one** branch, which is what `oneOf` means
   * everywhere else; `single` and `allOf` need all of theirs. Note this is a
   * check on the *output*, never on "every terminal fired" — under `oneOf`
   * exactly one terminal fires by construction, so the stricter rule would
   * reject `examples/person-birthday` on its first run.
   */
  const unmetNow = (): UnmetEnd[] => {
    const out: UnmetEnd[] = [];
    for (const end of program.entries ?? []) {
      const terminals = new Set(end.terminals);
      const producedByTerminal = (edgeName: string): boolean =>
        log
          .instances(edgeName, correlationId)
          .some((instance) => instance.envelope !== undefined && terminals.has(instance.envelope.node));

      const declared = outputEdgeNames(end.output);
      const missing = declared.filter((name) => !producedByTerminal(name));
      // `oneOf` is satisfied by any one branch, so it is unmet only when every
      // branch is missing.
      const unmet = end.output.kind === "oneOf" ? (missing.length === declared.length ? missing : []) : missing;
      if (unmet.length > 0) out.push({ topology: end.name, missing: unmet, terminals: end.terminals });
    }
    return out;
  };

  /** One place the three exits agree on what a `RunResult` is, so a new exit cannot forget either scan. */
  const finish = (stopped: RunResult["stopped"], pulses: number): RunResult => ({
    residue: residueNow(),
    unmet: unmetNow(),
    firings,
    pulses,
    stopped,
  });

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
      if (nodeDef.input.kind === "gather") {
        // A gather contributes one candidate per barrier that may fire.
        // `eligibleForEdge` supplies the candidates on exactly the same terms
        // a `single`-input node gets them — the arc rule is unchanged, so a
        // gather is no more able to eat its own output than anything else —
        // and `gatherGroups` decides which of them constitute a complete (or
        // dead) group. Collections are read straight from the log rather than
        // through `eligibleForEdge`: a collection token is not on an arc *to*
        // this node, it is the barrier the candidates descend from, and
        // "which barrier does this belong to" is a lineage question rather
        // than an arc one. `consumedBy` still filters it, which is what stops
        // a fired barrier re-forming.
        const eaten = consumedBy(nodeName);
        candidates.push(
          ...gatherGroups(
            log,
            collectionEdgeNames.flatMap((edgeName) =>
              log.instances(edgeName, correlationId).filter((collection) => !eaten.has(collection.seq)),
            ),
            eligibleForEdge(program, log, eaten, nodeName, nodeDef.input.edge.name, correlationId),
            failedEdgeNames.flatMap((edgeName) => log.instances(edgeName, correlationId)),
          ).map((group) => ({ nodeName, group })),
        );
        continue;
      }
      if (nodeDef.input.kind === "allOf") {
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
      for (const instance of eligibleInstances(program, log, consumedBy(nodeName), nodeDef, correlationId, nodeName)) {
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
        return finish("budget", pulse);
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
      return finish("quiescence", pulse - 1);
    }

    // The pulse backstop (see `Host.maxPulses`). Distinct from the firing
    // budget above, which cannot bound a pulse that fires nothing.
    if (pulse >= maxPulses) {
      return finish("budget", pulse);
    }
  }
}
