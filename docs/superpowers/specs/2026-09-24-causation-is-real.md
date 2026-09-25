# Causation is real

Status: implemented.

## Motivation

`Envelope.causationId` is a hardcoded `null` (`membrane.ts`'s `buildEnvelope`), and has been since the envelope existed. `design.md` §1 lists `causation_id` among the envelope's fields as though it were populated. The replay spec named it explicitly out of scope. So the field is a promise the code has never kept, and the gap has already escaped the project — a GTM document written outside it asserted that causal-chain tracking is "core, already built", which is what a reader concludes from a worked example showing it populated (that example is now corrected).

Beyond honesty, causation is a prerequisite: piece (3) joins an `allOf` node's inputs **by lineage** — the combination that fires is the one whose instances share an ancestor — and lineage is unwalkable without it.

This is piece **(2)** of four (design-history.md, "Iteration: it's a Petri net"):

1. **The log becomes a log** — built.
2. **Causation is real** — this spec.
3. **`allOf` joins by lineage** — needs (1) and (2).
4. **Composite nodes** — needs (1) and (3).

`envelope.step`, the *other* honest placeholder, was resolved in piece (1): under pulse scheduling it is the pulse number. Only causation remains.

## Design

### 1. `causationIds: string[]` replaces `causationId: string | null`

```ts
export interface Envelope {
  // …
  /**
   * The instances this invocation consumed. Empty for an origin — an
   * external event caused it, and an external event is not a token.
   * One entry for a `single`-input node. N for an `allOf` node, one per
   * declared input edge.
   */
  causationIds: string[];
  // …
}
```

Plural is not a generalization for its own sake. An `allOf` invocation genuinely consumes several tokens, and a singular field could only name one of them — losing lineage at precisely the fan-in nodes piece (3) exists to serve. Recording it wrong there would not fail loudly: a join keyed on corrupted lineage pairs tokens that never shared an ancestor and returns a confident wrong answer.

This is the project's OpenTelemetry analogue, with one deliberate difference worth stating because it is the interesting one: `traceId` → `correlationId`, `spanId` → `envelope.id`, `parentSpanId` → `causationIds`. A span has one parent; an `allOf` invocation has N.

**`design.md` §1 must be updated** — it currently lists `causation_id`, singular.

### 2. Whoever resolved the input records what it consumed

The two input kinds know different things, and a uniform answer would make one of them guess.

- **`single`** — the runtime selects the instance and passes only its *payload* to the membrane, which never learns which instance it came from. Only the runtime knows `instance.id`, so the runtime supplies `causationIds: [instance.id]`.
- **`allOf`** — the membrane receives the `Log` and resolves each declared edge itself. It derives the ids during that same resolution, reading `latestInstance` where it currently reads `latest`.

**Why not have the runtime supply both.** `runtime.ts` rebuilds an `allOf` node's input bag with its own `log.latest` calls, purely so the trace entry can record the input — a second, parallel read of what the membrane reads internally. `membrane.ts`'s own doc comment flags this as a hazard: it is safe only because `latest` is synchronous and nothing can append between the two reads, and the same file anticipates a backing store that makes it async. Having the runtime also derive causation would add a *third* consumer of that coincidence, and the failure mode is silent — the recorded lineage names instances that were never consumed.

So the rule: **whoever resolved the input records what it consumed.** The runtime's parallel bag rebuild becomes less load-bearing rather than more.

**Follow-up, deliberately not done here.** The real fix is for the membrane to *return* what it consumed, so the runtime stops re-deriving the bag at all and the hazard disappears rather than merely not growing. That changes the invocation return shape and how the trace records `input`, which is its own change.

### 3. Rejected attempts carry causation too

Piece (1)'s successor work made the membrane build the envelope *before* asserting input, so a rejected attempt now has an envelope and produces a trace entry. That envelope must carry causation as well.

Otherwise lineage has a hole exactly where the trace just gained coverage: you could see that an attempt happened and not what it consumed. The runtime already knows the instance it tried to fire on, so this costs nothing — it is a matter of supplying the ids on the path that rejects, not only the path that succeeds.

The one case that genuinely has no causation is `buildEnvelope` throwing on a bad `scope`, where no envelope exists at all (see `Invocation.envelope`'s doc comment).

### 4. Callers with no scheduler record `[]`

`invoke.ts`'s `invokeWithInput` invokes a node directly, outside any run — tests, `fuzz.ts`, `accept.ts`, and replay. It has no notion of a consumed instance, so `causationIds` defaults to `[]`, exactly as `step` defaults to `0`.

`[]` therefore means "nothing recorded this as caused", which covers both an origin and an out-of-band invocation. That conflation is acceptable: an origin is already distinguishable by `wiring.origins`, and an out-of-band invocation has no log to be walked in.

### 5. Replay re-feeds recorded causation

`replayInvocation` already re-feeds `entry.envelope.identity` and `entry.envelope.step` for the same reason — they are recorded verbatim, so replaying means passing them straight back rather than re-deriving them. `causationIds` joins that list.

Without it, a replayed invocation would rebuild its envelope with `[]` and a replayed trace would claim nothing caused it.

### 6. Lineage has to be readable, or it is not worth recording

The invocation-records spec added `latestInstance` on the stated grounds that *"provenance nobody can read is provenance not worth storing"* — the same objection that ruled out pinning on a transient envelope. `causationIds` with nothing able to walk them is that shape exactly.

Two additions, both small:

```ts
// On Log — ids are UUIDs, so this does not need a correlation to disambiguate.
instanceById(id: string): LoggedInstance | undefined;
```

```ts
// New module: src/lineage.ts
/** Every transitive ancestor of an instance, oldest first, deduplicated. */
export function ancestorsOf(log: Log, instanceId: string): LoggedInstance[];
```

The walk: an instance carries `envelope.id`, the invocation that produced it; that envelope carries `causationIds`, the instances that invocation consumed; recurse. It terminates because an ancestor is always strictly earlier by `seq`, but the implementation keeps a visited set regardless — the cost is a `Set` and the alternative is an infinite loop if that invariant is ever wrong.

`ancestorsOf` is a DAG walk, not a chain: a fan-in invocation has several parents, and two branches of a diamond reconverge on a shared ancestor that must appear once.

This is the minimum that makes causation legible. Piece (3) will want "do these instances share an ancestor", which is a question `ancestorsOf` answers but does not answer *efficiently*; optimizing it belongs with the consumer that needs it.

### 7. Grouping the membrane's caller-supplied envelope fields

**This is the one part of this spec I would most like reviewed, because it churns a signature that changed earlier today.**

`MembraneArgs` for a `single`-input node is currently `[payload, correlationId, identity?, step?]`. Adding `causationIds?` makes five positional parameters, four of them optional — which is where positional arguments stop being readable, and is the same slide that took `runNetlist` to seven before piece (1) grouped them into `Run` and `Host`.

The grouping is available and principled, because these parameters are not arbitrary: `correlationId`, `identity`, `step` and `causationIds` are exactly the envelope fields the **caller supplies**, as against the ones the membrane **derives** (`id`, `timestamp`, `node`, `contractHash`).

```ts
export interface InvocationContext {
  correlationId: string;
  identity?: Partial<PayloadOf<typeof Identity>>;
  step?: number;
  causationIds?: string[];
}

// single: membrane(nodeDef, payload, context)
// allOf:  membrane(nodeDef, log, context)   — causationIds derived internally, see §2
```

Cost: a second pass over four call sites in one day. Benefit: the split names something real, and the next envelope field the caller supplies has an obvious home instead of becoming a sixth positional.

The alternative — appending `causationIds?` and moving on — is defensible and cheaper. Recorded as a decision to take rather than assumed.

## Testing

- **Origin records `[]`.** Not vacuous: assert `causationIds` is exactly `[]`, and that the run actually fired, so an empty array cannot come from nothing happening.
- **A `single`-input node records the id of the instance it consumed** — and specifically *that* instance, not merely the edge's latest. Fixture: two unconsumed instances queued, assert the first firing names the older one.
- **An `allOf` node records one id per declared edge**, and they are the instances the membrane actually resolved. Prove it can fail by having the runtime's parallel bag diverge from membrane's read.
- **A rejected attempt records causation.** The case §3 exists for: assert the trace entry for a rejected input names the instance it tried to fire on.
- **Replay reproduces `causationIds`.** Record at a non-empty value, replay, assert equality. Prove it by reverting the threading — a test recording `[]` would pass against the bug.
- **`ancestorsOf` on a diamond returns the shared ancestor once**, not twice. This is the deduplication case, and a `[...new Set()]` over ids rather than instances is the plausible bug.
- **`ancestorsOf` terminates** on a topology with a cycle, returning each ancestor once.
- **`instanceById` returns `undefined`** for an unknown id rather than throwing.

## Explicitly out of scope

- **`allOf` joining by lineage.** Piece (3). This spec records lineage; it does not use it to decide what fires.
- **The membrane returning what it consumed**, removing the runtime's parallel bag rebuild. Named in §2, worth doing, its own change.
- **An efficient shared-ancestor query.** `ancestorsOf` is correct, not optimized. Piece (3) owns that.
- **Composite nodes and `topologyId`.** Piece (4). `causationIds` crosses no topology boundary here because there are no nested topologies yet.
- **`Failed<In>.input` being typed as validated data it never was** — recorded in `open-questions.md`, pre-existing, untouched.
