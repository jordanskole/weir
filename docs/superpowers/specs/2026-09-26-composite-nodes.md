# Composite nodes: a topology invoked as a node

Status: approved. Finite nesting only — recursive composition deferred (§3).

## Motivation

Piece (4) of the iteration line of work (design-history.md, "Iteration: it's a Petri net"), and the last one unbuilt. Three things are waiting on it:

- **The authoring format.** A join is a topology boundary (design-history.md, "A join is a topology boundary"), which is what lets a `.topology` file stay a tree and still describe a DAG. That resolution is recorded but unbuildable: there is no boundary to put a join at.
- **`noop`.** Designed and deliberately unbuilt, because a terminal marks a membrane closing and nothing closes.
- **`examples/recipe`'s double mention of `bake`.** It names `bake` twice because there is nowhere else to put the join.

Prior decisions this spec is bound by, all recorded 2026-09-25:

1. A single topology only fans out; reconvergence happens at a membrane.
2. The join sits at the producing topology's **exit** — a membrane is `allOf`-shaped on both sides.
3. A membrane closes on **declared terminal markers**, not inner quiescence.
4. A topology-as-node is handed the **whole log**, not a scoped export view.

## 1. Declaration

Decided by Jordan: a `.topology` file declares its own contract, rather than a `.node` file pointing at a topology body.

```yaml
# declarations/investigate.topology
input: Entity
output:
  allOf:
    - IdentityContext
    - AssetContext
terminals:
  - noop_IdentityContext
  - noop_AssetContext
wiring:
  investigateIdentity:
    then:
      noop_IdentityContext: {}
  investigateAsset:
    then:
      noop_AssetContext: {}
```

The filename is the name, as it is for `.field`/`.edge`/`.node`. `elaborate.ts`'s header comment currently draws the opposite distinction — *"`.topology` is different in kind — a wiring description, not one more named declaration — so it has no filename-as-name convention at all"* — and must be corrected rather than left to contradict the code.

**A root topology needs no contract.** It is invoked by the outer membrane with `originPayloads`, not by a parent, so `main.topology` keeps its current bare-wiring shape. A file is a composite exactly when it declares `input:` at the top level. That keeps all five existing examples untouched, at the cost of one documented restriction: `input`, `output`, `terminals` and `wiring` are reserved and a node may not be named any of them.

## 2. Contract, hashing and resolution

A composite has a real contract, so it hashes like one: `fingerprintNode` covers input, output, closure, properties and scope today, and a composite adds `terminals`. It needs the hash for the same reasons every node does — drift detection on replay, and resolution.

What it resolves to is different. A primitive resolves to host code; a composite resolves to a wiring. `readme.md` already states the model: *"Graphs nest without limit and bottom out at a primitive — a node whose body is host code rather than more graph."* This is that sentence implemented.

## 3. How a composite runs — and the recommendation

Two implementations, and they differ far more in cost than in observable behaviour.

**(a) A runtime membrane.** The composite is a node in the outer pulse loop. When it fires, an inner pulse loop runs its wiring against the same log and correlation, seeded from the composite's input, and closes when every declared terminal has fired. This is the reading decisions (2)–(4) were written against: a real boundary, a real closing condition, `depth` finally meaning something at runtime.

**(b) Inlining at elaboration.** The composite's wiring is spliced into its parent's, its nodes given qualified instance names, its input arc wired to its inner origins and its terminals' arcs wired to whatever consumed the composite. The runtime is untouched — it never learns composites exist.

**Resolved: (b), with recursive composition deferred.** Jordan's ruling — finite nesting is enough for the spike. This deserves stating plainly because it looks like a retreat from the recorded decisions. It is not, but it does reinterpret them.

What the boundary was for was *authoring*: a `.topology` file is geometrically a tree and cannot express reconvergence, so joins had to move somewhere else. Inlining preserves that completely — every authored file stays a tree, and the elaborator assembles the DAG, which is already its job. What inlining gives up is a boundary at *runtime*, and what that was buying:

- **Decision (4), "handed the whole log", becomes vacuous** — there is one log and one flat wiring, so there is nothing to scope and nothing to hand. The decision was reasoning about a runtime membrane that (b) does not create.
- **Decision (3), terminals, becomes an elaboration-time fact** rather than a closure condition: a terminal is the node whose output is the composite's output, which is what the outer wiring needs in order to splice. `noop` still earns its place — it is what a branch ends in when its last real node's output is not the shape the contract promises — but it marks a *wiring* boundary rather than gating a *runtime* one.
- **`depth` stays a netlist naming concept**, which is what it already is.

**DRY is unaffected, which was the concern that prompted the §1 ruling.** Inlining duplicates nodes in the *netlist*, never in the source: one `.topology` declaration, referenced N times, the way an inlined function or a template instantiation works. A topology also remains independently invocable — it is a program, and `runNetlist` takes one. The only thing inlining costs is recursive composition.

**What that defers, recorded rather than dismissed.** A composite cannot reference itself, so `readme.md`'s *"graphs nest without limit"* is, under (b), finite nesting rather than unbounded. That is a real gap in a framework whose stated position is that recursion is primitive and iteration derived (design-history.md: `while` needs ambient state, recursion does not, and a node feeding itself with a `oneOf` base case already *is* the recursive form) — composites become the one kind of node that cannot feed themselves. Nothing in this repo needs it: the investigation loop people reach for is a *cycle*, which works today. Also deferred with the runtime membrane: dynamic invocation, isolation, and per-composite budgets.

The cost of being wrong is asymmetric, which is the other half of the argument. (b) is contained in `elaborate.ts` with no runtime change; (a) is a nested scheduler, a second readiness rule and a closure condition. If (b) turns out insufficient, its flattened wiring is exactly what (a) would need anyway.

**Two references to one composite become two independent node sets**, which is not a compromise but the wanted behaviour: it is the same rule positional identity asks for — two mentions are two instances (open-questions.md, "Positional identity in a topology") — falling out of the flattener for free.

## 4. Inlining, concretely

For a composite `investigate` referenced in a parent wiring:

- Every node in the composite's wiring is added to the program under a qualified name, `investigate/investigateIdentity`, so two uses of one composite do not collide and the netlist can address them.
- The composite's declared `input` edge is wired from whatever fed the composite: every arc `X -> investigate` becomes `X -> investigate/<each inner origin>`.
- Every arc `investigate -> Y` becomes `investigate/<each terminal> -> Y`.
- The composite node itself disappears from the wiring.

`assertWiringTypes` then runs over the flattened wiring and checks the whole thing uniformly, with one addition: a composite's declared `output` must be satisfied by its terminals' outputs, and its declared `input` by what its inner origins consume. That is Rule B applied at the boundary rather than a new rule.

## 5. Testing

Break-proofs required for each; `tsconfig.json` excludes `src/**/*.test.ts`, so test files are never typechecked.

1. A `.topology` with an `input:` header elaborates to a composite; one without is a root and behaves exactly as today. Every existing example must be untouched and still pass.
2. A composite referenced in a parent wiring flattens: its nodes appear qualified, the composite name does not appear, and the arcs reconnect at both ends.
3. Two references to the same composite in one program do not collide.
4. `examples/recipe` rewritten with `bake`/`cool` as a composite stops naming `bake` twice, and produces an identical log to the flat version — the same run, authored as a tree.
5. A composite whose terminals do not satisfy its declared `output` is rejected at elaboration.
6. A cycle of composites (a composite referencing itself, directly or transitively) is rejected at elaboration rather than looping the flattener.

## 5a. Found while building: inlining renames origins

If a composite is itself the root's origin — which is what `examples/recipe` becomes once its fan-out moves inside one — inlining replaces it with its inner origins under qualified names, so `runNetlist`'s `originPayloads` must be keyed `prepare/mix` rather than `mix`. The caller has to know the composite's interior to start the run, which is exactly what a boundary is supposed to hide.

Not fixed here, and not a blocker: no shipped example uses a composite as a root origin. The candidate answer is that `originPayloads` should be keyed by the *authored* name and expanded during inlining, alongside the wiring — which is a small addition to the flattener rather than a design change. Recorded so it is found deliberately rather than discovered by a confusing failure.

## 6. Explicitly out of scope

- **Runtime membranes** (§3(a)), and with them **recursive composition**, dynamic invocation, isolation and per-composite budgets. A composite referencing itself is rejected at elaboration (§5.6) rather than supported.
- **Any bound on node size.** Ruled 2026-09-26: fat nodes are legitimate and will be needed. Nothing forces single responsibility inside `Fn`, deliberately — the pressure is that the acceptance gate scales with contract breadth, and that the decomposition is the whole human-authored surface. A complexity score belongs to Kleisli, not here.
- **`noop`'s synthesis**, which lands with this but is specced separately (2026-09-25-system-nodes-run-root-and-noop.md §6).
- **Positional identity** (`birthday.then.birthday.then.birthday`), unblocked by the boundary decision but a separate build task.
