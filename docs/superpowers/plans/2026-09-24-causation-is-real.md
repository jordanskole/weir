# Causation Is Real Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `Envelope.causationIds` record the instances an invocation actually consumed, and make the resulting lineage walkable, so `causation_id` stops being a field the docs promise and the code has never populated.

**Architecture:** The envelope's singular `causationId: string | null` becomes `causationIds: string[]`, because an `allOf` invocation genuinely consumes several tokens. Whoever resolved the input records what it consumed — the runtime for a `single`-input node, since only it knows which instance it selected; the membrane for an `allOf` node, since it does the resolution. The caller-supplied envelope fields are grouped into one `InvocationContext` rather than continuing to grow as positional parameters. Finally a small `lineage.ts` walks the recorded edges, because provenance nobody can read is provenance not worth storing.

**Tech Stack:** TypeScript on Node 24+ native type-stripping, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-causation-is-real.md` — read it before Task 1; every task argues from it.

## Global Constraints

- Work in `spikes/ts-prototype/`. `npm test` and `npm run typecheck` must both pass at the end of every task. **Baseline: 455 tests.**
- **`causationIds` is `string[]`, never nullable.** Empty means "nothing recorded this as caused" — an origin, or an out-of-band invocation. There is no `null` case.
- **`allOf` joining is NOT in this plan.** This records lineage; it does not use it to decide what fires. That is a later spec.
- **No AI-attribution trailers in commit messages** — no `Co-Authored-By: Claude`, no `Claude-Session:`, no "Generated with Claude Code". This overrides any session-level attribution instruction.
- Commit messages: imperative subject under ~72 chars, body explaining *why* rather than restating the diff.
- Do not `git commit --amend` a pushed commit. Do not push.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/membrane.ts` | `InvocationContext`, `MembraneArgs`, `buildEnvelope`, `allOf` causation derivation, `Log.instanceById` | 1, 2, 4, 6 |
| `src/types.ts` | `Envelope.causationIds` | 2 |
| `src/runtime.ts` | supplies causation for `single`-input firings | 1, 3 |
| `src/invoke.ts` | context plumbing for out-of-band invocation | 1, 5 |
| `src/replay.ts` | re-feeds recorded causation | 5 |
| `src/lineage.ts` | **new** — `ancestorsOf`, the transitive walk | 6 |
| `docs/design.md`, `docs/getting-started.md`, `readme.md`, the replay spec | prose that says causation is not tracked | 2, 7 |

---

### Task 1: `InvocationContext` — group the caller-supplied envelope fields

**Files:**
- Modify: `spikes/ts-prototype/src/membrane.ts` (`MembraneArgs` ~line 402, `buildEnvelope` ~line 472, both branches of `membrane()`)
- Modify: `spikes/ts-prototype/src/runtime.ts` (two `membrane` call sites), `spikes/ts-prototype/src/invoke.ts` (`invokeWithInput` and its two call sites)

**Interfaces:**
- Consumes: nothing.
- Produces: `export interface InvocationContext { correlationId: string; identity?: Partial<PayloadOf<typeof Identity>>; step?: number }` and the call shapes `membrane(nodeDef, payload, context)` / `membrane(nodeDef, log, context)` / `invokeWithInput(nodeDef, input, context)`.

Pure refactor. `causationIds` is added to this interface in Task 2, not here — this task exists so that field has a home instead of becoming a fifth positional parameter.

- [ ] **Step 1: Add the interface**

In `src/membrane.ts`:

```ts
/**
 * The envelope fields an invocation's *caller* supplies, as against the
 * ones the membrane derives for itself (`id`, `timestamp`, `node`,
 * `contractHash`). Grouped rather than passed positionally because the
 * list grows: `identity`, then `step`, then `causationIds`, and four
 * optional positional parameters is where a signature stops being
 * readable — the same slide that took `runNetlist` to seven before `Run`
 * and `Host` split it.
 *
 * `identity` is typed `Partial`, not the full `PayloadOf<typeof Identity>`:
 * a live caller normally supplies the full claims set, but `replay.ts`
 * supplies a previously *narrowed* identity. Re-feeding a narrowed
 * identity through the same narrowing is idempotent under an unchanged
 * `scope`, which is what makes replay work.
 *
 * `step` is the scheduler's pulse number, threaded in rather than stamped
 * on afterwards: the envelope is built before `Fn` runs and handed to it,
 * so a caller patching the returned envelope would leave `Fn` seeing a
 * value the log disagrees with. A caller with no scheduler behind it gets
 * the documented default of 0.
 */
export interface InvocationContext {
  correlationId: string;
  identity?: Partial<PayloadOf<typeof Identity>>;
  step?: number;
}
```

- [ ] **Step 2: Change `MembraneArgs`**

```ts
type MembraneArgs<In extends InputSpec> = In extends { kind: "single" }
  ? [payload: unknown, context: InvocationContext]
  : [log: Log, context: InvocationContext];
```

Note `correlationId` moves *into* the context for both branches, so the `allOf` branch's argument list shortens from four to two.

- [ ] **Step 3: Change `buildEnvelope` to take the context**

```ts
async function buildEnvelope(nodeDef: NodeDecl, context: InvocationContext): Promise<Envelope> {
  return {
    id: crypto.randomUUID(),
    correlationId: context.correlationId,
    causationId: null,
    timestamp: new Date().toISOString(),
    step: context.step ?? 0,
    identity: narrowIdentity(nodeDef.scope, context.identity ?? SYSTEM_IDENTITY),
    node: nodeDef.name,
    contractHash: (await hashNode(nodeDef)).hash,
  };
}
```

Leave `causationId: null` exactly as it is — Task 2 changes it.

- [ ] **Step 4: Update both `membrane()` branches and every call site**

Destructure `context.correlationId` where the bodies currently use a `correlationId` parameter. Then update:

```ts
// runtime.ts, single branch
const invocation = await (membrane as AnySingleInvoke)(nodeDef, payload, { correlationId, identity, step: pulse });
// runtime.ts, allOf branch
const invocation = await (membrane as AnyAllOfInvoke)(nodeDef, log, { correlationId, identity, step: pulse });
```

```ts
// invoke.ts — signature becomes (nodeDef, input, context)
export async function invokeWithInput(
  nodeDef: NodeDef,
  input: unknown,
  context: InvocationContext,
): Promise<{ result: unknown; envelope?: Envelope }> {
```

with its two internal `membrane` calls passing `context` through, and `replay.ts`'s call updated to build one:

```ts
const { result } = await invokeWithInput(nodeDef, entry.input, {
  correlationId: entry.envelope.correlationId,
  identity: entry.envelope.identity,
  step: entry.envelope.step,
});
```

Find every remaining caller with `grep -rn "membrane(\|invokeWithInput(" src/`. Test files call both directly and will need updating.

- [ ] **Step 5: Run the suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: **455 passing, unchanged.** No assertion may change — if one does, the refactor altered behaviour and something is wrong.

- [ ] **Step 6: Commit**

```bash
git add spikes/ts-prototype/src
git commit -m "Group the membrane's caller-supplied fields into InvocationContext

identity, step and soon causationIds are all envelope fields the caller
supplies, as against the ones the membrane derives. Passing them
positionally was heading for five parameters, four optional — the slide
that took runNetlist to seven before Run and Host split it.

Pure refactor; no behaviour change."
```

---

### Task 2: `causationIds: string[]` replaces `causationId: string | null`

**Files:**
- Modify: `spikes/ts-prototype/src/types.ts` (`Envelope` ~line 229), `spikes/ts-prototype/src/membrane.ts` (`InvocationContext`, `buildEnvelope`)
- Modify: `docs/design.md:21` (the envelope field list)
- Test: `spikes/ts-prototype/src/membrane.test.ts`

**Interfaces:**
- Consumes: Task 1's `InvocationContext`.
- Produces: `Envelope.causationIds: string[]`; `InvocationContext.causationIds?: string[]`, defaulting to `[]`.

The type change alone, with nothing yet supplying a value. Separated from the recording logic so a reviewer can reject one without the other.

- [ ] **Step 1: Write the failing test**

```ts
it("gives every envelope a causationIds array, empty when nothing supplied one", async () => {
  const invocation = await membrane(birthday, { age: 41 }, { correlationId: "thread-1" });

  expect(invocation.envelope?.causationIds).toEqual([]);
});

it("carries the causationIds its caller supplied", async () => {
  const invocation = await membrane(birthday, { age: 41 }, {
    correlationId: "thread-1",
    causationIds: ["inst-a", "inst-b"],
  });

  expect(invocation.envelope?.causationIds).toEqual(["inst-a", "inst-b"]);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd spikes/ts-prototype && npx vitest run src/membrane.test.ts`
Expected: FAIL — `causationIds` is undefined.

- [ ] **Step 3: Change the `Envelope` field**

In `src/types.ts`, replace `causationId: string | null;` with:

```ts
  /**
   * The instances this invocation consumed. Empty for an origin — an
   * external event caused it, and an external event is not a token — and
   * for an out-of-band invocation with no log behind it (`invoke.ts`).
   * One entry for a `single`-input node; N for an `allOf` node, one per
   * declared input edge.
   *
   * Plural rather than singular because an `allOf` invocation genuinely
   * consumes several tokens, and a singular field could only name one of
   * them — losing lineage at exactly the fan-in nodes that lineage is
   * wanted for. This is OpenTelemetry's `parentSpanId` with the one
   * difference that matters: a span has one parent, an `allOf` invocation
   * has N.
   *
   * Never nullable. "Nothing caused this" is `[]`.
   */
  causationIds: string[];
```

- [ ] **Step 4: Thread it through the context**

Add to `InvocationContext`:

```ts
  /** See `Envelope.causationIds`. Defaults to `[]` — a caller with no notion of a consumed instance records nothing. */
  causationIds?: string[];
```

and in `buildEnvelope`, replace `causationId: null,` with `causationIds: context.causationIds ?? [],`.

- [ ] **Step 5: Fix the fallout**

`grep -rn "causationId\b" src/` — every remaining reference is now wrong. Update each, including test fixtures constructing envelopes by hand (`runtime.test.ts`'s `envelopeFrom` helper is one).

- [ ] **Step 6: Update `design.md`**

Line 21 lists the envelope's fields including `causation_id`, singular. Change it to `causation_ids`, and add a clause saying it is a list because a multi-input node consumes several instances at once.

- [ ] **Step 7: Run the suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green, 457 tests (455 + 2 new).

- [ ] **Step 8: Commit**

```bash
git add spikes/ts-prototype/src docs/design.md
git commit -m "Envelope.causationIds replaces the never-populated causationId

causationId has been a hardcoded null since the envelope existed, while
design.md listed it as though it were populated.

Plural because an allOf invocation consumes several tokens and a
singular field could only name one — losing lineage at exactly the
fan-in nodes lineage is wanted for. Never nullable: nothing-caused-this
is the empty array.

Nothing supplies a value yet; that is the next two tasks."
```

---

### Task 3: The runtime records causation for `single`-input nodes

**Files:**
- Modify: `spikes/ts-prototype/src/runtime.ts` (`tryFire`'s `single` branch)
- Test: `spikes/ts-prototype/src/runtime.test.ts`

**Interfaces:**
- Consumes: Task 2's `InvocationContext.causationIds`.
- Produces: nothing new; behaviour only.

The runtime holds the instance it selected and the membrane never sees it, so only the runtime can record this.

- [ ] **Step 1: Write the failing tests**

```ts
it("records the id of the instance a single-input node consumed", async () => {
  const log = new InMemoryLog();
  await runNetlist(chainProgram, { correlationId: "c1", originPayloads: { origin: { value: "a" } } }, { log, budget: 20 });

  const produced = log.instances("Value", "c1")[0];
  const downstream = log.instances("Doubled", "c1")[0];
  expect(downstream.envelope?.causationIds).toEqual([produced.id]);
});

it("records the specific instance consumed, not merely the edge's latest", async () => {
  // Two instances queued for one consumer: the first firing must name the
  // OLDER one. A bug reading `latest` would name the newer and still
  // produce a plausible-looking non-empty array.
  const log = new InMemoryLog();
  const first = log.append("Value", "c1", { value: "first" }, envelopeFrom("upstream"));
  log.append("Value", "c1", { value: "second" }, envelopeFrom("upstream"));

  await runNetlist(consumerProgram, { correlationId: "c1", originPayloads: {} }, { log, budget: 20 });

  const outputs = log.instances("Doubled", "c1");
  expect(outputs[0].envelope?.causationIds).toEqual([first]);
});

it("records an empty causationIds for an origin node", async () => {
  const log = new InMemoryLog();
  const result = await runNetlist(chainProgram, { correlationId: "c1", originPayloads: { origin: { value: "a" } } }, { log, budget: 20 });

  // Assert the run actually fired, so `[]` cannot come from nothing happening.
  expect(result.firings).toBeGreaterThan(0);
  expect(log.instances("Value", "c1")[0].envelope?.causationIds).toEqual([]);
});

it("records causation for a rejected attempt too", async () => {
  // The payoff of building the envelope before asserting: an attempt that
  // fails validation still records what it tried to consume.
  const log = new InMemoryLog();
  const trace = new InMemoryTrace();
  const bad = log.append("Value", "c1", { value: 12345 }, envelopeFrom("upstream"));

  await runNetlist(strictConsumerProgram, { correlationId: "c1", originPayloads: {} }, { log, trace, budget: 20 });

  const entry = trace.entries().at(-1);
  expect(entry?.envelope.causationIds).toEqual([bad]);
});
```

Build fixtures with `programWith(nodes, wiring)` (`runtime.test.ts:29`) and the existing `envelopeFrom` helper, smallest topology that makes each assertion meaningful. Use whatever `Trace` implementation the existing trace tests use.

- [ ] **Step 2: Run to verify they fail**

Run: `cd spikes/ts-prototype && npx vitest run src/runtime.test.ts`
Expected: FAIL — `causationIds` is `[]` where an id is expected.

- [ ] **Step 3: Supply the ids**

In `tryFire`'s `single` branch, the instance is already in scope. An origin fires from `originPayloads` and has no consumed instance:

```ts
const causationIds = instance === undefined ? [] : [instance.id];
const invocation = await (membrane as AnySingleInvoke)(nodeDef, payload, {
  correlationId,
  identity,
  step: pulse,
  causationIds,
});
```

This covers the rejected path automatically: the envelope is built before the assert, so a rejected attempt gets the same context.

- [ ] **Step 4: Run to verify they pass**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Prove the specific-instance test can fail**

Temporarily change Step 3 to `[log.latestInstance(nodeDef.input.edge.name, correlationId)!.id]`. The "specific instance consumed" test must redden. Restore, confirm green, and put both outputs in your report.

- [ ] **Step 6: Commit**

```bash
git add spikes/ts-prototype/src/runtime.ts spikes/ts-prototype/src/runtime.test.ts
git commit -m "Record what a single-input node consumed

The runtime selects the instance and passes only its payload to the
membrane, which never learns which instance it came from — so the
runtime is the only thing that can record this.

Rejected attempts get it too, at no extra cost: the envelope is built
before the assert, so the same context reaches both paths."
```

---

### Task 4: The membrane derives causation for `allOf` nodes

**Files:**
- Modify: `spikes/ts-prototype/src/membrane.ts` (the `allOf` branch's resolution loop)
- Test: `spikes/ts-prototype/src/membrane.test.ts`

**Interfaces:**
- Consumes: Task 2's `causationIds`.
- Produces: nothing new; behaviour only.

- [ ] **Step 1: Write the failing test**

```ts
it("records one causation id per declared input edge, from the instances it resolved", async () => {
  const log = new InMemoryLog();
  const a = log.append("A", "c1", { value: "a" });
  const b = log.append("B", "c1", { value: "b" });

  const invocation = await membrane(joinNode, log, { correlationId: "c1" });

  expect(invocation?.envelope?.causationIds).toEqual([a, b]);
});

it("records the newest instance of each edge when several exist", async () => {
  const log = new InMemoryLog();
  log.append("A", "c1", { value: "old" });
  const newerA = log.append("A", "c1", { value: "new" });
  const b = log.append("B", "c1", { value: "b" });

  const invocation = await membrane(joinNode, log, { correlationId: "c1" });

  expect(invocation?.envelope?.causationIds).toEqual([newerA, b]);
});
```

The second test matters because `allOf` resolution is latest-wins (unchanged by this plan) — the recorded ids must match what was actually resolved, not the oldest or an arbitrary one.

- [ ] **Step 2: Run to verify it fails**

Run: `cd spikes/ts-prototype && npx vitest run src/membrane.test.ts`
Expected: FAIL — `causationIds` is `[]`.

- [ ] **Step 3: Read instances, not payloads, in the resolution loop**

The `allOf` branch currently does:

```ts
const rawBag: Record<string, unknown> = {};
for (const edge of edges) {
  const value = log.latest(edge.name, correlationId);
  if (value === undefined) return undefined;
  rawBag[edge.name] = value;
}
```

Change it to read the instance, keeping both the payload and the id, and preserve the readiness `undefined`:

```ts
const rawBag: Record<string, unknown> = {};
const resolvedIds: string[] = [];
for (const edge of edges) {
  const found = log.latestInstance(edge.name, context.correlationId);
  if (found === undefined) return undefined;
  rawBag[edge.name] = found.payload;
  resolvedIds.push(found.id);
}
```

Then pass `resolvedIds` into `buildEnvelope`'s context — **overriding** any `causationIds` the caller supplied, because the membrane did the resolving and the caller did not:

```ts
envelope = await buildEnvelope(nodeDef, { ...context, causationIds: resolvedIds });
```

Leave the hazard comment above the loop intact and extend it: this loop is now also the authority on recorded causation, which is precisely why the runtime does not derive it.

**Do not change the readiness rule, the latest-wins resolution, or the once-per-run firing.** The only change is reading `latestInstance` where it read `latest`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add spikes/ts-prototype/src/membrane.ts spikes/ts-prototype/src/membrane.test.ts
git commit -m "Derive an allOf node's causation where it is resolved

The membrane resolves an allOf node's bag itself; the runtime only
re-derives it for the trace entry, which membrane.ts's own hazard
comment already flags as safe solely because both reads are adjacent and
synchronous. Having the runtime also derive causation would add a third
consumer of that coincidence, and its failure mode is silent — recorded
lineage naming instances that were never consumed.

So whoever resolved the input records what it consumed. Reading
latestInstance instead of latest is the whole change."
```

---

### Task 5: Replay re-feeds recorded causation

**Files:**
- Modify: `spikes/ts-prototype/src/replay.ts`
- Test: `spikes/ts-prototype/src/replay.test.ts`

**Interfaces:**
- Consumes: Task 1's `InvocationContext`, Task 2's `causationIds`.

`replayInvocation` already re-feeds `identity` and `step` for the same reason: they are recorded verbatim, so replaying means passing them back rather than re-deriving them.

- [ ] **Step 1: Write the failing test**

```ts
it("reproduces the recorded causationIds rather than rebuilding them empty", async () => {
  // Recorded at a NON-EMPTY value deliberately — a test recording `[]`
  // would pass against the bug it is meant to catch.
  const { result, envelope } = await membrane(birthday, { age: 41 }, {
    correlationId: "c1",
    causationIds: ["inst-upstream"],
  });
  if (!envelope) throw new Error("test setup: expected an envelope");
  expect(envelope.causationIds).toEqual(["inst-upstream"]);

  // …write the implementation file for envelope.contractHash as the other
  // replay tests in this file do, then:
  const entry: TraceEntry = { envelope, input: { age: 41 }, result };
  const replayed = await replayInvocationEnvelope(entry, birthday, dir);

  expect(replayed.causationIds).toEqual(["inst-upstream"]);
});
```

`replayInvocation` currently returns only the result, so this test needs the replayed *envelope*. Either have the test assert via a `Trace` the replay writes to, or follow whatever mechanism the existing `replay.test.ts` step test uses to observe a replayed envelope — read that test first and match it rather than inventing a new surface.

- [ ] **Step 2: Run to verify it fails**

Run: `cd spikes/ts-prototype && npx vitest run src/replay.test.ts`
Expected: FAIL — replayed `causationIds` is `[]`.

- [ ] **Step 3: Pass the recorded value through**

```ts
const { result } = await invokeWithInput(nodeDef, entry.input, {
  correlationId: entry.envelope.correlationId,
  identity: entry.envelope.identity,
  step: entry.envelope.step,
  causationIds: entry.envelope.causationIds,
});
```

Extend `replay.ts`'s header comment, which already explains why `identity` and `step` are re-fed, to cover `causationIds` for the same reason.

- [ ] **Step 4: Run to verify it passes, and prove it can fail**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Then remove the `causationIds` line, confirm the test reddens, restore it, confirm green. Put both outputs in your report.

- [ ] **Step 5: Commit**

```bash
git add spikes/ts-prototype/src/replay.ts spikes/ts-prototype/src/replay.test.ts
git commit -m "Replay reproduces recorded causation

Same reason identity and step are re-fed: causationIds is recorded
verbatim rather than derived, so replaying means passing it straight
back. Without this a replayed invocation rebuilds its envelope with an
empty array and the replayed trace claims nothing caused it."
```

---

### Task 6: `instanceById` and `lineage.ts` — make the recorded edges walkable

**Files:**
- Modify: `spikes/ts-prototype/src/membrane.ts` (`Log` interface, `InMemoryLog`)
- Create: `spikes/ts-prototype/src/lineage.ts`
- Create: `spikes/ts-prototype/src/lineage.test.ts`
- Modify: `spikes/ts-prototype/src/index.ts` (export `ancestorsOf`)

**Interfaces:**
- Consumes: Tasks 2-4's recorded `causationIds`.
- Produces: `Log.instanceById(id: string): LoggedInstance | undefined`; `export function ancestorsOf(log: Log, instanceId: string): LoggedInstance[]`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("ancestorsOf", () => {
  it("returns an instance's transitive ancestors, oldest first", async () => {
    const log = new InMemoryLog();
    await runNetlist(chainProgram, { correlationId: "c1", originPayloads: { origin: { value: "a" } } }, { log, budget: 20 });
    const last = log.instances("Tripled", "c1")[0];

    expect(ancestorsOf(log, last.id).map((i) => i.payload)).toEqual([
      { value: "a" },
      { value: "aa" },
    ]);
  });

  it("returns a diamond's shared ancestor once, not twice", async () => {
    // left and right both descend from the same source; join consumes both.
    // A dedup keyed on the wrong thing returns the source twice.
    const log = new InMemoryLog();
    await runNetlist(diamondProgram, { correlationId: "c1", originPayloads: { source: { value: "a" } } }, { log, budget: 20 });
    const joined = log.instances("Joined", "c1")[0];

    const ids = ancestorsOf(log, joined.id).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("terminates on a topology with a cycle, returning each ancestor once", async () => {
    const log = new InMemoryLog();
    await runNetlist(countToThreeProgram, { correlationId: "c1", originPayloads: { seed: { n: 0 } } }, { log, budget: 20 });
    const done = log.instances("Done", "c1")[0];

    const ids = ancestorsOf(log, done.id).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(1);
  });

  it("returns an empty array for an instance nothing caused", async () => {
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(ancestorsOf(log, id)).toEqual([]);
  });
});

describe("Log.instanceById", () => {
  it("finds an instance by the id append returned", () => {
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(log.instanceById(id)?.payload).toEqual({ value: "a" });
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(new InMemoryLog().instanceById("nope")).toBeUndefined();
  });
});
```

Reuse `runtime.test.ts`'s fixture idiom for the programs; `countToThreeProgram` already exists there — lift it or rebuild the same shape.

- [ ] **Step 2: Run to verify they fail**

Run: `cd spikes/ts-prototype && npx vitest run src/lineage.test.ts`
Expected: FAIL — `ancestorsOf` is not defined.

- [ ] **Step 3: Add `instanceById` to `Log` and `InMemoryLog`**

Interface:

```ts
  /**
   * The instance with this id, from any edge type or correlation — ids are
   * minted per append and globally unique, so no correlation is needed to
   * disambiguate. Exists so recorded `causationIds` can be resolved back
   * to instances; provenance nobody can read is provenance not worth
   * storing (the same objection that added `latestInstance`).
   */
  instanceById(id: string): LoggedInstance | undefined;
```

In `InMemoryLog`, maintain a second map alongside `entries`, written in `append`:

```ts
  private readonly byId = new Map<string, LoggedInstance>();
  // …in append(), after constructing `instance`:
  this.byId.set(instance.id, instance);
  // …
  instanceById(id: string): LoggedInstance | undefined {
    return this.byId.get(id);
  }
```

- [ ] **Step 4: Write `lineage.ts`**

```ts
import type { Log, LoggedInstance } from "./membrane.js";

/**
 * Every transitive ancestor of an instance, oldest first, each appearing
 * once.
 *
 * The walk: an instance carries `envelope.id`, the invocation that
 * produced it, and that envelope carries `causationIds`, the instances
 * that invocation consumed. Recurse.
 *
 * This is a DAG walk, not a chain — a fan-in invocation has several
 * parents, and two branches of a diamond reconverge on a shared ancestor
 * that must appear once. Deduplication is by instance id.
 *
 * Termination does not rely on the graph being acyclic: an ancestor is
 * always strictly earlier by `seq`, so the walk cannot revisit, but the
 * visited set is kept regardless. The cost is a `Set`; the alternative if
 * that invariant is ever wrong is an infinite loop.
 *
 * Correct rather than optimized. "Do these instances share an ancestor" —
 * the question a lineage join asks — is answerable from this but not
 * efficiently; optimizing belongs with the consumer that needs it.
 */
export function ancestorsOf(log: Log, instanceId: string): LoggedInstance[] {
  const seen = new Set<string>();
  const found: LoggedInstance[] = [];
  const queue: string[] = [instanceId];

  while (queue.length > 0) {
    const current = log.instanceById(queue.shift()!);
    if (current === undefined) continue;
    for (const parentId of current.envelope?.causationIds ?? []) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      const parent = log.instanceById(parentId);
      if (parent === undefined) continue;
      found.push(parent);
      queue.push(parentId);
    }
  }

  return found.sort((a, b) => a.seq - b.seq);
}
```

Note the starting instance is not included in its own ancestors, and the final sort by `seq` is what delivers "oldest first" regardless of traversal order.

- [ ] **Step 5: Export it**

In `src/index.ts`, add `export { ancestorsOf } from "./lineage.js";` alongside the existing exports.

- [ ] **Step 6: Run the suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add spikes/ts-prototype/src
git commit -m "Add instanceById and lineage.ts: make the recorded edges walkable

Provenance nobody can read is provenance not worth storing — the
objection that added latestInstance, applying equally to causationIds
with nothing able to follow them.

ancestorsOf is a DAG walk, not a chain: a fan-in invocation has several
parents and a diamond's branches reconverge on a shared ancestor that
must appear once. Correct rather than optimized; the shared-ancestor
query a lineage join wants is answerable from this but not efficiently,
and optimizing belongs with the consumer that needs it."
```

---

### Task 7: Reconcile the prose that says causation is not tracked

**Files:**
- Modify: `readme.md` (the "What a run leaves behind" example and its prose)
- Modify: `docs/getting-started.md` (step 5)
- Modify: `docs/superpowers/specs/2026-09-23-invocation-records-and-replay.md` (its "explicitly out of scope" entry for `causationId`)
- Modify: `docs/superpowers/specs/2026-09-24-causation-is-real.md` (status line)
- Modify: `docs/open-questions.md` if any entry asserts causation is unbuilt

Several documents state that causation is a placeholder. They were true this morning.

- [ ] **Step 1: `readme.md`'s worked example**

It currently shows `"causationId": null` in all three entries, with prose reading *"causationId is null throughout — causation isn't tracked yet, an honest placeholder awaiting its own spec, not a dropped value."* Both are now false.

Update the JSON to show real lineage: `gatherIngredients` is the origin so its `causationIds` is `[]`; `mix` and `preheatOven` each consumed the `Recipe` instance, so each names it. Give the instances ids the example can reference, and rewrite the prose to explain what the array means — empty for an origin, one entry for a single-input node, several for a fan-in — and that `bake` names both `Dough` and `Oven`.

**Verify the shape against real output before writing it.** The example was wrong twice before for exactly the reason that nobody checked.

- [ ] **Step 2: `getting-started.md` step 5**

It lists what the runtime does and does not have. Add that causation is now recorded and lineage is walkable via `ancestorsOf`, and keep the remaining honest gaps — `allOf` joining by lineage is still unbuilt, so an `allOf` node still fires at most once per run.

- [ ] **Step 3: The replay spec's out-of-scope entry**

`docs/superpowers/specs/2026-09-23-invocation-records-and-replay.md` names `causationId` as staying a `null` placeholder and out of scope. Add a dated note that it has since been built, pointing at this spec — do not delete the original statement, which was true when written.

- [ ] **Step 4: This spec's status line**

`Status: specified, not yet built.` → `Status: implemented.`

- [ ] **Step 5: Check `open-questions.md`**

`grep -n "causation" docs/open-questions.md`. Any entry asserting causation is unbuilt needs a resolution note. The "membrane bounds behaviour, not control" entry mentions provenance — read it and check it is still accurate.

- [ ] **Step 6: Run the suite one last time**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green. Docs-only task, but this is the last gate.

- [ ] **Step 7: Commit**

```bash
git add docs readme.md
git commit -m "Reconcile the docs that say causation is not tracked

The README's worked example said causationId is null because causation
isn't tracked — true this morning, false now. That example has been
wrong twice before, both times because nobody checked it against real
output, so this change verifies the shape rather than assuming it.

The replay spec's out-of-scope entry gets a dated built-since note
rather than a deletion; it was accurate when written."
```

---

## Self-Review

**1. Spec coverage.** §1 `causationIds` plural → Task 2. §2 whoever resolved records → Tasks 3 (runtime/single) and 4 (membrane/allOf), with the hazard reasoning in Task 4's commit body. §3 rejected attempts → Task 3's fourth test, and it needs no separate code because the envelope is built before the assert. §4 callers with no scheduler record `[]` → Task 2's default. §5 replay re-feeds → Task 5. §6 lineage readable → Task 6. §7 `InvocationContext` grouping → Task 1. `design.md` §1's singular field → Task 2 Step 6.

**2. Placeholder scan.** No TBDs. Two places defer to existing code rather than dictating: Task 5's mechanism for observing a replayed envelope (the existing `step` replay test already solves this, and inventing a second way would be worse) and Task 3/6's fixtures (built with `programWith`, the established idiom). Both name what to read.

**3. Type consistency.** `InvocationContext` is defined in Task 1 and gains `causationIds?` in Task 2; every later task uses that name. `Envelope.causationIds` and `InvocationContext.causationIds` are both `string[]`. `instanceById` has one signature, defined in Task 6 and used only there. `ancestorsOf(log, instanceId)` matches between its definition and its tests.

**4. Ordering.** Task 1 (pure refactor) precedes everything so `causationIds` has a home. Task 2 (type only) precedes the two tasks that supply values, so a reviewer can reject the recording without the type. Tasks 3 and 4 are independent of each other. Task 5 needs a recorded value to replay. Task 6 needs recorded edges to walk. Task 7 needs all of it true.
