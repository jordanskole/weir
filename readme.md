# Weir

Two things changed about writing software, and only one of them has been absorbed.

The first is that most code is now drafted by an agent, so the interesting human work moved from writing implementations to specifying them. The second, less noticed: the thing that has to *read* a codebase in order to work in it is increasingly also not a human. Almost nothing about how we structure programs has adjusted to that. We are still producing artifacts optimized for a reader who skims, holds context in their head, and asks a colleague when the call graph gets confusing.

Weir is a bet on both halves. It is a declarative framework for building applications out of two things:

- **edges** — pure data schemas, the complete description of what crosses a wire
- **nodes** — pure functions from one edge to another

An application is a directed graph of nodes wired together by their edge types, declared before anything runs rather than assembled step by step as it goes.

The name comes from a fish weir: rather than watching the whole ocean, you build the one narrow place everything has to cross, and check it there. Edges are those crossings.

> **Status: early, but it runs.** The example below elaborates from real `.edge`/`.node`/`.topology` files and executes end to end — schema assertion, multi-input readiness, `Failed<In>` routing, structural hashing, and implementation resolution by contract hash all work against files on disk, with a test suite over them.
>
> Not built yet: the planner and the rest of the `sys` queries, zones and classification, property-based generation, composite nodes, and any log that outlives the process. The host language is also undecided — `spikes/ts-prototype/` is a spike and the current lean is OCaml — so treat the TypeScript as evidence the design holds together rather than as the implementation.
>
> The design is being pressure-tested against [blue-ribbon-properties](https://github.com/jordanskole/blue-ribbon-properties), a separate project whose independent constraints keep surfacing edge cases here.

## A program

Edges are files. Here is one:

```yaml
# declarations/Ingredient.edge
label: Ingredient
description: A single ingredient in a recipe, with how much of it is needed
index: name
fields:
  name:
    type: utf8
    label: Name
    description: The ingredient's name
    nullable: false
  amount:
    type: utf8
    label: Amount
    description: How much is needed, as it would appear on the recipe (e.g. "2 cups")
    nullable: false
```

There is no `name:` field at the top level. The filename is the name — one place to write it down means it cannot drift out of sync with itself.

Edges compose by reference, not inheritance. A bare name in a field position resolves against whatever file declares it, so `many: Ingredient` embeds the `Ingredient` edge and `email: email` reuses a `.field` declared once:

```yaml
# declarations/Recipe.edge
label: Recipe
fields:
  title:
    type: utf8
    nullable: false
  ingredients:
    many: Ingredient
```

Because `Ingredient` declares `index: name`, `many: Ingredient` materializes as a map keyed by that field, not a list.

No node takes or returns a bare array. A node's input and output are always edges, and an edge is a named schema — an array has no schema-level identity for its elements, so there is nothing to wire, key, or address. Inside a payload, order is just data; at the boundary it would be structure the graph cannot see.

A node declares a contract and nothing else — no body:

```yaml
# declarations/bake.node
label: Bake
description: Bakes the dough into cookies, once the oven has preheated
input:
  allOf:
    - Dough
    - Oven
output: BakedCookies
examples:
  - given:
      Dough: { title: "Chocolate Chip Cookies", servings: 24 }
      Oven:  { temperature: 375, preheated: true }
    expect:
      BakedCookies:
        title: "Chocolate Chip Cookies"
        servings: 24
```

`input: allOf:` is a readiness condition, not a wire. The runtime calls the function once both a `Dough` and an `Oven` exist for this correlation id, however many invocations separate their arrival — here, whichever of mixing and preheating finishes second. No join, no accumulator, no ordering requirement.

The wiring is its own file:

```yaml
# declarations/main.topology
gatherIngredients:
  then:
    mix:
      then:
        bake:
          then:
            cool: {}
    preheatOven:
      then:
        bake: {}
```

`mix` and `preheatOven` both run off `gatherIngredients`'s output, independently — the dough gets mixed while the oven heats, and `bake` names as its own child under *both*. That is the whole program. The implementation of `bake` lives in a different tree, resolved by name and contract hash, and is regenerable build output rather than something you maintain.

**A topology is a node.** A subgraph with one input edge and one output edge is indistinguishable from a single node at its boundary, so this file can be dropped into a larger graph wherever a `Recipe -> Cookies` node is expected, and nothing upstream can tell the difference. Graphs nest without limit and bottom out at a **primitive** — a node whose body is host code rather than more graph. There is no separate module system, because the composition rule already is one.

## What a run leaves behind

Elaboration turns those files into a netlist — concrete nodes, concrete edges, no type variables. Execution appends to a log. For this recipe, the log opens like this:

```json
{ "instance": "gatherIngredients#1", "edge": "Recipe", "payload": { "title": "Chocolate Chip Cookies", "servings": 24 },
  "envelope": { "id": "env-1", "correlationId": "run-1", "causationId": null,    "step": 0 } }

{ "instance": "mix#1",               "edge": "Dough",  "payload": { "title": "Chocolate Chip Cookies", "servings": 24 },
  "envelope": { "id": "env-2", "correlationId": "run-1", "causationId": "env-1", "step": 1 } }

{ "instance": "preheatOven#1",       "edge": "Oven",   "payload": { "temperature": 375, "preheated": true },
  "envelope": { "id": "env-3", "correlationId": "run-1", "causationId": "env-1", "step": 1 } }
```

Two entries at `step: 1`, both caused by the same `env-1` — `mix` and `preheatOven` are independent, concurrent applications of the same origin, not a sequence. `bake` waits for both before it can append its own entry.

That log is the source of truth. Node state is a fold over prior edges keyed by correlation id. The tables an application shows you are materialized views over it. Both the tables and any node's implementation can be deleted and rebuilt from it; the only durable artifacts are edge definitions and topology.

This holds because **effects are data**. A node does not call a database — it returns a description (`{ fetch, url }`, `{ sleep, duration }`) and the runtime is the only thing that performs it. Replay feeds back the *recorded* result instead of re-performing, which is what makes determinism survive contact with the outside world.

## What the shape buys

**A decision becomes a type.** A node that classifies does not hand back what it was given:

```yaml
input: BakedCookies
output:
  oneOf:
    - Cookies
    - Underbaked
```

The consumer's input type *is* the proof the decision was made, so it is never re-derived and never re-derived differently. Branches must be genuinely exclusive — exactly one fires.

**Some things become unreachable rather than merely discouraged.** If only `authorize` emits `AuthorizedPayment`, and `charge_card` takes `AuthorizedPayment` as input, then charging an unauthorized card is not a code review finding. There is no wiring that expresses it.

**Failure is an edge, not a mechanism.** Every node's real output signature includes `Failed<In>`, carrying the original payload so a retry node has something to re-emit. Retry is a node consuming `Failed<In>`. Dead-letter is a node with no output. Unhandled failure is a type error rather than a 3am surprise. Authors don't write the catch — an uncaught exception becomes `Failed<In>` automatically.

## No ambient state, and therefore no loops

Nothing a node can read is invisible in its contract. No instance fields, no module globals, no context object threaded through, no accumulator carried between calls. Everything a node sees arrives as a declared edge, which is what makes a node testable without constructing a world around it, and replayable without reconstructing one.

The obvious objection is iteration. Every loop most people write has an accumulator — a slot you re-enter and mutate — and that slot is ambient state by definition.

It turns out the array ban already closed that door. There is nothing to push onto. A collection is keyed, so the thing a loop would have built up incrementally is instead addressed directly: `many Ingredient` fans out into N independent invocations, each producing an edge keyed by the same id, and reassembly is a lookup rather than an append. Order stops being load-bearing, which is also why arrival order doesn't matter to `every:`.

And a cycle in the wiring is not a loop. A node has no instance to re-enter, so `C` feeding back into `A` is a fresh application of the same function to new data, indistinguishable from any other forward step. What a `while` loop needs — a mutable slot, re-entered in place — has nowhere to live here. The log already holds every intermediate value a loop would have accumulated, so the accumulator was redundant with the log the whole time.

**Tests live in the contract.** You have already seen them: the `examples` block in `bake.node` is written in the same composition syntax used to wire nodes together, and `expect` is an ordinary node with `oneOf: [Pass, Fail]`. A test run is a graph execution on production machinery, so a production log entry can be promoted to a test case directly.

Examples are the weaker half. Because a node's input is fully typed, that type doubles as a generator — `age: uint8` supplies a domain, `validations.min`/`max` narrow it, `enumValues` enumerates it — so a property like *mix never changes a recipe's title or serving count* costs about as much to write as one example and rules out far more. There is nothing to mock, because there are no impure dependencies to isolate.

## Authoring when you don't write the bodies

A node here cannot hide anything. Its contract is its input and its output and that is genuinely all of it.

That rules out classes, and not on taste. A class holds state and holds the methods that operate on it, which is two responsibilities braided into one artifact — the S in SOLID says don't, and Hickey has a better word for it. The practical consequence is `this`: a method's result depends on something that is not among its arguments, so you cannot test it without building the surrounding object, cannot generate inputs for it from its signature, and cannot replay it without restoring whatever the object happened to be holding at the time. Every guarantee on this page dies at the first `this.`.

So the artifact a human reviews is the graph and the edge definitions — the ontology and the topology, which are the parts that are actually hard and that no test can check for you.

**The division of labor is a rule, not a convention.** Humans do not write function bodies; machines do not write edges, nodes, or topologies. When a node comes out wrong, the repair is not to open the generated file and patch the logic — it is to sharpen the contract, add the example or property that would have caught it, and regenerate. Editing the implementation puts a fact about the program in the one place nothing reads, and the next regeneration silently discards it.

That gives a clear ordering of what deserves attention, highest risk first: **ontology, topology, examples, implementation.** Nothing mechanical can tell you your edge set carves the domain correctly. Reachability and cut-vertex analysis can at least tell you things about the topology. Tests can only check a node against a carve you already chose. The generated code is the part that matters least, which is convenient, because it is the part you are not writing.

This sounds like a small procedural preference. Give it two years.

## Code an agent can read

The other half, and the one most frameworks skip. A weir program is not a pile of files an agent has to reconstruct meaning from — the topology, the ontology, and the log are all data, so the framework ships queries over them: what edges exist, what refines what, what is unreachable or orphaned, which nodes are cut vertices, which paths bypass a given node.

The important one is the planner:

```
plan(from: Edge, to: Edge) → [Topology]
```

Type-directed search, returning candidate routes annotated with what the declarations already know — lossy or not, pure or effectful, depth, zone crossings, and observed success rate drawn from the log. Log statistics are the cost model here, the way `ANALYZE` is for a query planner. Type-legal is not the same as sensible: types shrink the search space, prose and statistics rank it.

This is also what changes when a model does the routing. The netlist can be fixed at elaboration or chosen at runtime; same edges, same nodes, same log, same tests, the only difference being who decides the wiring. In the second mode the netlist stops being the plan and becomes the **legal-move generator** — the model selects from the type-narrowed set of nodes that can consume the edge it is currently holding, rather than from a flat list of sixty tools and a hope. Refinement edges are worth more here, not less, because a type gate is one of the few guarantees that survives dynamic routing. Cut vertices and complete mediation do not.

And because every edge instance is typed and causally logged, a path the model keeps taking can be mined out of history and promoted into a fixed subgraph. Probabilistic where the shape isn't known yet, deterministic once it is.

## Where to look next

- [`docs/design.md`](docs/design.md) — the current-state spec: typing, composition, execution model, zones and identity, the planner
- [`docs/design-history.md`](docs/design-history.md) — how it was arrived at, including what was rejected
- [`docs/getting-started.md`](docs/getting-started.md) — build order
- [`docs/open-questions.md`](docs/open-questions.md) — what is still unresolved
- [`docs/prior-art-blue-ribbon-properties.md`](docs/prior-art-blue-ribbon-properties.md) — an in-flight sibling project whose independent design keeps landing on the same shapes

If this rhymes with something you are already thinking about, I would like to hear from you. That is most of the reason this is public at all.
