# Instance retention and iteration

Status: implemented.

## Motivation

`open-questions.md` records a verified gap: `runtime.ts`'s `fired = new Set<string>()` is keyed by bare node name, so a node appearing twice in a topology fires once, and `assess → collect → assess` is unbuildable except by hand-unrolling node names. That entry names the `fired` Set as the culprit. Reading the code shows it is the *second* problem, not the first.

**`InMemoryLog` keeps one instance per `(edgeName, correlationId)` and `append` overwrites.** There is no history and no per-instance identity. This is faithful to `design.md` §5, which specifies resolution as *"reading each named edge type's **latest instance** for the current `correlation_id`"* — the store implements the design rather than falling short of it. But latest-wins is what blocks iteration: given `tick`, the new value overwrites the old, leaving one mutable cell instead of `t` and `t+1`. The ambient mutable state the readme's opening line bans in node bodies has been sitting in the execution machinery.

So the candidate fix recorded in `open-questions.md` — re-key firing by consumed input edge-instance ids — presumes instances that are individually identified and retained. Today they are neither.

The framing that settles the shape (design-history.md, "Iteration: it's a Petri net, and the loop was never the missing piece"): `while` needs ambient state, recursion does not. A node emitting an instance that transitively feeds itself is already the recursive form, and `oneOf` already supplies the base case — emit the branch nothing routes back and the graph goes quiet. There is no loop construct to design. There is a log that has to stop clobbering.

## Scope

This is piece **(1)** of four, in dependency order:

1. **The log becomes a log** — this spec. Instance retention, identity, per-node consumption, fire-per-unconsumed readiness. On its own it makes single-input recursion run.
2. **Causation is real** — `causationIds` threaded through membrane, trace and log. Today a hardcoded `null`. Note that `envelope.step`, the *other* honest placeholder, is resolved here in piece (1) rather than there: under snapshot-wave scheduling it is just the pulse number (§6).
3. **`allOf` joins by lineage** — zip plus shared-ancestor key. Needs (1) and (2).
4. **Composite nodes** — topology-as-node, "enroll in workflow". Needs (1) **and (3)**: viewed from outside its membrane a topology *is* an `allOf` node, since its origin-shaped edges must all be satisfied together by one triggering event, so every composite entry point is `allOf`-shaped and inherits whatever (3) decides about joining (design-history.md, "Three axes and a clock"). (4) is not merely blocked on (1).

Each produces working, testable software alone. Nothing below implements (2), (3) or (4).

## Design

### 1. Instance identity and ordering: `id` and `seq`, both minted by the Log

```ts
export interface LoggedInstance {
  /** Stable identity for this instance, minted at append. What causation points at. */
  id: string;
  /** Monotonic within one Log, assigned at append. Write order, not causal position. */
  seq: number;
  payload: unknown;
  envelope?: InstanceEnvelope;
}
```

**Two fields, not one, and the split is the point.** An earlier draft had `seq` carrying identity and ordering together; designing piece (2) found that out. Causation is `causationIds: string[]` on an envelope, and those ids have to survive beyond one Log — the Trace persists conceptually and replay resolves against it — while a counter that restarts per Log collides across runs. So identity is a minted string and ordering is a local counter, and neither is asked to be the other.

Identity is not `envelope.id` either. That is the *invocation* id — shared by every branch an `allOf`-output node emits (`logOutput`'s own doc comment: "same `id` for every instance an `allOf`-output node emits"), and absent entirely on staged inputs and origin payloads, which have no invocation behind them.

`seq` is monotonic across the whole Log, not per edge type, which costs nothing and makes cross-edge ordering available to piece (3) without a format change. It is a logical clock in Lamport's sense — a total order consistent with causality — and deliberately *not* a coordinate in the causal structure (design-history.md, "Three axes and a clock"). `envelope.step` measures causal position; `seq` measures when something was written. Two tokens can agree on causal position across separate iterations and never share a `seq`, which is exactly why `seq` is right for "oldest unconsumed first" and wrong for lineage.

### 2. `append` retains; `latest` is unchanged

The backing map becomes `(edgeName, correlationId) → LoggedInstance[]`, appended to rather than overwritten.

```ts
export interface Log {
  /** Returns the new instance's `id`, so a caller can record what it produced. */
  append(edgeName: string, correlationId: string, payload: unknown, envelope?: InstanceEnvelope): string;
  latest(edgeName: string, correlationId: string): unknown | undefined;
  latestInstance(edgeName: string, correlationId: string): LoggedInstance | undefined;
  /** Every retained instance of this edge type for this correlation, oldest first. */
  instances(edgeName: string, correlationId: string): LoggedInstance[];
}
```

`latest` and `latestInstance` keep their exact current meaning — the most recently appended instance — so `design.md` §5's wording stays accurate and every existing reader is untouched. That matters because `membrane.ts`'s `allOf` resolution and `runtime.ts`'s `allOf` bag rebuild both call `latest`, and this spec deliberately does not change `allOf` behaviour.

`append` returns the minted `id`. Piece (1)'s own runtime does not need it — consumption is tracked against instances it *reads*, never ones it writes — but piece (2) does, since an invocation that emits a token must be able to say which token it emitted, and retrofitting a return type across every call site later is pure churn. Returning it now costs one word.

### 3. Consumption is tracked by the runtime, not the Log

`runNetlist` holds `Map<nodeName, Set<seq>>`. The Log retains and returns; it never learns what a node is.

`open-questions.md` already records that `Log` is doing two jobs under one interface (recording emissions, staging inputs). Teaching it about nodes would be a third, and would push the split further out of reach. Keeping consumption in the runtime also keeps it honestly run-scoped: a durable, resumable runtime has to persist it, and that belongs with the durable-execution work, not here.

### 4. Readiness is `(arc, unconsumed instance)` — not `(edge type, unconsumed instance)`

This is the part that does not fall out of "stop overwriting," and getting it wrong diverges on the project's canonical example.

Today `tryFire` reads `log.latest(nodeDef.input.edge.name, correlationId)` — by edge **name**. `wiring.feeds` drives queue order but never eligibility. That is harmless while each node fires once. Under fire-per-unconsumed-instance it is not: `birthday: Person → Person` emits a `Person`, observes a new unconsumed `Person`, and fires on its own output. `Person{41} | birthday | expect Person{42}` would run away to `{43}`, `{44}`, forever.

A Petri net does not work this way: arcs connect specific places to specific transitions, and a token is not eligible merely for having the right type. `wiring.feeds` is weir's arc set, and every emitted instance already records its producer in `envelope.node`.

**Rule.** For a `single`-input node `N` declaring edge `E`, an instance `i` of `E` is eligible when it is not already in `consumed[N]` and:

- `i.envelope` is present — `feeds[i.envelope.node]` contains `N`; or
- `i.envelope` is absent — eligible by type alone.

The second clause covers staged inputs (`invoke.ts:84`, readiness fixtures) and origin payloads: things injected from outside rather than produced by an arc, which is exactly what an absent envelope already means (`LoggedInstance`'s doc comment). It is two rules, but they track a real distinction rather than a convenience.

`birthday` therefore self-feeds only when the topology genuinely wires it back to itself — which is precisely when a loop is wanted. The canonical example is unaffected.

**Origin nodes** keep firing at most once per run, consuming their `originPayloads` entry. Tracked by a separate `originsFired: Set<string>`, since an origin payload is not a logged instance and has no `seq`. This has a sharp edge, discovered building it rather than anticipated here: a node that is both an origin and a `feeds` target can never iterate. The runtime checks `origins.has(nodeName)` first and always routes an origin straight to its once-only branch, so it is never offered instance candidates even when wiring genuinely feeds it. This matches prior (pre-this-spec) behaviour and is not a regression, but it means a test fixture that wants to exercise a self-feeding node needs a separate seed node upstream of it, not the origin doubling as the looped node. Recorded in `docs/open-questions.md`, not fixed here.

**Implementation note, not anticipated above: the pulse scan considers only reachable nodes.** "Every (node, eligible instance) pair" in §6 means every pair among the nodes the wiring actually reaches — the transitive closure of `wiring.feeds` from `wiring.origins` — not every node in `program.nodes`. Without that restriction, a node absent from the topology's wiring could still fire on a staged, envelope-less instance of its input edge (eligible by type alone, the second clause above), which is exactly the type-driven behaviour the arc rule exists to eliminate; it would also make a program's behaviour depend on which node definitions happen to be loaded rather than on its topology. `runtime.ts` computes this closure once per run and sorts it for reproducibility.

### 5. `allOf` is deliberately unchanged

A node with `input.kind === "allOf"` keeps today's behaviour exactly: resolve each declared edge by `latest`, fire at most once per run. It keeps a `firedAllOf: Set<string>` guard — the narrow remnant of the old global `fired` Set.

Joining is piece (3), and it needs lineage from piece (2). Designing a join here and replacing it two specs later would mean designing it twice. The cost of the deferral, stated plainly: an `allOf` node in a cycle still fires once, so iteration works for single-input chains only. That is the honest boundary of this piece.

**Implementation note, not anticipated above: `allOf` candidates are gated at snapshot time.** Joining itself is genuinely unchanged — still latest-wins resolution of each declared edge, still firing at most once per run, exactly as stated. What changed, and had to, is *when* a candidate is offered: the pulse loop offers an `allOf` node as a candidate only once every declared edge already has a `latest` instance as the current pulse's snapshot is taken, rather than leaving readiness entirely to `membrane()`'s own check at fire time. Without this, a fan-in node whose inputs first appeared during the current pulse could fire inside that same pulse and inherit that pulse's number as its own `step` — the same `step` its inputs carry, rather than one past the longest path feeding it, which is what the Testing section below requires. `membrane()` stays the authority on whether the firing actually happens (its own bag-presence check can still decline a snapshot-gated candidate); this only decides whether to offer one.

### 6. The driver becomes a pulse loop, snapshot per pulse

The origins-seeded queue and the child-pushing worklist are replaced by:

```
pulse = 0
firings = 0
loop:
  pulse += 1
  ready = every (node, eligible instance) pair, computed against the log AS IT STANDS NOW
  if ready is empty:
    return { failures, firings, pulses: pulse - 1, stopped: "quiescence" }
  for each pair in ready, in sorted node order:
    fire it at step = pulse; mark consumed; firings += 1
    if budget !== undefined && firings >= budget:
      return { failures, firings, pulses: pulse, stopped: "budget" }
```

**Snapshot semantics are the whole point.** `ready` is computed once per pulse, before any of it fires. Instances emitted during a pulse are therefore invisible until the next one. This is the pulse/wave model `design-history.md` settled long ago ("`every` lands; a pulse/wave model settles graph-level scheduling"), which `runtime.ts` currently approximates as a worklist *"without needing to number them"* — a shortcut that holds only while every node fires once. Once nodes fire repeatedly, the numbering stops being redundant and the wave has to be real.

Snapshotting is also what makes a self-feeding node safe without a special rule. It has one eligible instance when the pulse begins, so it fires once; the instance it emits belongs to the next pulse. No node can monopolize the scan, and no fairness heuristic is needed — an earlier draft of this spec invented a one-firing-per-node-per-round rule to solve a starvation problem that snapshotting does not have.

**`envelope.step` is the pulse number**, and that is why this matters beyond scheduling. A node fires in pulse N exactly when its inputs became available in pulse N-1, so the pulse counter *is* causal position within the topology — siblings of a fan-out share it, and the longest causal path determines it at a fan-in. `step` is a hardcoded `0` today; snapshot-wave gives it its real value here rather than in piece (2), because the scheduler already knows it.

Do not confuse `step` with `seq`. `step` is shared by everything in a pulse; `seq` is unique per instance, and many `seq` values occur within one pulse. `step` is a property of the program's shape and is identical on replay; `seq` is a property of one execution (design-history.md, "Three axes and a clock").

Node iteration within a pulse is **sorted by name** so a run is reproducible. Order within a pulse cannot change which nodes fire — that set was fixed by the snapshot — so sorting affects only `seq` assignment and the interleaving of appends, never the pulse's outcome. That is a stronger guarantee than the previous draft's, where scan order could change what became eligible mid-pass.

Node iteration is **sorted by name** so a run is reproducible. Sorting is for determinism, not correctness: a confluent graph reaches the same final instance set under any order, and weir does not guarantee confluence in general — two nodes consuming the same instances can interleave differently. Reproducibility is what is promised here; confluence is not.

### 7. `Run` and `Host` replace the parameter tail

`runNetlist` currently takes seven positional parameters and this would add an eighth.

```ts
export interface Run {
  correlationId: string;
  originPayloads: Record<string, unknown>;
  identity?: PayloadOf<typeof Identity>;
}

export interface Host {
  log: Log;
  trace?: Trace;
  /** Maximum firings before the run stops. Undefined means unbounded. */
  budget?: number;
}

export function runNetlist(program: Program, run: Run, host: Host): Promise<RunResult>;
```

The split is not arbitrary grouping. `Run` is what a trigger supplies — which run this is, what fired it, on whose behalf. `Host` is what the execution environment supplies — where instances live, where invocations are recorded, how much may be spent. Putting `budget` in `Host` makes the type encode the decision that bounding iteration belongs to the host rather than the language (design-history.md).

**Implementation note, not anticipated above: `Host` also carries `maxPulses`, defaulting to 10,000.**

```ts
export interface Host {
  log: Log;
  trace?: Trace;
  budget?: number;
  /** Maximum pulses before the run stops. Backstop, not a feature. */
  maxPulses?: number;
}
```

`budget` counts firings, so it cannot bound a pulse that fires nothing: a graph where every pulse offers a candidate but `membrane()`'s own check declines it every time would otherwise loop forever without a single firing to count. `maxPulses` is the backstop for exactly that case, and it returns `stopped: "budget"` when it trips, the same as the firing budget — both are the host declining to let the run continue, just triggered by a different counter. Bounded in pulses rather than wall-clock so it stays deterministic.

**`Host` is not `Zone`.** A zone (§7) is per-*node* — where a node executes, and what it is isolated from. A host is per-*run*. One run spans many zones, which is the whole premise of the client/server and PII-obfuscation-at-the-client open questions; naming this `Zone` would assert one zone per run and foreclose them. The two compose: the host supplies the run its log and budget, zones say which node runs where inside it.

`env` is avoided as a name — it collides with the envelope parameter node authors already receive.

### 8. `RunResult` reports why it stopped

```ts
export interface RunResult {
  /** Unchanged, including its "currently always empty" doc comment. */
  failures: { node: string; failed: Failed<InputSpec> }[];
  /** How many times any node's Fn was invoked this run. */
  firings: number;
  /** How many pulses ran. The last-fired node's `envelope.step` equals this. */
  pulses: number;
  stopped: "quiescence" | "budget";
}
```

A run that exhausts its budget is not a failure of any node, so it does not belong in `failures`; it is a property of the run. Tests pass a budget and assert `stopped`, so a runaway graph fails loudly instead of hanging the suite. `stopped: "budget"` covers both causes: the firing budget above, and `Host.maxPulses` — the backstop for a loop that spins while firing nothing, which the firing budget cannot see.

## Testing

- **Retention.** Two appends of the same edge type under one correlation both survive; `instances` returns them oldest-first; `latest` still returns the second.
- **`seq`.** Monotonic across edge types; distinct for two instances an `allOf`-output node emits from one invocation (the case `envelope.id` cannot distinguish).
- **The canonical example is unchanged.** `Person{41} | birthday | expect Person{42}` fires each node exactly once and stops on quiescence. This is the regression test for §4 — it fails with an unbounded run if readiness is by edge type.
- **A real cycle runs.** A topology wiring a node back to itself, whose `Fn` emits a continue-branch until a bound and then a terminal branch, runs the expected number of times and stops on quiescence. This is the capability the whole spec exists for.
- **Arc eligibility.** Two nodes emitting the same edge type into different consumers: each consumer sees only its own producer's instances.
- **Fan-out.** One instance consumed independently by two downstream nodes — both fire, neither starves the other.
- **Budget.** A node wired to itself that always emits the continue-branch stops with `stopped: "budget"` and the exact firing count, rather than hanging.
- **No starvation.** That same always-emitting node, running alongside an unrelated ready node, does not prevent the other from firing — snapshot semantics, not a fairness rule.
- **Snapshot isolation.** An instance emitted during pulse N is not consumed during pulse N. A node wired to itself fires exactly once per pulse, never draining its own output within one.
- **`step` is the pulse number.** Siblings of a fan-out share a `step`; a fan-in node's `step` is one past the longest path feeding it, not the shortest. A node firing on three queued instances from one fan-out produces three invocations at the *same* `step` — the case that distinguishes `step` from `seq`, which differs across all three.
- **Staged inputs.** An appended instance with no envelope is eligible by type, so existing `invoke.ts` readiness fixtures keep working.
- **`allOf` unchanged.** An `allOf` node in a cycle still fires once — asserted deliberately, so piece (3) has a test to change rather than a silent behaviour shift.

## Explicitly out of scope

- **`causationIds`** stay the hardcoded `null` they are today. Piece (2). `envelope.step` is the exception among the placeholders — §6 resolves it here.
- **`allOf` joining by lineage.** Piece (3). §5 above pins current behaviour in a test so the change is visible when it comes.
- **Composite nodes / "enroll in workflow".** Piece (4).
- **Positional identity in a topology** — `birthday.then.birthday.then.birthday` running three times. A separate `open-questions.md` entry; it terminates by construction rather than by quiescence, and needs `Wiring` to represent instances, which nothing here touches.
- **Durable or resumable consumption state.** Run-scoped, in memory, as today.
- **A precise worklist.** The pulse scan is deliberate; optimizing it must not change results, and must preserve snapshot semantics — a worklist that lets a pulse consume its own output is a different execution model, not a faster one.
- **Confluence guarantees.** Determinism is promised, confluence is not.
