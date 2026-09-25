# `allOf` Joins By Lineage Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make an `allOf`-input node fire once per lineage group rather than once per run, so a fan-out to several context nodes and a fan-in that assesses them together works per item instead of once.

**Architecture:** A pure `joinRows` in `lineage.ts` takes the unconsumed candidates per declared edge and returns the rows that should fire — grouping by nearest common ancestor (highest `seq` in the self-and-ancestors intersection), zipping positionally within a group, and falling back to latest-wins when no candidate has lineage at all. The runtime gathers candidates, calls it, and fires a row at a time. The membrane stops resolving `allOf` inputs entirely and just asserts the bag it is handed.

**Tech Stack:** TypeScript on Node 24+ native type-stripping, vitest. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-25-allof-joins-by-lineage.md` — read it before Task 1; every task argues from it.

## Global Constraints

- Work in `spikes/ts-prototype/`. `npm test` and `npm run typecheck` must both pass at the end of every task. **Baseline: 471 tests.**
- **Test files are NOT typechecked.** `tsconfig.json` has `"exclude": ["src/**/*.test.ts"]`, so `tsc --noEmit` never sees them. A malformed fixture produces no compile error and surfaces only if it happens to change an assertion. Construct fixtures carefully — the compiler is not a second pair of eyes here.
- **Everything is scoped to one `correlationId`**, as all resolution already is.
- **No AI-attribution trailers in commit messages** — no `Co-Authored-By: Claude`, no `Claude-Session:`, no "Generated with Claude Code". This overrides any session-level attribution instruction.
- Commit messages: imperative subject under ~72 chars, body explaining *why* rather than restating the diff.
- Do not `git commit --amend` a pushed commit. Do not push.

---

## File Structure

| File | Responsibility | Tasks |
|---|---|---|
| `src/lineage.ts` | `selfAndAncestorIds`, `joinRows` — the pure join logic | 1, 3 |
| `src/runtime.ts` | `eligibleForEdge`, candidate gathering, firing a row at a time | 2, 5 |
| `src/membrane.ts` | `allOf` stops resolving; asserts a supplied bag | 4 |
| `src/invoke.ts` | passes the bag straight through | 4 |
| `docs/`, `readme.md` | prose saying `allOf` fires once per run | 6 |

---

### Task 1: `selfAndAncestorIds` — the join's lineage primitive

**Files:**
- Modify: `spikes/ts-prototype/src/lineage.ts`
- Test: `spikes/ts-prototype/src/lineage.test.ts`

**Interfaces:**
- Consumes: `Log.instanceById`, `Envelope.causationIds` (both exist).
- Produces: `export function selfAndAncestorIds(log: Log, instanceId: string): Set<string>`.

`ancestorsOf` already exists and returns *instances*, excluding the starting one. The join needs *ids*, and needs self included — an `allOf` node consuming an edge straight from the origin never joins otherwise, because the origin instance has no ancestors and the intersection comes out empty.

- [ ] **Step 1: Write the failing tests**

```ts
describe("selfAndAncestorIds", () => {
  it("includes the instance itself", () => {
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(selfAndAncestorIds(log, id)).toEqual(new Set([id]));
  });

  it("includes every transitive ancestor as well as self", async () => {
    const log = new InMemoryLog();
    await runNetlist(
      chainProgram,
      { correlationId: "c1", originPayloads: { origin: { value: "a" } } },
      { log, budget: 20 },
    );
    const last = log.instances("Tripled", "c1")[0];
    const mid = log.instances("Doubled", "c1")[0];
    const first = log.instances("Value", "c1")[0];

    expect(selfAndAncestorIds(log, last.id)).toEqual(new Set([last.id, mid.id, first.id]));
  });

  it("returns a diamond's shared ancestor once", async () => {
    const log = new InMemoryLog();
    await runNetlist(
      diamondProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 20 },
    );
    const joined = log.instances("Joined", "c1")[0];

    const ids = selfAndAncestorIds(log, joined.id);
    // 1 joined + left + right + source = 4, with source reached by two paths.
    expect(ids.size).toBe(4);
  });

  it("returns just the instance for one with no envelope", () => {
    // A staged instance has no invocation behind it, so no lineage.
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(selfAndAncestorIds(log, id)).toEqual(new Set([id]));
  });

  it("returns just the id for an instance not in the log", () => {
    expect(selfAndAncestorIds(new InMemoryLog(), "nope")).toEqual(new Set(["nope"]));
  });
});
```

Reuse `lineage.test.ts`'s existing `chainProgram` and `diamondProgram` fixtures — they are already built there for `ancestorsOf`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd spikes/ts-prototype && npx vitest run src/lineage.test.ts`
Expected: FAIL — `selfAndAncestorIds is not defined`.

- [ ] **Step 3: Implement it**

```ts
/**
 * Every id in an instance's lineage, itself included.
 *
 * `ancestorsOf` returns instances and excludes the starting one, which is
 * right for "where did this come from" and wrong for a join: two
 * instances join on the highest-`seq` member of the intersection of their
 * lineages, and an `allOf` node consuming an edge straight from the
 * origin would never join at all under a pure-ancestors reading — the
 * origin instance has no ancestors, so the intersection is empty. Self
 * has to count. That is not a patch: if one instance is an ancestor of
 * the other they plainly belong together.
 *
 * Ids rather than instances because the join only compares and orders
 * them, and a `Set<string>` intersects directly.
 *
 * An instance with no envelope was supplied from outside rather than
 * produced by an invocation, so its lineage is just itself.
 */
export function selfAndAncestorIds(log: Log, instanceId: string): Set<string> {
  const seen = new Set<string>([instanceId]);
  const queue: string[] = [instanceId];

  while (queue.length > 0) {
    const current = log.instanceById(queue.shift()!);
    if (current === undefined) continue;
    for (const parentId of current.envelope?.causationIds ?? []) {
      if (seen.has(parentId)) continue;
      seen.add(parentId);
      queue.push(parentId);
    }
  }

  return seen;
}
```

- [ ] **Step 4: Run the suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: green, 476 tests (471 + 5 new). Nothing calls it yet.

- [ ] **Step 5: Commit**

```bash
git add spikes/ts-prototype/src/lineage.ts spikes/ts-prototype/src/lineage.test.ts
git commit -m "Add selfAndAncestorIds: the join's lineage primitive

ancestorsOf returns instances and excludes the starting one, which is
right for asking where something came from and wrong for a join. Two
instances join on the highest-seq member of their lineages'
intersection, and an allOf node consuming an edge straight from the
origin would never join under a pure-ancestors reading — the origin
instance has no ancestors, so the intersection is empty.

Ids rather than instances because the join only compares and orders
them, and a Set intersects directly."
```

---

### Task 2: `eligibleForEdge` — one filter, two callers

**Files:**
- Modify: `spikes/ts-prototype/src/runtime.ts` (`eligibleInstances`, ~line 263)

**Interfaces:**
- Produces: `export function eligibleForEdge(program: Program, log: Log, consumed: ReadonlySet<number>, nodeName: string, edgeName: string, correlationId: string): LoggedInstance[]`.
- `eligibleInstances` keeps its current signature and delegates.

Pure refactor. `eligibleInstances` returns `[]` for non-single nodes; Task 5 needs the same per-edge filter for each of an `allOf` node's declared edges, and duplicating it would mean two copies of the arc rule.

- [ ] **Step 1: Extract the filter**

```ts
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
```

- [ ] **Step 2: Make `eligibleInstances` delegate**

Keep its doc comment — it carries the reasoning about why readiness follows arcs rather than edge types, which is still the rule being applied.

```ts
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
```

- [ ] **Step 3: Run the suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: green, **476 tests, unchanged**. No assertion may change — the existing `eligibleInstances` tests are the proof this refactor is behaviour-neutral.

- [ ] **Step 4: Commit**

```bash
git add spikes/ts-prototype/src/runtime.ts
git commit -m "Extract eligibleForEdge so both input kinds share one arc rule

A single-input node asks about its one declared edge; an allOf node will
ask about each of its declared edges in turn. Both want the same answer,
and two copies of the arc rule would be two places for it to drift.

Pure refactor; no behaviour change."
```

---

### Task 3: `joinRows` — group by nearest common ancestor, zip within

**Files:**
- Modify: `spikes/ts-prototype/src/lineage.ts`
- Test: `spikes/ts-prototype/src/lineage.test.ts`

**Interfaces:**
- Consumes: Task 1's `selfAndAncestorIds`.
- Produces: `export function joinRows(log: Log, candidates: Map<string, LoggedInstance[]>): Map<string, LoggedInstance>[]` — each returned map is one firing, keyed by edge name.

The heart of the piece, and pure: given candidates per edge, decide which combinations fire. No `Program`, no wiring, no scheduler — the runtime does the gathering and the firing.

- [ ] **Step 1: Write the failing tests**

```ts
describe("joinRows", () => {
  it("pairs instances by their nearest common ancestor, never across groups", async () => {
    // Two entities, each fanning out to two context edges. The WRONG
    // pairing must be available for this test to mean anything: all four
    // context instances share the origin, so a rule keyed on "shares an
    // ancestor" would happily pair left_1 with right_2.
    const log = new InMemoryLog();
    await runNetlist(
      twoEntityFanOutProgram,
      { correlationId: "c1", originPayloads: { source: { value: "seed" } } },
      { log, budget: 40 },
    );

    const lefts = log.instances("Left", "c1");
    const rights = log.instances("Right", "c1");
    expect(lefts).toHaveLength(2);
    expect(rights).toHaveLength(2);

    const rows = joinRows(log, new Map([["Left", lefts], ["Right", rights]]));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const left = row.get("Left")!;
      const right = row.get("Right")!;
      const shared = [...selfAndAncestorIds(log, left.id)].filter((id) =>
        selfAndAncestorIds(log, right.id).has(id),
      );
      const nearest = shared
        .map((id) => log.instanceById(id)!)
        .sort((a, b) => b.seq - a.seq)[0];
      // The nearest shared ancestor must be an Entity, not the origin.
      expect(nearest.envelope?.node).toBe("extractEntities");
    }
  });

  it("joins an instance with its own descendant — self counts as an ancestor", async () => {
    // bake: allOf[Recipe, Oven] where Recipe comes straight off the origin.
    // ancestors(Recipe) is empty, so a pure-ancestors rule never joins.
    const log = new InMemoryLog();
    await runNetlist(
      originEdgeProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 20 },
    );

    const recipes = log.instances("Recipe", "c1");
    const ovens = log.instances("Oven", "c1");

    const rows = joinRows(log, new Map([["Recipe", recipes], ["Oven", ovens]]));

    expect(rows).toHaveLength(1);
    expect(rows[0].get("Recipe")).toEqual(recipes[0]);
  });

  it("returns nothing when an edge has no candidate", () => {
    const log = new InMemoryLog();
    const a = log.instanceById(log.append("A", "c1", { v: 1 }))!;

    expect(joinRows(log, new Map([["A", [a]], ["B", []]]))).toEqual([]);
  });

  it("zips within a group, leaving ragged leftovers unconsumed", async () => {
    // One entity, two Lefts and two Rights and one Mid: zip depth is 1.
    const log = new InMemoryLog();
    await runNetlist(
      raggedGroupProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 40 },
    );

    const rows = joinRows(
      log,
      new Map([
        ["Left", log.instances("Left", "c1")],
        ["Right", log.instances("Right", "c1")],
        ["Mid", log.instances("Mid", "c1")],
      ]),
    );

    expect(rows).toHaveLength(1);
    // Oldest of each edge is taken first.
    expect(rows[0].get("Left")).toEqual(log.instances("Left", "c1")[0]);
  });

  it("falls back to latest-wins when no candidate has lineage", () => {
    // The externally-invoked tier: a staged bag, as invoke.ts builds.
    const log = new InMemoryLog();
    log.append("A", "c1", { v: 1 });
    const newerA = log.instanceById(log.append("A", "c1", { v: 2 }))!;
    const b = log.instanceById(log.append("B", "c1", { v: 3 }))!;

    const rows = joinRows(
      log,
      new Map([["A", log.instances("A", "c1")], ["B", [b]]]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].get("A")).toEqual(newerA);
  });
});
```

You will need three new fixtures in `lineage.test.ts`, built with `programWith(nodes, wiring)` the way `runtime.test.ts:29` does:

- **`twoEntityFanOutProgram`** — `source` (origin) → `extractEntities`, which emits `Entity`; `leftCtx` and `rightCtx` both consume `Entity` and emit `Left`/`Right`. `extractEntities` must fire **twice** so two entities exist — wire it to itself with a `oneOf` terminal branch after the second, the way `countToThreeProgram` in `runtime.test.ts` does, or seed two `Entity` instances and let the context nodes fire per instance.
- **`originEdgeProgram`** — `source` (origin) emits `Recipe`; `heat` consumes `Recipe` and emits `Oven`. No `allOf` node needs to exist for this test; `joinRows` is being called directly.
- **`raggedGroupProgram`** — one entity, with the left and right context nodes each firing twice and the middle one once.

- [ ] **Step 2: Run to verify they fail**

Run: `cd spikes/ts-prototype && npx vitest run src/lineage.test.ts`
Expected: FAIL — `joinRows is not defined`.

- [ ] **Step 3: Implement it**

```ts
/**
 * Which combinations of candidates should fire, one map per firing.
 *
 * **Grouping is by nearest common ancestor, not any common ancestor.** A
 * correlation has one origin event, so every token in a run descends from
 * the same origin instance — "shares an ancestor" is true of every
 * combination including every wrong one. What discriminates is which
 * ancestor is nearest, and `seq` delivers that directly: an ancestor is
 * always strictly earlier, so the nearest is the highest-`seq` member of
 * the intersection. Scanning ancestors in descending `seq` finds it
 * first, which is also what stops the origin forming a wrong group — by
 * the time the scan reaches it, nearer ancestors have claimed their
 * instances.
 *
 * **Within a group, candidates zip.** Sorted by `seq` and paired
 * positionally, one firing per complete row, ragged leftovers left
 * unconsumed until their partners arrive. Not newest-of-each, which drops
 * data, and not the cartesian product, which multiplies it.
 *
 * **When no candidate has an envelope, latest-wins.** An envelope records
 * that an invocation produced an instance; none means the values were
 * supplied from outside, which is the direct-invocation path — an agent
 * tool call, `fuzz`, `accept`. There is no lineage to join on because
 * nothing upstream ran, and exactly one candidate per edge, so
 * latest-wins has nothing to choose between.
 *
 * An envelope-less instance among instances that do have lineage is a
 * wildcard: it has no lineage to contradict, so it can fill any edge in
 * any group — the same reasoning that lets it bypass the arc rule.
 *
 * Correct rather than optimized: O(candidates × lineage size) per call,
 * re-walked every pulse. Lineages are immutable once written so they
 * cache trivially, and a real runtime would likely compute the branch key
 * at write time and make this a map lookup.
 */
export function joinRows(
  log: Log,
  candidates: Map<string, LoggedInstance[]>,
): Map<string, LoggedInstance>[] {
  const edgeNames = [...candidates.keys()];
  if (edgeNames.length === 0) return [];
  if (edgeNames.some((name) => (candidates.get(name) ?? []).length === 0)) return [];

  const every = edgeNames.flatMap((name) => candidates.get(name)!);
  if (every.every((instance) => instance.envelope === undefined)) {
    const row = new Map<string, LoggedInstance>();
    for (const name of edgeNames) {
      const list = candidates.get(name)!;
      row.set(name, list[list.length - 1]);
    }
    return [row];
  }

  // ancestor id -> edge name -> candidates descending from it
  const byAncestor = new Map<string, Map<string, LoggedInstance[]>>();
  for (const name of edgeNames) {
    for (const instance of candidates.get(name)!) {
      for (const ancestorId of selfAndAncestorIds(log, instance.id)) {
        let perEdge = byAncestor.get(ancestorId);
        if (perEdge === undefined) {
          perEdge = new Map();
          byAncestor.set(ancestorId, perEdge);
        }
        perEdge.set(name, [...(perEdge.get(name) ?? []), instance]);
      }
    }
  }

  const seqOf = (id: string): number => log.instanceById(id)?.seq ?? -1;
  const ordered = [...byAncestor.keys()].sort((a, b) => seqOf(b) - seqOf(a));

  const rows: Map<string, LoggedInstance>[] = [];
  const claimed = new Set<string>();

  for (const ancestorId of ordered) {
    const perEdge = byAncestor.get(ancestorId)!;
    const available = new Map<string, LoggedInstance[]>();
    let complete = true;

    for (const name of edgeNames) {
      const wildcards = candidates.get(name)!.filter((i) => i.envelope === undefined);
      const merged = [...new Map([...(perEdge.get(name) ?? []), ...wildcards].map((i) => [i.id, i])).values()]
        .filter((i) => !claimed.has(i.id))
        .sort((a, b) => a.seq - b.seq);
      if (merged.length === 0) {
        complete = false;
        break;
      }
      available.set(name, merged);
    }
    if (!complete) continue;

    const depth = Math.min(...edgeNames.map((name) => available.get(name)!.length));
    for (let i = 0; i < depth; i += 1) {
      const row = new Map<string, LoggedInstance>();
      for (const name of edgeNames) {
        const instance = available.get(name)![i];
        row.set(name, instance);
        claimed.add(instance.id);
      }
      rows.push(row);
    }
  }

  return rows;
}
```

- [ ] **Step 4: Run the suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: green. Nothing calls `joinRows` yet.

- [ ] **Step 5: Prove the nearest-ancestor rule can fail**

Temporarily change the `ordered` sort to ascending (`seqOf(a) - seqOf(b)`), so the origin is scanned first. The "pairs instances by their nearest common ancestor" test must redden — the origin will form one group containing everything and zip it wrongly. Restore, confirm green, and put both outputs in your report. **This is the proof that matters**: without it, that test only shows two rows came out, not that they are the right two.

- [ ] **Step 6: Commit**

```bash
git add spikes/ts-prototype/src/lineage.ts spikes/ts-prototype/src/lineage.test.ts
git commit -m "Add joinRows: group by nearest common ancestor, zip within

Shares-an-ancestor is trivially true inside a run — one origin event
means every token descends from the same instance, so any combination
qualifies including every wrong one. The nearest shared ancestor is what
discriminates, and seq gives it directly since ancestors are always
strictly earlier.

Scanning descending by seq finds the nearest first, which is also what
stops the origin forming a wrong group: nearer ancestors have already
claimed their instances by the time the scan reaches it.

Pure function. Nothing calls it yet."
```

---

### Task 4: The membrane stops resolving `allOf` inputs

**Files:**
- Modify: `spikes/ts-prototype/src/membrane.ts` (`MembraneArgs`, `MembraneResult`, the `allOf` branch ~line 582)
- Modify: `spikes/ts-prototype/src/invoke.ts` (the `allOf` path)
- Modify: `spikes/ts-prototype/src/runtime.ts` (the `allOf` call site — still latest-wins here; Task 5 changes it)
- Test: `spikes/ts-prototype/src/membrane.test.ts`, `spikes/ts-prototype/src/invoke.test.ts`

**Interfaces:**
- Produces: `MembraneArgs` for `allOf` becomes `[bag: Record<string, unknown>, context: InvocationContext]`; `MembraneResult` loses its `| undefined` branch.

- [ ] **Step 1: Write the failing test**

```ts
it("yields Failed<In> for an incomplete bag rather than a readiness signal", async () => {
  // invokeWithInput used to stage a partial bag and let membrane return a
  // bare `undefined` meaning "not ready". A direct caller has nowhere to
  // come back from, so an incomplete bag is an error, and Failed<In> says
  // so. This is the accepted behaviour change in the spec's §5.
  const result = await invokeWithInput(joinNode, { A: { value: "a" } }, { correlationId: "c1" });

  expect(result.result).toMatchObject({ reason: expect.any(String) });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd spikes/ts-prototype && npx vitest run src/invoke.test.ts`
Expected: FAIL — `result.result` is `undefined`, not a `Failed<In>`.

- [ ] **Step 3: Change `MembraneArgs` and `MembraneResult`**

```ts
type MembraneArgs<In extends InputSpec> = In extends { kind: "single" }
  ? [payload: unknown, context: InvocationContext]
  : [bag: Record<string, unknown>, context: InvocationContext];

type MembraneResult<In extends InputSpec, O extends OutputSpec> = Invocation<In, O>;
```

`MembraneResult` no longer varies by input kind — keep the alias rather than inlining `Invocation`, so the call sites and their casts do not all churn again.

- [ ] **Step 4: Rewrite the `allOf` branch**

Delete the resolution loop, the readiness `return undefined`, `resolvedIds`, and the `context.causationIds ?? resolvedIds` override. The branch becomes: build the envelope, assert each declared edge against the supplied bag, call `Fn`.

```ts
  if (nodeDef.input.kind === "allOf") {
    const edges = nodeDef.input.edges;
    const [rawBag, context] = args as unknown as [rawBag: Record<string, unknown>, context: InvocationContext];

    // The membrane no longer resolves this node's inputs. The runtime
    // chose a specific combination by lineage (docs/superpowers/specs/
    // 2026-09-25-allof-joins-by-lineage.md §5) and re-resolving here would
    // discard that group and read the latest instead. It also retires the
    // read-adjacency hazard this loop used to be one half of: one reader,
    // so no window to be adjacent across. Causation is supplied by
    // whoever resolved the input, which is now the runtime.
    let envelope: Envelope;
    try {
      envelope = await buildEnvelope(nodeDef, context);
    } catch (cause) {
      return { result: { input: rawBag as InputPayload<In>, reason: reasonOf(cause) } } as MembraneResult<In, O>;
    }

    const bag: Record<string, unknown> = {};
    const errors: string[] = [];
    for (const edge of edges) {
      try {
        bag[edge.name] = assertPayload(edge, rawBag[edge.name]);
      } catch (cause) {
        errors.push(reasonOf(cause));
      }
    }
    if (errors.length > 0) {
      return {
        result: { input: rawBag as InputPayload<In>, reason: errors.join("; ") },
        envelope,
      } as MembraneResult<In, O>;
    }

    try {
      return { result: await callFn(nodeDef, bag as InputPayload<In>, envelope), envelope } as MembraneResult<In, O>;
    } catch (cause) {
      return { result: { input: bag as InputPayload<In>, reason: reasonOf(cause) }, envelope } as MembraneResult<In, O>;
    }
  }
```

A missing edge now fails `assertPayload` and lands in `errors`, which is the `Failed<In>` the new test expects.

- [ ] **Step 5: Update `invoke.ts`**

It built a scratch `InMemoryLog` purely so membrane could resolve from it. That whole apparatus goes — pass the bag straight through.

```ts
  const bag = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  return await (membrane as AnyAllOfInvoke)(nodeDef, bag, context);
```

Remove the now-unused `InMemoryLog` import if nothing else in the file uses it, and drop the `?? { result: undefined }` fallback — membrane no longer returns `undefined`.

- [ ] **Step 6: Update `runtime.ts`'s `allOf` call site**

Still latest-wins here; Task 5 replaces it with groups. The point of this step is that Task 4 changes no runtime behaviour.

```ts
      const bag: Record<string, unknown> = {};
      for (const edge of nodeDef.input.edges) {
        bag[edge.name] = log.latest(edge.name, correlationId);
      }
      input = bag;
      if (nodeDef.input.edges.some((edge) => bag[edge.name] === undefined)) return false;
      const invocation = await (membrane as AnyAllOfInvoke)(nodeDef, bag, { correlationId, identity, step: pulse });
      result = invocation.result;
      envelope = invocation.envelope;
```

The explicit readiness check replaces the `if (invocation === undefined) return false` membrane used to provide. Update the local `AnyAllOfInvoke` cast type in both `runtime.ts` and `invoke.ts` to the new shape — they are hand-written mirrors, and a stale one silently accepts wrong arguments.

- [ ] **Step 7: Run the suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: green. The only behaviour change is the direct-invocation one the new test asserts.

- [ ] **Step 8: Commit**

```bash
git add spikes/ts-prototype/src
git commit -m "The membrane stops resolving allOf inputs

It received the Log and resolved the bag itself. Under lineage joining
the runtime picks a specific combination, and re-resolving here would
discard that group and read the latest instead.

Three things follow, each a simplification. The read-adjacency hazard
retires — one reader, so no window to be adjacent across. allOf
causation moves back to whoever resolved the input, which is now the
runtime, preserving that rule rather than reversing it. And the
readiness undefined disappears, collapsing the return from three states
to two.

Accepted cost: an incomplete bag through the direct path is now a
Failed<In> rather than a bare undefined. A direct caller has nowhere to
come back from, so an error is the honest answer."
```

---

### Task 5: The runtime fires one row per group

**Files:**
- Modify: `spikes/ts-prototype/src/runtime.ts` (`firedAllOf`, candidate scan, `tryFire`)
- Test: `spikes/ts-prototype/src/runtime.test.ts`

**Interfaces:**
- Consumes: Task 2's `eligibleForEdge`, Task 3's `joinRows`, Task 4's bag-taking membrane.

- [ ] **Step 1: Write the failing tests**

```ts
describe("runNetlist — allOf joins by lineage", () => {
  it("fires a fan-in once per entity, never pairing across entities", async () => {
    // The fixture must make the mispairing AVAILABLE: all four context
    // instances share the origin, so a rule keyed on any shared ancestor
    // would pair left_1 with right_2 and this test would catch it.
    const log = new InMemoryLog();
    const result = await runNetlist(
      socShapeProgram,
      { correlationId: "c1", originPayloads: { alert: { value: "a" } } },
      { log, budget: 40 },
    );

    expect(result.stopped).toBe("quiescence");
    const assessments = log.instances("Assessment", "c1");
    expect(assessments).toHaveLength(2);
    // Each assessment's causation names one Left and one Right from the
    // same entity — proven by their nearest shared ancestor being an
    // Entity rather than the alert.
    for (const assessment of assessments) {
      const consumed = assessment.envelope!.causationIds.map((id) => log.instanceById(id)!);
      expect(consumed).toHaveLength(2);
      const shared = [...selfAndAncestorIds(log, consumed[0].id)].filter((id) =>
        selfAndAncestorIds(log, consumed[1].id).has(id),
      );
      const nearest = shared.map((id) => log.instanceById(id)!).sort((a, b) => b.seq - a.seq)[0];
      expect(nearest.envelope?.node).toBe("extractEntities");
    }
  });

  it("waits a pulse for an incomplete group, then fires when it completes", async () => {
    const log = new InMemoryLog();
    const result = await runNetlist(
      slowArmProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 40 },
    );

    expect(result.stopped).toBe("quiescence");
    const joined = log.instances("Joined", "c1");
    expect(joined).toHaveLength(1);
    // step is one past the LONGEST path feeding it, not the shortest.
    expect(joined[0].envelope?.step).toBe(4);
  });

  it("reaches quiescence without firing when a group never completes", async () => {
    const log = new InMemoryLog();
    const result = await runNetlist(
      brokenArmProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 40 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(log.instances("Joined", "c1")).toEqual([]);
  });

  it("records the ids of the instances in the row it fired on", async () => {
    const log = new InMemoryLog();
    await runNetlist(
      simpleDiamondProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 20 },
    );

    const joined = log.instances("Joined", "c1")[0];
    const left = log.instances("Left", "c1")[0];
    const right = log.instances("Right", "c1")[0];
    expect(new Set(joined.envelope!.causationIds)).toEqual(new Set([left.id, right.id]));
  });
});
```

Fixtures, built with `programWith`: **`socShapeProgram`** (alert origin → `extractEntities` firing twice → `leftCtx`/`rightCtx` per entity → `assess` as `allOf[Left, Right]`), **`slowArmProgram`** (one arm two hops longer than the other), **`brokenArmProgram`** (one arm's node always emits a branch nothing routes to `Joined`), **`simpleDiamondProgram`** (the plain diamond).

- [ ] **Step 2: Run to verify they fail**

Run: `cd spikes/ts-prototype && npx vitest run src/runtime.test.ts`
Expected: FAIL — one `Assessment`, not two, because `firedAllOf` still caps at one firing per run.

- [ ] **Step 3: Delete `firedAllOf` and gather per-edge candidates**

Remove `const firedAllOf = new Set<string>();`, its `if (firedAllOf.has(nodeName)) continue;` in the candidate scan, and `if (nodeDef.input.kind !== "single") firedAllOf.add(nodeName);` in `tryFire`.

In the candidate scan, an `allOf` node now contributes one candidate per joined row:

```ts
      if (nodeDef.input.kind !== "single") {
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
```

Widen the candidate type to carry either a single `instance` or a `row`.

- [ ] **Step 4: Fire a row in `tryFire`**

`tryFire` takes the row, builds the bag from it, supplies causation, and marks every instance in the row consumed:

```ts
    } else {
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
```

and in the consumption block:

```ts
    if (nodeDef.input.kind !== "single") {
      for (const instance of row!.values()) consumedBy(nodeName).add(instance.seq);
    } else if (origins.has(nodeName)) originsFired.add(nodeName);
    else if (instance !== undefined) consumedBy(nodeName).add(instance.seq);
```

- [ ] **Step 5: Run the suite and typecheck**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: green. **Existing `allOf` tests that asserted once-per-run firing will need updating** — that cap is the thing being removed, so those assertions were pinning the old behaviour deliberately (the spec's piece-(1) §5 said so). Update them to the new expectation rather than working around them, and say in your report which ones changed and why each is now correct.

- [ ] **Step 6: Prove the mispairing test can fail**

Temporarily replace the `joinRows` call with a latest-wins bag (one `log.latest` per declared edge, one row). The "never pairing across entities" test must redden. Restore, confirm green, put both outputs in your report.

- [ ] **Step 7: Commit**

```bash
git add spikes/ts-prototype/src/runtime.ts spikes/ts-prototype/src/runtime.test.ts
git commit -m "Fire an allOf node once per lineage group, not once per run

firedAllOf capped a fan-in at one firing, so a fan-out to several
context nodes and a fan-in that assesses them together saw one item.
The cap was deliberate while lineage did not exist; it does now.

The runtime gathers candidates per declared edge, asks joinRows which
combinations belong together, and fires a row at a time — supplying the
bag and the causation, since it is now what resolved the input."
```

---

### Task 6: Reconcile the prose that says `allOf` fires once per run

**Files:**
- Modify: `docs/getting-started.md` (build-order step 5), `readme.md` (Status block), `docs/design.md` (§5's `allOf` resolution), `docs/open-questions.md` (the no-loop-construct entry), `docs/superpowers/specs/2026-09-25-allof-joins-by-lineage.md` (status line)
- Modify: `spikes/ts-prototype/src/membrane.ts` and `src/runtime.ts` header comments describing `allOf` behaviour

Several documents state that `allOf` nodes fire at most once per run and that iteration works for single-input chains only. Both were true this morning.

- [ ] **Step 1: `getting-started.md` step 5**

It says cycles run "but `allOf`-input nodes still fire once per run, so iteration works for single-input chains only." Replace with what is now true: a fan-in fires once per lineage group, so a fan-out/fan-in diamond iterates per item. Keep the genuine remaining gap — composite nodes are still unbuilt.

- [ ] **Step 2: `readme.md` Status block**

It carries the same qualifier — "`allOf` joining by lineage isn't built — an `allOf` node still fires at most once per run, so iteration works for single-input chains only." Replace it with the built state and keep composite nodes in the not-built list.

- [ ] **Step 3: `docs/design.md` §5**

Check what it says about `allOf` resolution. Piece (1) left it describing latest-wins for `allOf` and noted the difference was temporary, naming a spec. Update it to describe lineage grouping, and remove the "temporary" framing now that it is resolved.

- [ ] **Step 4: `docs/open-questions.md`**

The "no loop construct" entry lists the four pieces and their status. Mark piece (3) built. Check whether anything else in that file asserts `allOf` fires once.

- [ ] **Step 5: The two module headers**

`runtime.ts`'s header comment says "`allOf`-input nodes still fire at most once per run (`firedAllOf`...)". `membrane.ts`'s header describes its `allOf` invoke as a readiness check against the Log. Both are now false. Fix each where it sits rather than adding a note.

- [ ] **Step 6: This spec's status line**

`Status: specified, not yet built.` → `Status: implemented.`

- [ ] **Step 7: Run the suite one last time**

Run: `cd spikes/ts-prototype && npm test && npm run typecheck`
Expected: green. Docs-only task, but this is the last gate.

- [ ] **Step 8: Commit**

```bash
git add docs readme.md spikes/ts-prototype/src
git commit -m "Reconcile the docs that say allOf fires once per run

getting-started, the README status block, design.md §5 and two module
headers all described the cap piece (3) just removed, several of them
naming it as temporary and pointing at the spec that has now landed.

Composite nodes stay in the not-built list — that is the one genuinely
remaining piece."
```

---

## Self-Review

**1. Spec coverage.** §1's two tiers → Task 3's `joinRows` (the envelope check and the latest-wins fallback). §2's group formation → Task 3. §3's zip → Task 3. §4's `firedAllOf` deletion and `eligibleForEdge` → Tasks 5 and 2. §5's membrane change, with all three consequences and the accepted `Failed<In>` cost → Task 4. §6's cost is documented in `joinRows`'s doc comment rather than implemented, as the spec requires. Every Testing bullet maps to a test in Tasks 1, 3, 4 or 5.

**2. Placeholder scan.** No TBDs. Fixtures are described rather than dictated in Tasks 3 and 5 — the same deliberate trade the previous two plans made, since `runtime.test.ts`'s `programWith` idiom is what they must follow and transcribing it would be worse. Each fixture's required *shape* is stated precisely.

**3. Type consistency.** `selfAndAncestorIds(log, instanceId): Set<string>` is defined in Task 1 and used in Tasks 3 and 5's tests. `joinRows(log, candidates): Map<string, LoggedInstance>[]` is defined in Task 3 and called in Task 5. `eligibleForEdge`'s six-parameter signature is defined in Task 2 and called in Task 5. `MembraneArgs`'s `allOf` branch becomes `[bag, context]` in Task 4 and is called that way in Tasks 4 and 5.

**4. Ordering.** Tasks 1-3 are purely additive — nothing calls them, so no behaviour moves. Task 4 changes the membrane while keeping the runtime on latest-wins, so its diff is about the interface rather than the join. Task 5 is the only task that changes what fires. Task 6 needs all of it true.
