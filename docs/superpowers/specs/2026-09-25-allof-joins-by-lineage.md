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

An envelope records that a node invocation produced an instance. No envelope means nothing produced it: it was supplied from outside. The tier handles candidates with no lineage, and latest-wins is trivially correct for them — there is no lineage to join on because nothing upstream ran.

**Correction, 2026-09-25 (this branch's final review).** This paragraph used to continue: *"That is the direct-invocation path — `invokeWithInput`, and therefore `fuzz.ts`, `accept.ts` and an agent tool call, all of which stage a bag into a scratch log with nothing to attach,"* and concluded that the tier is *"not a test concession… the production path for tool calling."* **§5 falsified that while this same spec was being built.** Removing the membrane's bag resolution also removed `invoke.ts`'s scratch-`InMemoryLog` staging: `invokeWithInput` now hands the bag to `membrane` directly and never calls `joinRows` at all. So none of the four named callers reach this tier. The only route left is a host that stages envelope-less instances into a real `Log` and runs `runNetlist` over them — which today means tests. The tier is still correct, and still the right answer for such a host; what was false was the claim about which callers arrive at it. This is a consequence of §5 rather than an oversight in §1: the justification described a staging step that §5 deleted.

An instance with no envelope can fill any edge in any group, for the same reason piece (1)'s arc rule lets it bypass the wiring check: it has no producer, so there is no lineage to contradict.

> Both tiers exist only because a direct invocation is not currently a graph run. `open-questions.md` records the hunch that it should be — a one-node topology whose supplied values arrive as origin payloads — which would collapse this to one tier and retire piece (1)'s arc-rule bypass with it. Out of scope here; noted so the second tier is understood as a consequence rather than a design preference.

### 2. Group formation

Each pulse, for an `allOf` node:

1. Gather unconsumed candidates per declared edge, using the existing arc rule.
2. If no candidate anywhere has an envelope, apply the second tier and stop.
3. Otherwise map ancestor id → candidates descending from it, where descent uses **self-and-ancestors**.
4. Scan that map in **descending `seq`**. The first ancestor with at least one candidate on *every* declared edge is a group, once held candidates are excluded (below).
5. Fire the group (§3), mark its instances consumed, continue scanning.

Descending `seq` is what makes this the *nearest* common ancestor rather than any common ancestor.

**The safeguard this spec originally claimed, and why it was wrong.** The sentence that stood here was: *"and it is what stops the origin forming a wrong group: by the time the scan reaches it, nearer ancestors have claimed their instances."* It is stated as it was rather than quietly replaced, because the reasoning is exactly what a future reader would otherwise re-derive.

It holds only when the nearer groups **complete**. A nearer ancestor that is still half-formed claims nothing, and the scan walks straight past it to the run origin — a genuine common ancestor of everything in the run. The branch's final review reproduced this by execution, not argument: take the SOC shape and stall the two arms in *opposite* directions (`leftGate` stalls entity B, `rightGate` stalls entity A). On the first pulse the fan-in is offered anything, `Left = [L_A]` and `Right = [R_B]`. `E_A` has a Left and no Right; `E_B` has a Right and no Left; neither group is complete; the scan reaches the alert and fires `left-a-A|right-a-B`. Two pulses later the leftovers mirror it. The run reaches quiescence having fired two rows, both cross-entity — the wrong answer at full confidence, which is precisely what the join exists to prevent. The one-direction fixture never exposes this because its slow entity always completes before the origin gets a turn.

**The rule that replaces it.** A candidate may not join at ancestor `A` if it has a **strictly nearer** ancestor that is currently **incomplete** — that nearer ancestor has unclaimed candidates on some of the node's declared edges but not all.

On the failing case: `L_A` is held because `E_A` has a Left and no Right, `R_B` because `E_B` has a Right and no Left. No group forms and the run waits. On the working case `L_B` and `R_B` still group at `E_B`, and `L_A` joins once `R_A` arrives; if `R_A` never arrives, `L_A` never fires, which is the "group never completes" case above and already accepted.

**One qualification the implementation had to add, and it is not cosmetic.** Taken literally, that rule holds *everything* forever. A `Left` candidate's own id is an ancestor key carrying a Left and no Right, so every candidate always has a nearer incomplete ancestor — itself — and so does every intermediate hop on whichever arm arrived first. Implemented literally, 13 of the spike's tests fail, including the plain diamond: nothing ever fires. Nothing in lineage alone separates `E_A` (an entity whose other arm is still in flight) from `hop3_A` (a step on the arm that already landed) — both hold a Left and no Right.

What does separate them is a **peer**: another instance of the *same producing node*, off the held candidate's own lineage, carrying an unclaimed candidate on an edge the nearer ancestor is missing. Two instances of one node are two items at the same stage of the graph; when they hold opposite halves of a fan-in, the arms are mid-flight in opposite directions and falling through to a common ancestor would pair the two items with each other. `hop3_A`'s peer `hop3_B` holds a Left too, not a Right, so it holds nothing back. So the implemented rule is the rule above with "and a peer of that ancestor holds an edge it is missing" appended.

That qualification is an approximation, and the limit is worth stating: two arms that diverge at *different* nodes, rather than at two instances of one node, are not held and could still mispair. The sound test is "is work still in flight below this ancestor", which needs either an index of unconsumed descendants or the program's wiring; `joinRows` takes a `Log` and candidates and has neither. Recorded as the shape of the real fix rather than papered over.

Three properties this rule preserves, all of them live in the implementation:

- **Envelope-less candidates are never held.** They have no ancestors, so the test is vacuously false for them, and the latest-wins tier and the wildcard behaviour are untouched.
- **Completeness is judged against currently-unconsumed candidates** — the same set the scan is already working from, which is what makes it evaluable per pulse. A candidate an earlier group claimed is not available.
- **The behaviour is temporal, and that is intended.** A candidate held this pulse may join the next. The rule is not a function of lineage alone; it depends on what is currently unconsumed.

One further consequence, tested rather than assumed: an ancestor *can* become incomplete because an earlier group claimed the other edge's candidate — the review expected this to be impossible. A ragged zip claims matched pairs and leaves the surplus, so one edge under an ancestor can be drained while the other keeps a leftover. The stranded leftover still joins at its own nearest common ancestor, because a once-fired node has no peer to hold it back (`lineage.test.ts`, "emptied by an earlier group's claim").

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
- **The SOC shape with the arms stalled in opposite directions** (added by the final review). Both entity groups are incomplete at once, so the wrong pairing is not merely available but is what an unguarded scan actually produces. The assertion is on the *pairing*, never the count: a fall-through to the origin fires two assessments too.
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
