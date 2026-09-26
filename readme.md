# Weir

Two things changed about writing software, and only one of them has been absorbed.

The first is that most code is now drafted by an agent, so the interesting human work moved from writing implementations to specifying them. The second, less noticed: the thing that has to *read* a codebase in order to work in it is increasingly also not a human. Almost nothing about how we structure programs has adjusted to that. We are still producing artifacts optimized for a reader who skims, holds context in their head, and asks a colleague when the call graph gets confusing.

Weir is a bet on both halves. It is a declarative framework for building applications out of two things:

- **edges** — pure data schemas, the complete description of what crosses a wire
- **nodes** — pure functions from one edge to another

An application is a directed graph of nodes wired together by their edge types, declared before anything runs rather than assembled step by step as it goes.

The name comes from a fish weir: rather than watching the whole ocean, you build the one narrow place everything has to cross, and check it there. Edges are those crossings.

> **Status: early, but it runs.** The example below elaborates from real `.edge`/`.node`/`.topology` files and executes end to end, with a test suite over it. What works against files on disk:
>
> - **Declaration and checking.** Schema assertion, structural hashing, implementation resolution by contract hash, and a `weir` CLI (`check`, `graph`, `contract`, `run`, `replay`, `verify`). Every declaration is validated against generated JSON Schema at elaboration, so a typo'd key is an error rather than a silently ignored field. A topology also refuses arcs and nodes it can never satisfy — including a `gather` with no spread above it — at elaboration rather than at runtime.
> - **The acceptance gate.** A drafted implementation is not allowed to persist until it passes the node's declared examples, generated structural cases, and its `∀ p . …` property assertions.
> - **Iteration.** The log retains every instance instead of overwriting, and a node fires once per unconsumed instance reaching it along a declared arc, so a cycle in the wiring runs to quiescence rather than firing once ([spec](docs/superpowers/specs/2026-09-24-instance-retention-and-iteration.md)).
> - **Joins by lineage.** A fan-in fires once per lineage group — instances grouped by nearest common ancestor and zipped positionally — rather than once per run, so a fan-out/fan-in diamond iterates ([spec](docs/superpowers/specs/2026-09-25-allof-joins-by-lineage.md)).
> - **Total ancestry.** The external trigger is a token: one run-root instance per run that every origin node's output cites ([spec](docs/superpowers/specs/2026-09-25-system-nodes-run-root-and-noop.md)), so a fan-in fed by two *independent* origins fires, where it used to reach quiescence silently unfired.
> - **Data-driven fan-out, and its dual.** A `many` output materializes its elements as real tokens, so one alert becomes N entities each taking its own treatment with its own lineage ([spread](docs/superpowers/specs/2026-09-26-spread-materializes-elements.md)); `input: { gather: X }` collects every instance of one edge descended from a single spread and fires once with the collection ([gather](docs/superpowers/specs/2026-09-27-gather.md)). Together they are one `traverse` — see [`examples/soc-triage`](examples/soc-triage).
> - **Composite nodes.** A `.topology` that declares a contract can be invoked wherever a node can, inlined at elaboration ([spec](docs/superpowers/specs/2026-09-26-composite-nodes.md)).
> - **Effects, and a determinism check.** A node that needs the outside world declares `effect:` and the runtime's host performs it; replay feeds the *recorded* result back rather than re-performing ([spec](docs/superpowers/specs/2026-09-27-effects-are-data.md)). `weir verify` replays a run's recorded invocations against their pinned implementations and reports what disagreed — Principle 0 made mechanical ([spec](docs/superpowers/specs/2026-09-26-replay-and-the-determinism-check.md)).
> - **A log that outlives the process.** Append-only `.jsonl` for both the log and the trace, so a run can be replayed and verified after the process that produced it is gone ([spec](docs/superpowers/specs/2026-09-26-a-log-that-outlives-the-process.md)).
>
> Not built yet: the planner and the rest of the `sys` queries — including the cut-vertex and complete-mediation analyses this readme describes below — zones and classification, and positional instance identity (`birthday.then.birthday` still runs once, not twice). `expect`-as-a-node is design intent, not built: examples today are declared `given`/`expect` data pairs the acceptance gate runs, not a graph execution. The host language is also undecided — `spikes/ts-prototype/` is a spike and the current lean is OCaml — so treat the TypeScript as evidence the design holds together rather than as the implementation.
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
        done: false
```

`input: allOf:` is a readiness condition, not a wire. The runtime calls the function once both a `Dough` and an `Oven` exist for this correlation id, however many invocations separate their arrival — here, whichever of mixing and preheating finishes second. No join, no accumulator, no ordering requirement.

The wiring is its own file:

```yaml
# declarations/main.topology
mix:
  then:
    bake:
      then:
        cool: {}

preheatOven:
  then:
    bake: {}
```

Two top-level keys are two origins: one external event — one call to the graph's outer membrane — populates every origin-shaped edge it declares needing at once. The dough gets mixed while the oven heats, and `bake` names as its own child under *both*. That is the whole program. The implementation of `bake` lives in a different tree, resolved by name and contract hash, and is regenerable build output rather than something you maintain.

**A topology is a node.** A subgraph is indistinguishable from a single node at its boundary, so a `.topology` can be dropped into a larger graph wherever a node is expected and nothing upstream can tell the difference. Graphs nest without limit and bottom out at a **primitive** — a node whose body is host code rather than more graph. There is no separate module system, because the composition rule already is one.

The file above is a root topology and could not itself be dropped in as a node, because it declares no boundary. One that can says so explicitly — `input`, `output`, and the `terminals` whose outputs *are* that output. This one is from [`examples/soc-triage`](examples/soc-triage), where it is the per-entity investigation:

```yaml
# declarations/investigate.topology — a composite
input: Entity
output:
  allOf:
    - IdentityContext
    - AssetContext
terminals:
  - investigateIdentity
  - investigateAsset
wiring:
  investigateIdentity: {}
  investigateAsset: {}
```

The contract is declared rather than inferred from the inner wiring, deliberately: a boundary you can read is worth more than one a reader has to derive, and it makes the composite checkable against its terminals at elaboration. Note the output is `allOf`, not a single edge — a composite's boundary is an ordinary node contract, so it gets every output mode a node has. Composites are inlined at elaboration; the runtime never learns they exist.

That is also what lets a `.topology` file stay a tree while the graph it describes reconverges. A tree cannot express two branches meeting, so the join moves to a boundary: `investigate` fans out internally, and its *exit* is the join.

## What a run leaves behind

Elaboration turns those files into a netlist — concrete nodes, concrete edges, no type variables. Execution appends to a log. For this recipe, the log opens like this (`envelope` also carries `timestamp`, `identity`, `node`, `contractHash` and the `implementationHash` a replay is pinned to, and each instance its own `schemaHash` — trimmed here to the fields that matter for this walkthrough):

```json
{ "instance": "run#1",         "edge": "Run",   "payload": { "correlationId": "run-1", "triggeredAt": "..." } }

{ "instance": "mix#1",         "edge": "Dough", "payload": { "title": "Chocolate Chip Cookies", "servings": 24 },
  "envelope": { "id": "env-1", "correlationId": "run-1", "causationIds": ["run#1"], "step": 1 } }

{ "instance": "preheatOven#1", "edge": "Oven",  "payload": { "temperature": 375, "preheated": true },
  "envelope": { "id": "env-2", "correlationId": "run-1", "causationIds": ["run#1"], "step": 1 } }
```

The first entry is the **run root** — the external trigger represented as a token. It is the one instance nothing produced, so it carries no envelope of its own, and every origin node's output cites it. That is what makes ancestry total: without it an origin's output descended from nothing, two origins shared no ancestor, and a fan-in fed by both could never form a lineage group to fire on.

`causationIds` names the specific instances this invocation consumed, not merely their edge types. `mix` and `preheatOven` are origins, so each names the run root. `bake`, further downstream, is a fan-in — `input: allOf: [Dough, Oven]` — so its own entry names both `mix#1` and `preheatOven#1`, one per declared edge, in declaration order. `step` is the pulse number: both origins fire in the first pulse, `step: 1` — independent, concurrent applications of the same event, not a sequence. `bake` waits for both before it can append its own entry, one pulse later.

That log is the source of truth. Node state is a fold over prior edges keyed by correlation id. The tables an application shows you are materialized views over it. Both the tables and any node's implementation can be deleted and rebuilt from it; the only durable artifacts are edge definitions and topology.

This holds because **effects are data**. A node does not call a database — it declares `effect: http`, and the runtime's host is the only thing that performs it. The result arrives as an ordinary edge instance citing the request, so arcs, joins, lineage, spread and composites all apply to it with no second mechanism. Replay feeds back the *recorded* result instead of re-performing, which is what makes determinism survive contact with the outside world — and `weir verify` is the check that says so, replaying a run against its pinned implementations and reporting what disagreed.

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

## Why the boxes are small

**The smallest box you can draw is as big as the nondeterminism it has to contain.**

A black box is only a box if you can describe it by what goes in and what comes out. Anything that depends on something outside its inputs, like a global, a clock, or a database read halfway through, can't be cut away from that thing. The box has to grow until it encloses it. In a conventional stack, hidden state is everywhere, so the smallest honest boxes are huge and there are only a few of them. Nobody can reason about the inside, human or agent.

weir moves nondeterminism to the edges. The outside world enters only at origins: a cron, a request, a queue. A node that needs the world returns a description of the effect, and the runtime performs it. A model call is an effect like any other: its result is recorded, and replay feeds the recording back. With nothing hidden holding the interior together, every pure function can be its own box, and decomposition continues all the way down. A subgraph is a box, a node is a box, and the recursion ends at a primitive.

## No ambient state, and therefore no `while`

Nothing a node can read is invisible in its contract. No instance fields, no module globals, no context object threaded through, no accumulator carried between calls. Everything a node sees arrives as a declared edge, which is what makes a node testable without constructing a world around it, and replayable without reconstructing one.

The obvious objection is iteration. Every loop most people write has an accumulator — a slot you re-enter and mutate — and that slot is ambient state by definition.

It turns out the array ban already closed that door. There is nothing to push onto. A collection is keyed, so the thing a loop would have built up incrementally is instead addressed directly: a node whose *output* is `many Ingredient` fans out into N independent tokens, each keyed by the edge's own index, each taking its own path with its own lineage — and reassembly is `gather`, which fires once when every one of them has arrived. Order stops being load-bearing, because a collection is addressed by key rather than by position.

Worth being exact about, because the distinction is easy to lose: it is a `many` **output** that fans out. A `many` **field** — `ingredients: many Ingredient` inside the `Recipe` edge above — is ordinary nested data in one payload, and fans out nothing. Same word, two positions, one of which is a cardinality in the topology and the other a shape inside a token.

And a cycle in the wiring is not a loop — it is recursion. What a `while` loop needs is a mutable slot the condition reads and the body writes, and that slot has nowhere to live here. Recursion needs no slot, because each application receives a new value instead of mutating an old one: `const whenDone = (t) => ready(t) ? t : whenDone(step(t))` carries no accumulator, and neither does `C` feeding back into `A`. It is a fresh application of the same function to new data, indistinguishable from any other forward step. The base case is ordinary too — a node whose output is `oneOf: [Continue, Done]` terminates by emitting the branch nothing routes back. The log holds every intermediate value a loop would have accumulated, so the accumulator was redundant with the log the whole time.

**The execution model is a Petri net, which is the fastest available description of it.** Places hold tokens; a transition fires when its input places hold tokens, consuming them and producing new tokens downstream. Edges are the places, nodes are the transitions, and an edge instance is a token. A node fires once per unconsumed instance arriving on an arc wired *to it* — not once per graph, and not merely because an instance of the right type exists somewhere. If you already know Petri nets, you already know which questions to ask of a weir program: boundedness, liveness, reachability. Termination is quiescence — no node has unconsumed input left — and bounding a runaway graph is the host's job, not the language's, which is why there is no iteration limit anywhere in a declaration.

**Three words, because the first two usually get collapsed and the third usually goes missing.** A **token** is one edge instance in flight. A **run** is one whole traversal, which `correlation_id` names. **Lineage** is which token descended from which, which `causation_id` names. Fan-out is where they come apart: one token goes into a fan-out node and three come out, still one run — and lineage is what lets a later fan-in tell that those three belong together.

**Tests live in the contract.** You have already seen them: the `examples` block in `bake.node` is part of the node's declaration, not a separate test file, and the acceptance gate runs them before a drafted implementation is allowed to persist at all.

The intended end state goes further — `expect` as an ordinary node with `oneOf: [Pass, Fail]`, so a test run is a graph execution on production machinery and a production log entry can be promoted to a test case directly. That part is design, not built: today an example is a declared `given`/`expect` pair the gate invokes directly.

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
