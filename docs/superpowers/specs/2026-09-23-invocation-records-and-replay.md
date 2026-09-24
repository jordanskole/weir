# Invocation records, version pinning, and replay

Status: implemented.

## Motivation

`getting-started.md`'s build order has listed this as step 5's last unbuilt item since it was written: *"replay against the implementation version an invocation was pinned to."* The acceptance gate (`accept.ts`) now produces the `<contract-hash>.ts` artifact there would be to pin against, so the blocker named there is gone.

`design-history.md` is explicit that this came from an operational worry rather than tidiness: *"mutable `Fn` implementations break replay determinism, and redeploying a node's code out from under a long-running or replayed invocation is exactly the failure mode my earlier project's reactor orchestrators already had to solve."* §10 states the requirement: *"An invocation records which implementation version it actually ran under, immutable once written."*

**Two findings reshaped this from "add a field" into what it is.**

First, **the envelope is never persisted.** `buildEnvelope` runs once per invocation, is handed to `Fn` only if it declares `env`, and is then discarded; `Log.append(edgeName, correlationId, payload)` takes no envelope at all. So §10's "an invocation records..." has nowhere to be recorded — there is no invocation record. A pin field on a transient object pins nothing.

Second, **the pin is not a new field.** `design-history.md` settled that *"the version identifier is the contract hash, full stop,"* and §10 guarantees one accepted implementation per contract state, never overwritten. So `{implRoot}/{node}/{short(contractHash)}.ts` is uniquely determined by **(node name, contract hash)**. The envelope already carries that hash — under the name `schemaHash`. What it has never carried is the *node's own name*. The open item design-history left as "the version-pin field's exact name/shape" resolves to an identity that was never recorded, not a hash that needs adding.

**A conflation this surfaces and settles.** §1 lists the envelope as carrying a "schema hash," and §5 defines that as *"every edge instance carries the schema hash of the definition it was written under"* — the **edge's** hash, which is what makes replay-on-mismatch able to migrate or refuse. But `membrane.ts` sets `schemaHash` to `hashNode(nodeDef).hash` — the **node contract's** hash. Two different things under one name. Both are wanted, for different jobs and at different grains, so this spec gives each its own name rather than picking a winner.

## Design

### 1. `Envelope` — per invocation, what `Fn` sees

```ts
export interface Envelope {
  id: string;
  correlationId: string;
  causationId: string | null;
  timestamp: string;
  step: number;
  identity: Partial<PayloadOf<typeof Identity>>;
  /** The node this invocation ran. Half of the version pin — see §3. */
  node: string;
  /** The node contract's hash: the value `schemaHash` already held, under a name that says so. The other half of the pin. */
  contractHash: string;
}
```

Two changes: `node` is added, and `schemaHash` is **renamed** to `contractHash` while keeping the value it already had.

**`schemaHash` leaves the Fn-visible envelope entirely**, which is the non-obvious part. An envelope is built *before* `Fn` runs, so it cannot know which output edges will be emitted. §5's schema hash is a property of an emitted *instance*; for an `allOf`-output node emitting three branches, a single invocation-level `schemaHash` would be either wrong or arbitrary. It belongs at the grain where it's well-defined (§2), not here.

### 2. Instance provenance — `schemaHash` attached where it is knowable

`Log.append` gains an optional envelope, and stores provenance alongside the payload:

```ts
export interface LoggedInstance {
  payload: unknown;
  /** Absent for a staged input (see below); present for anything the runtime actually emitted. */
  envelope?: Envelope & { schemaHash: string };
}

export interface InstanceEnvelope extends Envelope {
  /** This edge definition's hash (§5) — knowable only once we know which edge was emitted. */
  schemaHash: string;
}

export interface Log {
  append(edgeName: string, correlationId: string, payload: unknown, envelope?: InstanceEnvelope): void;
  latest(edgeName: string, correlationId: string): unknown | undefined;
  /** The same entry with its provenance — so what §2 writes is actually readable. */
  latestInstance(edgeName: string, correlationId: string): LoggedInstance | undefined;
}
```

`latestInstance` exists because provenance nobody can read is provenance not worth storing — the same objection that ruled out pinning on a transient envelope. `latest` stays as-is so every current reader is untouched, and becomes a convenience over `latestInstance`.

**The caller hashes, not the Log.** `append` receives an edge *name*, never the edge definition, and is synchronous — while `hashEdge` needs the definition and is async. So the Log cannot compute the hash even in principle. The runtime's `logOutput` does have the edge (it is right there in `output.edge`/`output.edges`), so it computes `hashEdge(edge)` and passes a complete `InstanceEnvelope`; `logOutput` becomes async, which costs nothing since its only caller is already async. This keeps the Log a store rather than making it a hasher, which is the better split regardless.

One invocation emitting three `allOf` branches therefore produces three records sharing invocation ids and carrying three different edge hashes — exactly what §5 describes, and only expressible at this grain.

**Why the envelope is optional, named rather than hidden.** `Log.append` is currently doing two jobs: recording what a node emitted (`runtime.ts`'s `logOutput`) and *staging inputs* so an `allOf` node's readiness check has something to find (`invoke.ts`, and several tests). A staged input is not an emission and has no invocation behind it, so it has no envelope to carry. Making the parameter optional keeps those callers working and gives absence a real meaning — but it does mean `Log` is two things wearing one interface. Recorded in `open-questions.md` rather than papered over; splitting it is a separate decision.

`latest` continues to return the bare payload, so every existing reader is unaffected.

### 3. The version pin

The pin is **(`envelope.node`, `envelope.contractHash`)**. No third field. Because §10 guarantees one accepted implementation per contract state and never overwrites, that pair resolves to exactly one file — and resolving it is how replay gets the code that actually ran, rather than whatever the declaration would hash to now.

### 4. Getting the envelope out of the membrane

`buildEnvelope` runs *inside* `membrane()`, is handed to `Fn`, and never escapes — `SingleInvoke` returns only `OutputResult<O> | Failed<In>`. So as things stand the runtime cannot record what §2 and §5 require it to record: it never sees the envelope that was built.

The obvious fix — pass a `Trace`/`Log` into `membrane()` and let it record — is **ruled out by an explicit design rule.** `membrane.ts` states it outright: *"`membrane(nodeDef)` takes nothing but the declaration itself — the returned function's behavior, and its very shape... is entirely a product of what the NodeDef's `input` says, never separately configured."* A recording sink is exactly the separate configuration that rule forbids, and the rule is load-bearing: it is why a membrane's behaviour is always derivable from the declaration alone.

So the envelope comes **out** rather than the sink going **in**. The invoke's return becomes:

```ts
{ result: OutputResult<O> | Failed<In>; envelope?: Envelope }
```

`envelope` is optional, not required, which is a refinement on what was originally sketched here. `buildEnvelope` runs after the input assert already passed — a rejected assert resolves to `Failed<In>` before any envelope exists, and so does a thrown `buildEnvelope` itself (a bad `scope` declaration). Both are real `Fn`-never-ran paths, and inventing an envelope for either would mean recording an invocation that didn't happen. Presence is therefore exact, not incidental: the envelope is there **iff `Fn` was actually invoked**. This is the tighter contract of the two — a downstream trace entry, gated on the same envelope, then exists exactly when an invocation happened, never for a rejected-before-`Fn` `Failed<In>`.

> **Superseded, 2026-09-24.** This paragraph's argument was correct on its own terms and is kept rather than deleted, because the cost it accepted turned out to be larger than it looked from here: a rejected input produced no trace entry and no provenance on its `Failed_*` log instance, leaving it indistinguishable from a genuinely *staged* input (`Log.append`'s own doc comment says that never happens for a real emission). Two failures with opposite provenance looked identical, and replay silently reproduced invocations while skipping rejections. `buildEnvelope` now runs *before* the assert in both `single` and `allOf` branches, so `Invocation.envelope` (`membrane.ts`) is present for every **attempt**, not only every **invocation**, and is no longer optional on that type. The one remaining case with no envelope at all is `buildEnvelope` itself throwing (a bad `scope` declaration) — a declaration bug, not an attempt, and still `Failed<In>` with nothing built to attach. This also flips error precedence on a node with both a bad `scope` and a bad input: the declaration bug now reports first, which matches the project's existing split between declaration bugs (throw) and implementation failures (collected). See `docs/open-questions.md`'s resolved entry on this question for the full account.

This respects the rule — what configures the membrane is unchanged; only what it hands back grows — and it is honest about what an invocation produces: the envelope is not a side effect of running a node, it is part of the record of having run it. `invokeWithInput` (`invoke.ts`) returns the same pair, and its callers destructure.

**Cost, stated plainly:** four call sites change (`runtime.ts`, `invoke.ts`, and `fuzz.ts`/`accept.ts` via `invokeWithInput`), plus `index.ts`'s re-export and the tests that assert on results. None of them need the envelope; they take `.result` and carry on. It is a wide-but-shallow change, and the alternative was contradicting a rule the codebase states about itself.

### 5. `Trace` — one entry per invocation

A sibling of the Log, and the durable artifact §10's sentence actually requires:

```ts
export interface TraceEntry {
  envelope: Envelope;      // carries node + contractHash: the pin
  input: unknown;          // what the invocation ran on
  result: unknown;         // what came back, Failed<In> included
}

export interface Trace {
  record(entry: TraceEntry): void;
  entries(correlationId: string): TraceEntry[];
}
```

`runtime.ts` records one entry per node firing. An in-memory implementation (`InMemoryTrace`) mirrors `InMemoryLog` — the spike has no store, and this is enough to replay against.

### 6. Replay

`resolveImplementation` today takes a `NodeDecl` and *recomputes* its hash, which is exactly wrong for replay: the declaration may have changed since the invocation ran, and recomputing would resolve the wrong implementation or none. Replay resolves by *recorded* hash:

```ts
export function resolveImplementationAt(
  node: NodeDecl,
  implRoot: string,
  contractHash: string,
): Promise<NodeDef>;
```

Same file convention, same default-export check, same loud error when nothing is there — it simply takes the hash as an argument instead of deriving it. `resolveImplementation` becomes a thin wrapper that derives the hash and delegates, so there is one resolution path rather than two.

Then:

```ts
export function replayInvocation(entry: TraceEntry, node: NodeDecl, implRoot: string): Promise<unknown>;
```

Resolves the pinned implementation, re-runs it through `membrane()` against `entry.input`, returns the result. **It does not compare.** Whether the replayed result matches `entry.result` is the caller's question, because answering it would require deciding what equality means for a `Failed<In>`, for a `many` collection, and for anything with a timestamp in it — the same class of question that produced three separate false-greens in this codebase already. A primitive that re-runs honestly is worth more than one that asserts something it can't fully define.

**It does refuse a drifted declaration, which is the one check it must make.** The pin identifies the *implementation*; the `NodeDecl` comes from the caller. If that declaration has changed since the invocation ran, its hash no longer equals `entry.envelope.contractHash`, and replaying would run the old implementation against a *new* contract — `membrane()` asserting the new input shape, a different `scope`, different properties. That is not a replay of anything that ever happened. So `replayInvocation` compares `hashNode(node).hash` against the recorded `contractHash` and throws when they differ, naming both.

> The `scope` clause was struck when this spec was written and is restored here. At the time `fingerprintNode` did not cover `scope`, so a widened scope passed the drift check untouched and replayed against an `identity` narrowed differently from the recorded one — the guard did not deliver what this paragraph claimed. `scope` is now fingerprinted (docs/open-questions.md, "Which parts of a node declaration are contract, and which are commentary?"), so the claim holds as written.

This is §5's own doctrine applied one layer up: *"replay on mismatch either migrates through a declared rule or refuses."* There is no migration story for contracts, so it refuses. Declarations are not versioned anywhere — only implementations are — so a faithful replay under a changed contract isn't merely unimplemented, it isn't currently *representable*. Refusing loudly is the honest behaviour; silently running old code under a new contract is the one outcome worth ruling out.

## Explicitly out of scope

- **Comparing a replayed result to the recorded one.** See §5. The obvious next piece, deliberately not this one.
- **A real store.** `InMemoryTrace` mirrors `InMemoryLog`; persistence beyond process lifetime is the serialization-format question (`open-questions.md`), untouched here.
- **Splitting `Log`'s two jobs** (emission record vs. input staging). Surfaced by §2, recorded as an open question, not resolved.
- **Migrate-or-refuse on edge schema mismatch.** §5 describes replay migrating through a declared rule or refusing when an instance's schema hash no longer matches. This spec makes the hash *present* on stored instances, which is the prerequisite; the migration machinery is separate.
- **Causation chains.** `causationId` stays the honest `null` placeholder `membrane.ts` already documents — nothing yet tells a node which upstream instance triggered it, and inventing it here would be scope creep.
- **`step`.** Likewise still `0`; the pulse model isn't wired into the membrane.

## Testing

- `Envelope` carries `node` and `contractHash`, and `contractHash` equals `hashNode(decl).hash` for the node that ran.
- A logged emission stores an envelope whose `schemaHash` is that *edge's* hash — and for an `allOf`-output node, three emissions carry three different edge hashes but identical invocation ids.
- A staged input (no envelope) still round-trips through `latest`, and every pre-existing `Log` caller keeps working unchanged.
- `runtime.ts` records one trace entry per node firing, with the pin populated.
- `resolveImplementationAt` resolves by a *given* hash, ignoring what the declaration currently hashes to — proved by resolving an implementation whose node declaration has since changed.
- `resolveImplementation` still behaves exactly as before, now via the shared path.
- `replayInvocation` re-runs a recorded invocation against the pinned implementation and returns its result; replaying an invocation whose node has since gained a *new* accepted implementation still runs the **old** pinned one — the test that proves the pin is doing its job.
- Replaying against a pin with no implementation on disk fails loudly, naming the node and hash.
- `replayInvocation` **refuses** when the supplied declaration has drifted — its hash no longer matching the recorded `contractHash` — naming both hashes, rather than running old code under a new contract.
- `latestInstance` returns the stored provenance; `latest` returns the bare payload, unchanged.
- `membrane()`'s invoke returns `{ result, envelope }`, and the envelope it returns is the same one `Fn` received — proved by a node that echoes its `env` back and comparing the two.
- Every existing caller (`invokeWithInput`, and `fuzz.ts`/`accept.ts` through it) behaves identically on `.result`; `membrane(nodeDef)` still takes one argument.
