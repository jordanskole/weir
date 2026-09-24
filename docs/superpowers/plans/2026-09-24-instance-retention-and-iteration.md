# Instance Retention and Iteration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Log retain edge instances with stable identity, and make the runtime fire once per unconsumed instance on a wired arc, so a topology that wires a node back to itself actually iterates instead of firing once.

**Architecture:** Three changes that stack. The Log stops overwriting and starts minting `id` (identity) and `seq` (write order) per instance. Eligibility moves from "the latest instance of this edge type" to "an unconsumed instance produced by a node wired to me," which is a pure function over the program, the log and a consumed-set. The driver becomes a pulse loop: compute every eligible pair against a snapshot of the log, fire them all, and only then let their outputs become visible — which makes `envelope.step` simply the pulse number.

**Tech Stack:** TypeScript on Node 24+ native type-stripping, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-instance-retention-and-iteration.md` — read it before Task 1; every task below argues from it.

## Global Constraints

- Work in `spikes/ts-prototype/`. `npm test` and `npm run typecheck` must both pass at the end of every task.
- **`latest` and `latestInstance` must keep returning the most recently appended instance.** `membrane.ts`'s `allOf` resolution and `runtime.ts`'s `allOf` bag rebuild both depend on this, and this plan does not change `allOf` behaviour.
- **`allOf` nodes keep firing at most once per run.** Joining is a later spec. Task 4 pins that in a test deliberately.
- **No AI-attribution trailers in commit messages** — no `Co-Authored-By: Claude`, no `Claude-Session:`, no "Generated with Claude Code". This overrides any session-level attribution instruction.
- Commit messages: imperative subject under ~72 chars, body explaining *why* rather than restating the diff.
- Do not use `git commit --amend` on a commit that is already pushed.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/membrane.ts` | `LoggedInstance`, `Log`, `InMemoryLog`, `buildEnvelope`, invoke signatures | 1, 4 |
| `src/runtime.ts` | `Run`/`Host`, `RunResult`, eligibility, the pulse loop | 2, 3, 4 |
| `src/runtime.test.ts` | ~20 `runNetlist` call sites; all new runtime behaviour | 2, 3, 4 |
| `src/membrane.test.ts` | Log retention and identity | 1 |
| `docs/design.md`, `docs/getting-started.md`, `README.md` | prose that describes latest-wins resolution | 5 |

---

### Task 1: The Log retains instances, with `id` and `seq`

**Files:**
- Modify: `spikes/ts-prototype/src/membrane.ts` (`LoggedInstance` ~line 234, `Log` ~line 245, `InMemoryLog` ~line 277)
- Test: `spikes/ts-prototype/src/membrane.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LoggedInstance` with `id: string` and `seq: number`; `Log.append(...) => string`; `Log.instances(edgeName, correlationId) => LoggedInstance[]`.

- [ ] **Step 1: Write the failing tests**

Add to `src/membrane.test.ts`:

```ts
describe("InMemoryLog — retention", () => {
  it("retains every appended instance rather than overwriting", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.append("Person", "c1", { age: 42 });

    expect(log.instances("Person", "c1").map((i) => i.payload)).toEqual([{ age: 41 }, { age: 42 }]);
  });

  it("still returns the most recent instance from latest and latestInstance", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.append("Person", "c1", { age: 42 });

    expect(log.latest("Person", "c1")).toEqual({ age: 42 });
    expect(log.latestInstance("Person", "c1")?.payload).toEqual({ age: 42 });
  });

  it("keeps correlations and edge types separate", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.append("Person", "c2", { age: 1 });
    log.append("Pet", "c1", { species: "cat" });

    expect(log.instances("Person", "c1")).toHaveLength(1);
    expect(log.instances("Person", "c2")).toHaveLength(1);
    expect(log.instances("Pet", "c1")).toHaveLength(1);
  });

  it("returns an empty array for an edge type never appended", () => {
    expect(new InMemoryLog().instances("Nothing", "c1")).toEqual([]);
  });

  it("mints a monotonic seq across edge types, not per edge type", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.append("Pet", "c1", { species: "cat" });
    log.append("Person", "c1", { age: 42 });

    const seqs = [
      log.instances("Person", "c1")[0].seq,
      log.instances("Pet", "c1")[0].seq,
      log.instances("Person", "c1")[1].seq,
    ];
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
  });

  it("mints a distinct id per instance and returns it from append", () => {
    const log = new InMemoryLog();
    const first = log.append("Person", "c1", { age: 41 });
    const second = log.append("Person", "c1", { age: 41 });

    expect(first).not.toBe(second);
    expect(log.instances("Person", "c1").map((i) => i.id)).toEqual([first, second]);
  });

  it("does not let a returned instances array mutate the log", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.instances("Person", "c1").push({ id: "x", seq: 99, payload: { age: 0 } });

    expect(log.instances("Person", "c1")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd spikes/ts-prototype && npx vitest run src/membrane.test.ts`
Expected: FAIL — `log.instances is not a function`.

- [ ] **Step 3: Update the types**

In `src/membrane.ts`, replace the `LoggedInstance` interface:

```ts
export interface LoggedInstance {
  /**
   * Stable identity for this instance, minted at append. This is what
   * causation will point at (docs/superpowers/specs/2026-09-24-instance-retention-and-iteration.md,
   * piece 2), which is why it is a minted string rather than `seq`: a
   * per-Log counter restarts and collides across runs, and the Trace
   * outlives one Log.
   */
  id: string;
  /**
   * Write order within one Log — a logical clock, not a causal
   * coordinate. `envelope.step` measures causal position and is shared by
   * everything in a pulse; `seq` is unique per instance, and many `seq`
   * values occur inside one pulse (design-history.md, "Three axes and a
   * clock").
   */
  seq: number;
  payload: unknown;
  envelope?: InstanceEnvelope;
}
```

- [ ] **Step 4: Update the `Log` interface**

Change `append`'s return type and add `instances`. Leave the existing doc comments on `append`, `latest` and `latestInstance` exactly as they are, and add:

```ts
  /**
   * Returns the new instance's `id`. The runtime tracks consumption
   * against instances it *reads*, so it does not need this today; piece 2
   * does, and retrofitting a return type across every call site later is
   * churn.
   */
  append(edgeName: string, correlationId: string, payload: unknown, envelope?: InstanceEnvelope): string;

  /**
   * Every retained instance of this edge type for this correlation,
   * oldest first. Returns a copy: callers iterate it while firing nodes
   * that append to the same log.
   */
  instances(edgeName: string, correlationId: string): LoggedInstance[];
```

- [ ] **Step 5: Rewrite `InMemoryLog`**

```ts
/** An in-memory Log — the spike has no real store yet; this is enough to test readiness against. */
export class InMemoryLog implements Log {
  private readonly entries = new Map<string, LoggedInstance[]>();
  private nextSeq = 0;
  private key(edgeName: string, correlationId: string): string {
    return `${edgeName} ${correlationId}`;
  }
  append(
    edgeName: string,
    correlationId: string,
    payload: unknown,
    envelope?: InstanceEnvelope,
  ): string {
    const key = this.key(edgeName, correlationId);
    const instance: LoggedInstance = {
      id: crypto.randomUUID(),
      seq: this.nextSeq++,
      payload,
      envelope,
    };
    const existing = this.entries.get(key);
    if (existing) existing.push(instance);
    else this.entries.set(key, [instance]);
    return instance.id;
  }
  latest(edgeName: string, correlationId: string): unknown | undefined {
    return this.latestInstance(edgeName, correlationId)?.payload;
  }
  latestInstance(edgeName: string, correlationId: string): LoggedInstance | undefined {
    const list = this.entries.get(this.key(edgeName, correlationId));
    return list && list.length > 0 ? list[list.length - 1] : undefined;
  }
  instances(edgeName: string, correlationId: string): LoggedInstance[] {
    return [...(this.entries.get(this.key(edgeName, correlationId)) ?? [])];
  }
}
```

- [ ] **Step 6: Run the full suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green. Nothing else changes behaviour — `latest` still returns the newest instance, which is what every current reader wants.

- [ ] **Step 7: Commit**

```bash
git add spikes/ts-prototype/src/membrane.ts spikes/ts-prototype/src/membrane.test.ts
git commit -m "The Log retains instances, with id and seq

append stopped overwriting. Each instance now carries a minted id
(stable identity, what causation will point at) and a seq (write order
within one Log). These are two fields rather than one because causation
ids must outlive a single Log, while a per-Log counter restarts and
collides across runs.

latest and latestInstance are deliberately unchanged, still returning
the most recently appended instance, so every current reader — including
membrane's allOf resolution — is untouched."
```

---

### Task 2: `Run` and `Host` replace `runNetlist`'s parameter tail

**Files:**
- Modify: `spikes/ts-prototype/src/runtime.ts` (`runNetlist` ~line 153)
- Modify: `spikes/ts-prototype/src/runtime.test.ts` (~20 call sites)

**Interfaces:**
- Consumes: Task 1's `Log`.
- Produces: `interface Run { correlationId: string; originPayloads: Record<string, unknown>; identity?: PayloadOf<typeof Identity> }`, `interface Host { log: Log; trace?: Trace; budget?: number }`, and `runNetlist(program: Program, run: Run, host: Host): Promise<RunResult>`.

This is a pure refactor. No behaviour changes. It goes before the pulse loop so that Task 4's diff is about iteration rather than about parameter plumbing.

- [ ] **Step 1: Add the interfaces**

In `src/runtime.ts`, above `runNetlist`:

```ts
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
}
```

- [ ] **Step 2: Change the signature and destructure**

Replace `runNetlist`'s parameter list and add destructuring as its first statement:

```ts
export async function runNetlist(program: Program, run: Run, host: Host): Promise<RunResult> {
  const { correlationId, originPayloads, identity } = run;
  const { log, trace } = host;
```

The body already refers to `correlationId`, `originPayloads`, `identity`, `log` and `trace` by those names, so nothing inside changes. `budget` is unused until Task 4 — do not destructure it yet, or `noUnusedLocals` will fail the typecheck.

- [ ] **Step 3: Update every call site in `runtime.test.ts`**

Positional calls become two object literals. The mapping is mechanical:

```ts
// before
await runNetlist(program, log, "thread-1", { doubled: { value: "a" } });
// after
await runNetlist(program, { correlationId: "thread-1", originPayloads: { doubled: { value: "a" } } }, { log });

// before — with a trace, identity left undefined
await runNetlist(program, log, "thread-1", { step1: { value: "a" } }, undefined, trace);
// after
await runNetlist(program, { correlationId: "thread-1", originPayloads: { step1: { value: "a" } } }, { log, trace });
```

Work through every occurrence of `runNetlist(` in `src/runtime.test.ts`. Do not change any assertion.

- [ ] **Step 4: Run the full suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green, same test count as before this task. A failure here means the refactor changed behaviour, which it must not.

- [ ] **Step 5: Commit**

```bash
git add spikes/ts-prototype/src/runtime.ts spikes/ts-prototype/src/runtime.test.ts
git commit -m "Group runNetlist's parameters into Run and Host

Seven positional parameters were about to become eight. The split is not
arbitrary grouping: Run is what a trigger supplies (which run, what fired
it, on whose behalf) and Host is what the execution environment supplies
(where instances live, where invocations are recorded, what may be
spent). Putting budget in Host makes the type encode that bounding
iteration belongs to the host rather than the language.

Deliberately not named Zone — a zone is per-node and one run spans many,
so that name would foreclose the client/server split.

Pure refactor; no behaviour change."
```

---

### Task 3: Eligibility is `(arc, unconsumed instance)`

**Files:**
- Modify: `spikes/ts-prototype/src/runtime.ts`
- Test: `spikes/ts-prototype/src/runtime.test.ts`

**Interfaces:**
- Consumes: Task 1's `Log.instances`, Task 2's types.
- Produces: `export function eligibleInstances(program: Program, log: Log, consumed: ReadonlySet<number>, nodeDef: NodeDef, correlationId: string): LoggedInstance[]`.

A pure function, tested directly, before anything calls it. This is the rule that stops `birthday: Person → Person` from firing on its own output.

- [ ] **Step 1: Write the failing tests**

Add to `src/runtime.test.ts`. Reuse whatever edge/program fixtures that file already defines; the shape below assumes a `Program` whose `wiring.feeds` maps producer node names to consumer node names.

```ts
describe("eligibleInstances", () => {
  it("returns an unconsumed instance produced by a node wired to this one", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" }, envelopeFrom("upstream"));

    const result = eligibleInstances(program, log, new Set(), program.nodes.downstream, "c1");

    expect(result.map((i) => i.payload)).toEqual([{ value: "a" }]);
  });

  it("excludes an instance produced by a node NOT wired to this one", () => {
    // The canonical-example guard: birthday emits Person and also consumes
    // Person, but nothing wires birthday to itself, so its own output is
    // not eligible for it.
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" }, envelopeFrom("unrelated"));

    expect(eligibleInstances(program, log, new Set(), program.nodes.downstream, "c1")).toEqual([]);
  });

  it("excludes an already-consumed instance", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" }, envelopeFrom("upstream"));
    const seq = log.instances("Value", "c1")[0].seq;

    expect(eligibleInstances(program, log, new Set([seq]), program.nodes.downstream, "c1")).toEqual([]);
  });

  it("treats an instance with no envelope as eligible by type — a staged input", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" });

    expect(eligibleInstances(program, log, new Set(), program.nodes.downstream, "c1")).toHaveLength(1);
  });

  it("returns instances oldest first", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "first" }, envelopeFrom("upstream"));
    log.append("Value", "c1", { value: "second" }, envelopeFrom("upstream"));

    expect(eligibleInstances(program, log, new Set(), program.nodes.downstream, "c1").map((i) => i.payload)).toEqual([
      { value: "first" },
      { value: "second" },
    ]);
  });

  it("returns nothing for an allOf-input node — that is not its job", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" }, envelopeFrom("upstream"));

    expect(eligibleInstances(program, log, new Set(), program.nodes.someAllOfNode, "c1")).toEqual([]);
  });
});
```

Write a small helper in the test file rather than hand-building envelopes inline:

```ts
function envelopeFrom(node: string): InstanceEnvelope {
  return {
    id: "inv-" + node,
    correlationId: "c1",
    causationId: null,
    timestamp: new Date().toISOString(),
    step: 0,
    identity: {},
    node,
    contractHash: "hash",
    schemaHash: "edge-hash",
  };
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd spikes/ts-prototype && npx vitest run src/runtime.test.ts`
Expected: FAIL — `eligibleInstances is not defined`.

- [ ] **Step 3: Implement it**

In `src/runtime.ts`:

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green. Nothing calls `eligibleInstances` yet, so the rest of the suite is unaffected.

- [ ] **Step 5: Commit**

```bash
git add spikes/ts-prototype/src/runtime.ts spikes/ts-prototype/src/runtime.test.ts
git commit -m "Add eligibleInstances: readiness by arc, not by edge type

Resolving input by edge name alone is harmless while every node fires
once and divergent as soon as they don't: birthday: Person -> Person
would observe its own output as a new unconsumed Person and run away on
the canonical example. Arcs connect specific places to specific
transitions; wiring.feeds is that arc set and envelope.node already
records each instance's producer.

An instance with no envelope stays eligible by type, because an absent
envelope already means staged-or-injected rather than produced by an arc.

Pure function, tested directly. Nothing calls it yet."
```

---

### Task 4: The pulse loop, with `step`, budget and quiescence

**Files:**
- Modify: `spikes/ts-prototype/src/runtime.ts` (`RunResult` ~line 76, `runNetlist` body)
- Modify: `spikes/ts-prototype/src/membrane.ts` (`buildEnvelope`, and the invoke signatures that reach it)
- Test: `spikes/ts-prototype/src/runtime.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3.
- Produces: `RunResult` with `firings: number`, `pulses: number`, `stopped: "quiescence" | "budget"`; `buildEnvelope(nodeDef, correlationId, identity, step)`; membrane invokes accepting an optional trailing `step` that defaults to `0`.

- [ ] **Step 1: Write the failing tests**

Add to `src/runtime.test.ts`:

```ts
describe("runNetlist — iteration", () => {
  it("leaves the canonical example unchanged: each node fires once, stopping on quiescence", async () => {
    // The regression test for arc-based eligibility. If readiness were by
    // edge type, birthday would consume its own Person output forever.
    const log = new InMemoryLog();
    const result = await runNetlist(
      personBirthdayProgram,
      { correlationId: "c1", originPayloads: { origin: { age: 41 } } },
      { log, budget: 50 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(log.instances("Person", "c1")).toHaveLength(2); // the origin's, and birthday's
  });

  it("runs a real cycle until the node emits its terminal branch", async () => {
    // countToThree is wired to itself and emits Continue until 3, then Done.
    const log = new InMemoryLog();
    const result = await runNetlist(
      countToThreeProgram,
      { correlationId: "c1", originPayloads: { seed: { n: 0 } } },
      { log, budget: 50 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(log.latest("Done", "c1")).toEqual({ n: 3 });
  });

  it("stops on budget rather than hanging when a cycle never terminates", async () => {
    const log = new InMemoryLog();
    const result = await runNetlist(
      foreverProgram,
      { correlationId: "c1", originPayloads: { seed: { n: 0 } } },
      { log, budget: 10 },
    );

    expect(result.stopped).toBe("budget");
    expect(result.firings).toBe(10);
  });

  it("does not consume within the pulse that produced — snapshot isolation", async () => {
    // A self-feeding node fires exactly once per pulse. With 10 firings
    // allowed it therefore takes 10 pulses, never draining its own output
    // inside one.
    const log = new InMemoryLog();
    const result = await runNetlist(
      foreverProgram,
      { correlationId: "c1", originPayloads: { seed: { n: 0 } } },
      { log, budget: 10 },
    );

    expect(result.pulses).toBe(result.firings);
  });

  it("gives every invocation in a pulse the same step, and siblings different seqs", async () => {
    const log = new InMemoryLog();
    await runNetlist(
      fanOutProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 50 },
    );

    const siblings = [...log.instances("Left", "c1"), ...log.instances("Right", "c1")];
    expect(new Set(siblings.map((i) => i.envelope?.step)).size).toBe(1);
    expect(new Set(siblings.map((i) => i.seq)).size).toBe(siblings.length);
  });

  it("fans one instance out to two consumers without either starving the other", async () => {
    const log = new InMemoryLog();
    await runNetlist(
      fanOutProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 50 },
    );

    expect(log.instances("Left", "c1")).toHaveLength(1);
    expect(log.instances("Right", "c1")).toHaveLength(1);
  });

  it("still fires an allOf node at most once — deliberately unchanged here", async () => {
    // Joining is a later spec. Pinned so that change is visible when it
    // comes rather than silent.
    const log = new InMemoryLog();
    const result = await runNetlist(
      allOfInCycleProgram,
      { correlationId: "c1", originPayloads: { a: { value: "a" }, b: { value: "b" } } },
      { log, budget: 50 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(log.instances("Joined", "c1")).toHaveLength(1);
  });
});
```

You will need three new program fixtures in this file — `countToThreeProgram`, `foreverProgram`, `fanOutProgram` — plus whatever the file already has for the canonical example and an `allOf` node. Build them the same way the existing fixtures in `runtime.test.ts` are built. `countToThree`'s `Fn` is:

```ts
(payload) => (payload.n >= 3 ? { edge: "Done", payload } : { edge: "Continue", payload: { n: payload.n + 1 } })
```

with `output: { kind: "oneOf", edges: [Continue, Done] }`, and `wiring.feeds` mapping `countToThree` back to `countToThree`. `forever` is the same node without the terminal branch — it always emits `Continue`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd spikes/ts-prototype && npx vitest run src/runtime.test.ts`
Expected: FAIL — `result.stopped` is undefined, and the cycle test finds no `Done` instance.

- [ ] **Step 3: Thread `step` into the envelope**

In `src/membrane.ts`, `buildEnvelope` gains a parameter and its doc comment loses half its hedge:

```ts
/**
 * Builds this invocation's Envelope. `causationId` is still an honest
 * placeholder (see file header) — real causation needs a mechanism that
 * does not exist yet. `step` is no longer one: under the runtime's pulse
 * scheduling it is the pulse number, which is exactly causal position
 * within the topology. Defaults to 0 for callers with no scheduler behind
 * them (`invoke.ts`'s single invocation, tests).
 *
 * Can throw (a bad `scope` declaration) — the caller is responsible for
 * turning that into `Failed<In>`.
 */
async function buildEnvelope(
  nodeDef: NodeDecl,
  correlationId: string,
  identity: Partial<PayloadOf<typeof Identity>>,
  step = 0,
): Promise<Envelope> {
  return {
    id: crypto.randomUUID(),
    correlationId,
    causationId: null,
    timestamp: new Date().toISOString(),
    step,
    identity: narrowIdentity(nodeDef.scope, identity),
    node: nodeDef.name,
    contractHash: (await hashNode(nodeDef)).hash,
  };
}
```

Then add an optional trailing `step` parameter to the `SingleInvoke` and `AllOfInvoke` types and to the invoke functions `membrane()` returns, passing it through to `buildEnvelope`. It is optional and last, exactly as `identity` already is, so no existing caller changes.

- [ ] **Step 4: Extend `RunResult`**

```ts
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
```

- [ ] **Step 5: Replace the driver**

Keep `tryFire` almost as it is — it already handles membrane invocation, trace recording, `Failed<In>` routing and `logOutput`. Change it to take the instance it should fire on and the pulse number, and to stop consulting the `fired` set. Then replace the queue with the pulse loop:

```ts
  const consumed = new Map<string, Set<number>>();
  const originsFired = new Set<string>();
  const firedAllOf = new Set<string>();
  const origins = new Set(program.wiring.origins);
  let firings = 0;
  let pulse = 0;

  const consumedBy = (nodeName: string): Set<number> => {
    let seen = consumed.get(nodeName);
    if (!seen) {
      seen = new Set();
      consumed.set(nodeName, seen);
    }
    return seen;
  };

  for (;;) {
    pulse += 1;

    // The snapshot. Every candidate is computed against the log as it
    // stands now, so an instance emitted during this pulse is invisible
    // until the next one. That is what makes `step` equal the pulse
    // number, and what stops a self-feeding node draining its own output
    // inside one pulse without needing a fairness rule.
    const candidates: { nodeName: string; instance?: LoggedInstance }[] = [];
    for (const nodeName of Object.keys(program.nodes).sort()) {
      const nodeDef = program.nodes[nodeName];
      if (nodeDef.input.kind !== "single") {
        if (!firedAllOf.has(nodeName)) candidates.push({ nodeName });
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

    // Counting actual firings rather than candidates matters: an `allOf`
    // node is a candidate whenever it has not fired, but `membrane()`'s
    // own readiness check may still decline it. Quiescence has to mean
    // "nothing fired", not "nothing was offered", or an unready `allOf`
    // node would spin the loop forever.
    if (firedThisPulse === 0) {
      return { failures, firings, pulses: pulse - 1, stopped: "quiescence" };
    }
  }
```

Inside `tryFire`, mark consumption on success: `originsFired.add(nodeName)` for an origin, `firedAllOf.add(nodeName)` for an `allOf` node, and `consumedBy(nodeName).add(instance.seq)` for a single-input firing. Use the passed instance's `payload` as the node's input instead of `log.latest(...)`, and pass `pulse` through to the membrane invoke as `step`.

Destructure `budget` from `host` now that it is used.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green.

If the canonical-example test fails with a runaway, eligibility is being consulted with the wrong node name — check that `tryFire` marks `consumedBy(nodeName)` and not `consumedBy(producer)`.

- [ ] **Step 7: Commit**

```bash
git add spikes/ts-prototype/src/runtime.ts spikes/ts-prototype/src/membrane.ts spikes/ts-prototype/src/runtime.test.ts
git commit -m "Replace the fired-once worklist with a snapshot pulse loop

A node now fires once per unconsumed instance arriving on an arc wired
to it, and a topology that wires a node back to itself iterates until it
emits a branch nothing routes back. runtime.ts already documented the
pulse/wave model as decided, implemented 'as a worklist rather than
precomputed pulse numbers' — a shortcut that only holds while every node
fires once.

Candidates are computed against a snapshot of the log at the start of
each pulse, so an instance emitted during a pulse is invisible until the
next. That makes envelope.step the pulse number — it was a hardcoded 0 —
and it means a self-feeding node fires exactly once per pulse without
needing a fairness rule.

Quiescence counts actual firings rather than candidates, because an allOf
node is a candidate whenever it hasn't fired while membrane's own
readiness check may still decline it.

allOf nodes still fire at most once. Joining is a later spec, pinned here
by a test so that change is visible rather than silent."
```

---

### Task 5: Reconcile the prose that describes latest-wins

**Files:**
- Modify: `docs/design.md` (§5, the "latest instance" sentence)
- Modify: `docs/getting-started.md` (step 5)
- Modify: `README.md` (the Status block)
- Modify: `docs/superpowers/specs/2026-09-24-instance-retention-and-iteration.md` (status line)
- Modify: `docs/open-questions.md` (the "no loop construct" entry)

Prose goes stale silently and no test covers it. Every statement below is now false or half-true.

- [ ] **Step 1: `design.md` §5**

It currently says the membrane resolves inputs by *"reading each named edge type's latest instance for the current `correlation_id`."* That is still true for `allOf` and no longer true for `single`. Rewrite it to say that a `single`-input node fires once per unconsumed instance reaching it along a declared arc, that `allOf` still resolves each declared edge's latest instance, and that the difference is temporary — naming the spec.

- [ ] **Step 2: `getting-started.md` step 5**

It says *"Still not built: ... cycle/bounded-iteration support (a node whose own name recurs fires at most once per invocation...)"*. Cycles now run. Replace that clause with what is actually still missing: `allOf` nodes still fire once, so iteration works for single-input chains only.

- [ ] **Step 3: `README.md` Status block**

It says iteration is *"specified but not yet built — today's log keeps only the latest instance per edge type, so a cycle fires once rather than running to quiescence."* Move it into the built list, keeping the qualifier that `allOf` joining is not done.

- [ ] **Step 4: The spec's status line**

`Status: specified, not yet built.` → `Status: implemented.`

- [ ] **Step 5: `open-questions.md`**

The "no loop construct" entry already carries a "substantially resolved in design" note. Add that it is now resolved in code too, and that what remains open from that entry is `allOf` joining.

- [ ] **Step 6: Run the full suite one last time**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: all green. Docs-only task, but the suite is cheap and this is the last gate.

- [ ] **Step 7: Commit**

```bash
git add docs README.md
git commit -m "Reconcile the docs that still describe latest-wins resolution

design.md §5 specified resolution as reading each edge type's latest
instance, which was accurate and is now half true: allOf still resolves
that way, single-input nodes fire once per unconsumed instance on a
declared arc. getting-started listed cycles as unbuilt and README listed
iteration as specified-not-built; both now run.

What is genuinely still open from the loop entry is allOf joining, and
each of these now says so rather than implying iteration is finished."
```

---

## Self-Review

**1. Spec coverage.** §1 identity/ordering → Task 1. §2 retention and `instances` → Task 1. §3 runtime-held consumption → Task 4 (`consumed` map). §4 arc eligibility → Task 3. §5 `allOf` unchanged → Task 4's final test. §6 pulse loop, snapshot, `step`, sorted order → Task 4. §7 `Run`/`Host` → Task 2. §8 `RunResult` → Task 4. Every testing bullet in the spec maps to a test in Task 1, 3 or 4. Docs reconciliation is not in the spec but is required by it being true — Task 5.

**2. Placeholder scan.** No TBDs. Every code step carries real code. The one place the plan says "build them the same way the existing fixtures are built" is Task 4's program fixtures, which depend on `runtime.test.ts`'s existing fixture helpers — the `Fn` body and `output` shape that actually matter are given literally.

**3. Type consistency.** `eligibleInstances` has the same signature in Task 3's implementation and Task 4's call. `LoggedInstance.id`/`seq` are defined in Task 1 and used in Tasks 3 and 4. `Run`/`Host` are defined in Task 2 and used in Tasks 2 and 4. `RunResult`'s three new fields are defined in Task 4 and asserted in Task 4's tests. `buildEnvelope`'s `step` parameter is added in Task 4 and defaulted so Task 1-3 callers are unaffected.

**4. Ordering.** Task 2 (pure refactor) deliberately precedes Task 4 so the iteration diff is not buried in parameter plumbing. Task 3 precedes Task 4 because Task 4 calls it. Task 1 precedes everything.
