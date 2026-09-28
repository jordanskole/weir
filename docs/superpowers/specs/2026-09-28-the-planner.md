# The planner

Status: draft.

## Motivation

`design.md` §8 calls it *"the important one"*:

> `plan(from: Edge, to: Edge) → [Topology]`, type-directed search returning
> candidate routes annotated with what the definitions already know — lossy or
> not, pure or effectful, depth, zone crossings, and observed success rate drawn
> from the log.

The `sys` queries now ship; this is the rest of §8, and the piece the readme
builds its dynamic-routing argument on: *"the model selects from the type-narrowed
set of nodes that can consume the edge it is currently holding, rather than from a
flat list of sixty tools and a hope."*

This spec builds the **search**. It does not build the **ranking**, and §5 says
why that is sequencing rather than avoidance.

## 1. The planner is the pulse loop, over types instead of tokens

The temptation is to write a graph path-finder. That would be wrong, and the way
it would be wrong is instructive: a linear path from `from` to `to` cannot pass
through an `allOf` node, because reaching one requires *two* edges to be
available and a path carries one. Any path-based planner silently routes around
every fan-in in the program — which is most of the interesting ones.

The rule weir already uses is the right one, one level up. `runNetlist` fires a
node when every edge it declares is available **as tokens**; the planner applies
a node when every edge it declares is available **as types**:

```
available = {from}
repeat: any node whose inputEdgeNames ⊆ available becomes applicable;
        applying it adds its output edges to available
until: `to` ∈ available, or nothing new is applicable
```

Same predicate (`inputEdgeNames ⊆ available`), same termination (a fixpoint, which
is quiescence with the tokens taken out). `allOf` falls out rather than needing a
case, and so does `gather`: both are just nodes whose declared input happens to
name more than one edge or the same edge many times.

**`Failed_*` edges are not available.** Every node can emit one, so admitting them
would make almost everything reachable "via failure" — technically true, never the
route anyone asked for, and it would drown every real answer.

## 2. A route is a topology, not a list

§8 says the return is `[Topology]`, and that is worth taking literally: a
candidate route should be something you could **write to a file and run**, not a
list of names a human then has to wire.

Deriving the wiring from a node set needs nothing new — `N` feeds `M` when `N`
produces an edge `M` consumes, which is the same producer/consumer relation
`weir sys` already computes. So a route carries a real `Wiring`, and the
`terminals`/`output` a topology also needs are exactly the node producing `to` and
`to` itself.

## 3. Enumeration is bounded, because §8 requires it

> Path enumeration requires bounded depth and top-k pruning.

Search over *sequences* of applications — at each step apply one applicable node —
bounded by a maximum length, deduplicated by the resulting **node set** so two
orderings of the same route are one answer. Return the top *k* by depth.

**Depth is measured in pulses, not nodes.** A route's depth is the longest chain
through its derived wiring, which is exactly the number of pulses `runNetlist`
would take. That makes the number mean something a reader already understands
rather than being a search artifact: two routes with five nodes each are genuinely
different if one runs in two pulses and the other in five.

## 4. Of §8's five annotations, two are available and one cannot exist

Worth enumerating, because the gap is not uniform and one of them is a
three-section contradiction rather than an unbuilt feature.

- **pure or effectful** — derivable today. `node.effect` says so.
- **depth** — derivable (§3).
- **zone crossings** — zones are unbuilt, so there is nothing to count *yet*.
  Decided in shape on 2026-09-28 though, and in a way that makes this annotation
  cheap when it lands: **a zone is a line in the topology**, not a per-node
  annotation as §7 assumes. A topology is already the declared boundary, so "this
  subgraph runs on the client" is one key on a file that already declares its
  input, output and terminals — and a node's zone is then the zone of the
  topology it was declared in, which inlining preserves in the qualified key
  (`investigate/investigateIdentity` came from `investigate`). A route's zone
  crossings become a lookup rather than a new mechanism. Out of scope here; see
  open-questions.
- **observed success rate** — needs the log (§5).
- **lossy or not** — **cannot be derived, and cannot currently be declared
  either.** §8 promises the annotation. §2 defines erasure as a converging
  triangle and says it *"must be declared — never inferred"*. And §10's `.node`
  format has no field for it. Three sections that do not line up: one promises an
  annotation, one forbids inferring it, and the third gives nowhere to write it.

  Not resolved here. Adding a field is a contract change that would move every
  node's hash, and deciding what erasure means precisely (is `allOf[A,B] -> C`
  lossy? is every converging shape?) is its own question. Recorded in
  `open-questions.md` rather than guessed at, and the planner reports the
  annotations it can stand behind rather than a `lossy: false` that means "nobody
  said".

## 5. Ranking is deliberately absent, and this is the whole reason

> Log statistics are the cost model, the way `ANALYZE` is for a query planner.
> Weights must remain **statistics, not parameters** — attributable to specific
> runs, or the planner stops being auditable.

There are no runs of a real program in this repo. `design.md` §10 says so, and
`soc-triage`'s own README says its domain nouns are deliberately fake. A cost
model built from fixture runs would rank by noise, and the obvious repair — a
hand-tuned weight to make the output look sensible — is precisely what §8 forbids.

So routes come back ordered by **depth**, which is a fact rather than a judgement,
and the ranking arrives when something real has run. Naming that here means the
unranked planner is a deliberate first half rather than an unfinished one.

## 6. What this does not make true

**Dynamic routing still does not exist.** §9's legal-move generator is the same
search asked one step at a time — *which nodes can consume the edge I am holding* —
and that question is answerable with what this builds. But choosing among them at
runtime, and the terminal-edge declarations §9 says dynamic mode additionally
requires, are a separate piece. `plan` is a design-time query here.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. A linear route is found: `plan(Recipe, Cookies)` on `examples/recipe` returns a
   route, and its wiring runs.
2. **A route through an `allOf` node is found**, which a path-based planner cannot
   do. `recipe`'s `bake` needs `Dough` *and* `Oven`; assert the route includes
   both arms. The case §1 exists for.
3. A route through a `gather` is found (`soc-triage`, `Alert -> AlertAssessment`),
   since a gather is just a node whose input names one edge many times.
4. An unreachable target returns **no** routes rather than a partial one.
5. `Failed_*` edges are not routed through: a target reachable only via a failure
   edge returns nothing.
6. Two orderings of the same node set are **one** route, not two.
7. Routes are ordered by depth, and depth counts pulses — a five-node route that
   runs in two pulses sorts ahead of a three-node chain that runs in three.
8. Each route's derived wiring is a real one: run it and get the target edge.
   The assertion that "a route is a topology" is not a figure of speech.
9. Annotations report `effectful` for a route through an `effect:` node and not
   otherwise — and no route claims anything about lossiness (§4).

## Explicitly out of scope

- **Ranking by log statistics** (§5).
- **`lossy` as an annotation** (§4), pending a decision recorded in
  open-questions.
- **Zone crossings** (§4) — zones are unbuilt.
- **Dynamic routing and the legal-move generator** (§6).
- **Writing a chosen route to a `.topology` file.** `plan` returns the wiring; a
  command that writes one is a separate, easy thing best decided once somebody
  wants it.
