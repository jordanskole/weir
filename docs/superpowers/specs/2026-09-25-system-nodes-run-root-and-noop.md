# System nodes: the run root and `noop`

Status: draft.

## Motivation

Three gaps documented over 2026-09-25 turned out to want the same missing thing, and a fourth decision made one of them load-bearing:

- **A fan-in fed by two independent origin nodes never fires**, because an origin's output carries `causationIds: []` and two origins therefore share no ancestor to group on.
- **An identity-shaped node immediately after the origin is the only way to build a fan-in at all.** `examples/recipe`'s `gatherIngredients: Recipe → Recipe` looks like dead weight and is load-bearing: it mints the one `Recipe` instance `mix` and `preheatOven` both descend from. Confirmed by execution while reshaping `examples/todo-list` — an origin with an `allOf` output emitting two edges gives *both* `causationIds: []`, the intersection of their ancestor sets is empty, and the run reached quiescence with 3 of 4 nodes fired and no error.
- **Direct invocation isn't a topology**, which leaves `invokeWithInput` outside the model.
- And since a topology-as-node is now handed the whole log, with lineage rather than a scoped export list doing the bounding (design-history.md, "A topology-as-node is handed the whole log"), **ancestry being total is what keeps composite nodes honest** — not merely what makes fan-in convenient.

Both members here are *system nodes*: their contract determines their implementation, so there is nothing for an agent to draft and nothing for the acceptance gate to accept (open-questions.md, "System nodes"). That is the category test, and this spec's first job is to check whether both members actually pass it.

**Build order: `noop` is specced here and built second.** Its load-bearing job is marking branch completion so a membrane's closure is decidable — and a terminal marks *a membrane closing*, which is composite nodes, piece (4), unbuilt. Its other job, standing in for the identity origin, is the one the run root deletes. So it has no exercisable job until (4). The run root is exercisable immediately.

## The category test, applied

`noop` passes cleanly: `noop_X : X → X` has one sensible implementation, a real contract, and a real (trivial) computation.

**The run root does not, and that is the spec's first finding.** It has no input, does no work, and computes nothing. Calling it a node requires exactly the `Unit`-shaped input `design-history.md` ("The membrane") already floated and rejected. Reintroducing that to preserve a slogan is the wrong trade.

**Resolved: the run root is a seeded *instance*, not a node.** It is one instance of a synthesized `Run` edge, appended by the runtime before any origin fires. This is the "represent the external event itself as a token" candidate already recorded in `open-questions.md`, taken literally: the trigger becomes a token because the trigger *is* data, not a computation.

So the category has one member today. That is a finding, not a failure — the value of speccing them together was deciding the shared mechanism once, and the answer is that they do not share one.

## Part 1: the run root

### 1. A synthesized `Run` edge, one instance per run

`elaborate.ts` synthesizes a `Run` edge the way `synthesizeFailedEdges` already synthesizes `Failed_X` — a fixed shape, not one per declared edge:

```
Run
  correlationId : utf8, not nullable
  triggeredAt   : datetime, not nullable
```

`runNetlist` appends exactly one `Run` instance per run, before pulse 1, with no envelope of its own (nothing produced it — it is the root by definition, and `causationIds: []` is *true* of it rather than a gap).

Deliberately minimal. The trigger payload is **not** carried on it: origin payloads already reach their nodes through `originPayloads`, and duplicating them onto the root would make the root's schema depend on the program.

### 2. Every origin node's output cites it

Today `logOutput` writes an origin node's output with `causationIds: []`. It becomes `[<run instance id>]`. Nothing else changes: `ancestorsOf` and `selfAndAncestorIds` already walk `causationIds` transitively and need no modification.

Consequences, all of which are the point:

- Two instances emitted by one origin firing (an `allOf` output) now share the root, so they group and the fan-in fires.
- Descendants of two different origin nodes now share the root, closing the multi-origin gap.
- `gatherIngredients: Recipe → Recipe` stops being necessary: `mix` and `preheatOven` could both be origins and `bake` would still join.

### 3. The pairing question — the hard part, and it is narrower than feared

The recorded worry (open-questions.md) is that once everything shares the root, the root becomes the pairing free-for-all the hold rule was added to prevent. Worked through against the shipped rule, most of it is already covered.

Two alerts in one run, each fanning out to identity/asset evidence, with `assembleEvidence: allOf[IdentityContext, AssetContext]`:

```
selfAndAncestors(identityA) = {identityA, entityA, alert1, root}
selfAndAncestors(assetA)    = {assetA,    entityA, alert1, root}
    -> intersection {entityA, alert1, root}, highest seq = entityA   correct pair

selfAndAncestors(identityA) = {identityA, entityA, alert1, root}
selfAndAncestors(assetB)    = {assetB,    entityB, alert2, root}
    -> intersection {root} only                                      cross pair
```

Group formation already prefers the highest-`seq` common ancestor, so the correct pair wins on ordering alone. The dangerous case is only when the correct partner has not arrived yet and the cross pair is the *only* complete row available. That is exactly what the hold rule covers: `identityA` has a strictly nearer incomplete ancestor (`entityA`), and a peer of that ancestor's node (`entityB`) holds the missing edge, so `identityA` is held out of the root group until `assetA` lands.

**The residual is genuinely narrow**: the hold rule's peer clause compares instances of the *same* node, so it does not fire when the two lineages start at two *different origin nodes*. That combination — several distinct origin nodes, each rooting an independent lineage that later fans in — is the one case the root does not make safe.

**Resolved: the root does not participate in group formation as an ancestor of last resort.** A group whose nearest common ancestor is the run root itself is refused unless the root is the *only* ancestor any candidate has — that is, unless every candidate is a direct origin output. This keeps the root doing its job (making ancestry total, so lineage walks terminate and composite nodes can rely on them) without letting it become a join point. Grouping at the root is then a deliberate, checkable special case rather than a fallback that silently captures unrelated lineages.

### 4. Migration, not addition

This changes observable behaviour for every existing run: `causationIds` on origin outputs goes from `[]` to `[rootId]`, and existing tests assert the empty form. Expect to touch `runtime.test.ts`, `membrane.test.ts`, `lineage.test.ts` and `replay.test.ts`.

`replayInvocation` needs specific attention: it re-feeds `causationIds` for a `single`-input node, so a replayed run must either reuse the recorded root id or mint a new one consistently. Reuse is correct — a replay reconstructs a past run, and inventing a new root would make the replayed lineage disagree with the recorded one.

### 5. What this does *not* fix

The run root makes ancestry total. It does not supply *well-formed groups* — that is `spread`'s job (open-questions.md, "There is no fan-out primitive"). A run root plus no spread still cannot express one alert fanning out to N entities.

## Part 2: `noop`

### 6. Synthesis, one per declared edge

`noop_X : X → X`, synthesized by the same linear scan as `synthesizeFailedEdges`, so the declaration language needs no generics and no polymorphic node kind. Synthesized from the edge table *after* `Failed_X` synthesis, from a snapshot, so no `noop_Failed_X` is generated unless an author declares a node consuming one.

### 7. Its job is branch termination

A composite node closes when every declared terminal has fired (design-history.md, "A membrane closes on terminal markers"). `noop` is the terminal: it needs no implementation, it carries the branch's edge unchanged so the membrane's exit contract has a definite shape, and being declared rather than inferred makes closure checkable at elaboration instead of only observable at runtime.

Its second, formal job: outside a cartesian category the copy morphism `Δ` must be written explicitly, and `noop` is where weir writes it (design-history.md, "A join is a topology boundary").

### 8. Why it is not built here

Both jobs need something that does not exist. Branch termination needs composite nodes (piece 4) to terminate into. The copy morphism is the identity-origin workaround, which Part 1 deletes. Building `noop` before piece (4) would ship a node with no exercisable job and no honest test — the vacuity pattern this repo has shipped five times, at the topology layer.

**Recorded here so the design is settled when (4) starts, and deliberately not implemented.**

## Testing

Break-proofs are required for each: deliberately break the implementation and confirm the test reddens. Note that `tsconfig.json` excludes `src/**/*.test.ts`, so test files are never typechecked — review them as unchecked code.

1. A `Run` instance exists in the log after any run, exactly one, with the run's `correlationId`.
2. An origin node's output carries `causationIds: [rootId]`, not `[]`.
3. `examples/recipe` with `gatherIngredients` removed and `mix`/`preheatOven` as two origins: `bake` still fires, and its `causationIds` name both arms. This is the multi-origin gap closing, and it must fail before the change.
4. The `allOf`-output shape that failed in execution today: one origin emitting `TodoList` and `NewTodo`, a downstream `allOf[TodoList, Todo]` — fires, where it previously reached quiescence with the node silently unfired.
5. Two independent lineages in one run whose correct partners arrive out of order: the hold rule keeps them apart, and no row pairs across lineages. Assert by execution, not by reasoning — this is the case whose earlier version produced a Critical at the last gate.
6. A group whose only common ancestor is the root, where candidates are *not* all direct origin outputs, is refused (§3).
7. Replay of a recorded run reuses the recorded root id rather than minting a new one.

## Explicitly out of scope

- **`spread`** — the third candidate system node, and the one that supplies well-formed groups. Separate spec.
- **Composite nodes** (piece 4), which `noop`'s real job depends on.
- **Keyed versus ordered collections** (open-questions.md) — orthogonal, and blocking neither part here.
- **Removing the identity origins from the existing examples.** Part 1 makes them unnecessary; the example rebuild is its own work, and `examples/recipe` should keep running unchanged through this change as evidence that it is backward-compatible.
