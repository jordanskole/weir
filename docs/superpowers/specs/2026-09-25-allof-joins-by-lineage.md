# `allOf` joins by lineage

Status: implemented.

## Motivation

An `allOf`-input node fires **at most once per run** (`runtime.ts`'s `firedAllOf`), resolving each declared edge to its latest instance. That was a deliberate deferral in piece (1) — joining needed lineage, and lineage did not exist. Pieces (1) and (2) have since landed: instances are retained with ids, and `Envelope.causationIds` records what each invocation consumed, walkable via `ancestorsOf`.

So iteration currently works for single-input chains only. The shape it does not support is the one motivating the whole line of work: a fan-out to several context-gathering nodes and a fan-in that assesses them together, repeated per item. Today the fan-in fires once and sees one item.

This is piece **(3)** of four (design-history.md, "Iteration: it's a Petri net"). Piece (4), composite nodes, depends on it — viewed from outside its membrane a topology *is* an `allOf` node, so every composite entry point inherits whatever this decides.

## The problem with the obvious rule

The phrase this work has carried since the design conversation is *"the combination that fires is the one whose instances share an ancestor."* Taken literally it is useless: a correlation has one origin event, so **every** token in a run descends from the same origin instance, and any combination qualifies — including every wrong one.

Concretely. `extract entities` produces `Entity_1` and `Entity_2`. Three context nodes each fire per entity, giving `Identity_1, Endpoint_1, Network_1` and `Identity_2, Endpoint_2, Network_2`. All six share the origin, so "share an ancestor" happily pairs `Identity_1` with `Endpoint_2` — precisely the mispairing the rule exists to prevent.

What discriminates is the **nearest** shared ancestor: `Identity_1` and `Endpoint_1` share `Entity_1`, while `Identity_1` and `Endpoint_2` share only the origin. And `seq` delivers that for free — an ancestor is always strictly earlier, so the nearest common ancestor is the **highest-`seq` member of the intersection**.

**Self counts as an ancestor.** An `allOf` node consuming an edge straight from the origin — `bake: allOf[Recipe, Oven]` where `Recipe` comes off the origin — would never join under a pure-ancestors reading: `ancestors(R)` is empty, so the intersection with `ancestors(O) = {R}` is empty. Using *self-and-ancestors* gives `{R} ∩ {R, O} = {R}` and the two group on `R`. This is not a patch: if one instance is an ancestor of the other they plainly belong together, and joining a `Recipe` with the `Dough` made from it is the point. The pure-ancestors version only works for diamonds whose arms are the same length.

## Design

### 1. Two tiers, divided by whether lineage exists at all

| Candidates | Rule |
|---|---|
| Any has an envelope | group by nearest common ancestor, zip within the group (§2, §3) |
| None has an envelope | latest-wins per edge, fire once — today's behaviour |

An envelope records that a node invocation produced an instance. No envelope means nothing produced it: it was supplied from outside. That is the direct-invocation path — `invokeWithInput`, and therefore `fuzz.ts`, `accept.ts` and an agent tool call, all of which stage a bag into a scratch log with nothing to attach.

The second tier is therefore **not a test concession**. It is the production path for tool calling, where an agent supplies one value per edge and there is no lineage to join on because nothing upstream ran. For that case latest-wins is trivially correct — there is exactly one candidate per edge.

An instance with no envelope can fill any edge in any group, for the same reason piece (1)'s arc rule lets it bypass the wiring check: it has no producer, so there is no lineage to contradict.

> Both tiers exist only because a direct invocation is not currently a graph run. `open-questions.md` records the hunch that it should be — a one-node topology whose supplied values arrive as origin payloads — which would collapse this to one tier and retire piece (1)'s arc-rule bypass with it. Out of scope here; noted so the second tier is understood as a consequence rather than a design preference.

### 2. Group formation

Each pulse, for an `allOf` node:

1. Gather unconsumed candidates per declared edge, using the existing arc rule.
2. If no candidate anywhere has an envelope, apply the second tier and stop.
3. Otherwise map ancestor id → candidates descending from it, where descent uses **self-and-ancestors**.
4. Scan that map in **descending `seq`**. The first ancestor with at least one candidate on *every* declared edge is a group.
5. Fire the group (§3), mark its instances consumed, continue scanning.

Descending `seq` is what makes this the *nearest* common ancestor rather than any common ancestor, and it is what stops the origin forming a wrong group: by the time the scan reaches it, nearer ancestors have claimed their instances.

**Readiness falls out.** If `Entity_1` has an `Identity` and an `Endpoint` but no `Network` yet, no ancestor has descendants on all three edges, so no group forms and nothing fires this pulse. The next pulse the `Network` lands and the group completes. No separate waiting mechanism, and no readiness signal to plumb.

A group that never completes — an upstream node failed — simply never fires, and the run reaches quiescence with those instances unconsumed. Silent, and correct: there is no combination to fire.

### 3. Zip within a group

Sort each edge's candidates by `seq` and pair positionally: row *i* takes the *i*-th candidate from every edge. Fire one invocation per complete row; ragged leftovers stay unconsumed until partners arrive.

A group with 2 × 2 × 1 fires once and leaves one candidate pending on each of the first two edges. It does not fire twice against a reused third value, and it does not drop anything.

Zip rather than newest-of-each (drops data) or the cartesian product (multiplies it). It assumes the edges advance in step, which is true for a fan-out diamond — the shape this exists for — and not in general. When it is not, the leftovers wait rather than pairing wrongly.

### 4. `firedAllOf` is deleted

`allOf` nodes join the same `consumedBy(nodeName)` map single-input nodes already use; a firing marks every instance in its row consumed. Firing at most once per run stops being a special case and becomes a consequence of there being one group.

`eligibleInstances` returns `[]` for non-single nodes today. Factor out the per-edge filter both paths want:

```ts
function eligibleForEdge(
  program: Program,
  log: Log,
  consumed: ReadonlySet<number>,
  nodeName: string,
  edgeName: string,
  correlationId: string,
): LoggedInstance[];
```

`eligibleInstances` becomes that applied to the one declared edge; the `allOf` path calls it per declared edge. This removes duplication rather than adding a parallel path.

### 5. The membrane stops resolving `allOf` inputs

Today `membrane(nodeDef, log, context)` receives the **Log** and resolves the bag itself. Under lineage joining the runtime has already chosen a specific combination, so membrane must not re-resolve — doing so would discard the group and read the latest instead.

The runtime supplies the chosen bag. Membrane's `allOf` job narrows to asserting it, exactly as the `single` path asserts a supplied payload.

Three things follow, and each is a simplification rather than a cost:

- **The read-adjacency hazard retires.** `membrane.ts` documents that the runtime's bag rebuild and membrane's own read are safe only because both are synchronous with no `await` between them, and anticipates a backing store that breaks that. With one reader instead of two there is no window to be adjacent across. Piece (2) routed around this hazard and named "have the membrane return what it consumed" as the real fix; this resolves it from the other direction.
- **`allOf` causation moves back to the runtime.** Piece (2)'s rule — *whoever resolved the input records what it consumed* — is preserved exactly; what changes is who resolves. Membrane's `context.causationIds ?? resolvedIds` override becomes dead code and should be removed, not left inert.
- **Membrane's readiness `undefined` disappears.** If the runtime only calls with a complete bag, there is no not-ready case to signal, and `MembraneResult`'s conditional `| undefined` for `allOf` goes with it. The return collapses from three states to two.

**The accepted cost.** `invokeWithInput` currently depends on that readiness signal: it stages a partial bag and lets membrane return `undefined` to mean not-ready. Without it, an incomplete bag through the direct path becomes a `Failed<In>`. That is a behaviour change to the path `fuzz` and `accept` both use, and it is the more honest answer — a caller that supplied an incomplete bag made an error, and `Failed<In>` says so, where a bare `undefined` says "come back later" to a caller that has nowhere to come back from.

### 6. Cost, and where it goes when it matters

Per `allOf` node per pulse: gather candidates, walk `selfAndAncestors` for each, build the map, scan descending `seq`. Roughly **O(candidates × ancestor-set size)**. Ancestor sets grow with chain depth, so a long iteration gets progressively more expensive, and candidates that never complete a group are re-walked every pulse until quiescence.

Acceptable at spike scale, and deliberately unoptimized. Two outs exist when it stops being acceptable, and the second is the one a real runtime would want:

- Ancestor sets are immutable once written, so they cache per instance trivially.
- The branch key could be computed at **write** time and stored on the envelope, turning the join from a walk into a map lookup.

`ancestorsOf` returns instances while the join needs only ids, so an id-only variant is the obvious first refinement. Not added speculatively.

## Testing

- **The SOC shape.** Two entities, each fanning out to three context nodes, asserting the fan-in fires twice with correctly-matched rows. **The fixture must make the mispairing available** — a test asserting `{I1,E1,N1}` fired proves nothing if only one combination exists. Show the wrong pairing was possible and not taken.
- **An `allOf` node consuming an edge straight from the origin** fires. This is the case that forced self-and-ancestors; under pure ancestors it never fires at all.
- **An incomplete group waits.** Two of three edges present, nothing fires; the third arrives next pulse and the group completes, with the fan-in's `step` one past the longest path feeding it.
- **Zip.** A group with 2 × 2 × 1 fires once and leaves one candidate unconsumed on each of the first two edges.
- **A group that never completes** reaches quiescence without firing, rather than firing a partial row or spinning.
- **The externally-invoked tier.** An `allOf` node through `invokeWithInput` with a full staged bag still fires, so `fuzz` and `accept` are unaffected.
- **An incomplete direct invocation now yields `Failed<In>`**, not a bare `undefined` — the accepted behaviour change in §5, asserted deliberately so it is visible rather than discovered.
- **Causation after the move.** An `allOf` firing records the ids of the instances in its row, and those are the instances the runtime chose.

## Explicitly out of scope

- **Composite nodes.** Piece (4). It depends on this, since a topology viewed from outside is an `allOf` node.
- **Collapsing direct invocation into a one-node topology.** Recorded in `open-questions.md`; it would retire this spec's second tier and piece (1)'s arc-rule bypass together.
- **Optimizing the join.** §6 names the two candidate approaches; neither is built.
- **A declared join key.** Lineage is the key. A node declaring which field correlates its inputs was considered and rejected — it puts join plumbing back in the contract that lineage exists to keep out of it.
- **Cross-correlation joins.** Everything here is scoped to one `correlationId`, as all resolution already is.
