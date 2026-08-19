# Weir

Weir is a declarative framework for building applications out of two things: **edges**, which are pure data schemas, and **nodes**, which are pure functions from one edge to another. There are no classes, no `this`, and no ambient state. An application is a composition of nodes wired together by their edge types — a topology, declared before anything executes. You write the ontology and the composition; the implementations inside nodes are derived from them.

The name comes from a fish weir: rather than observing the whole ocean, you define the narrow place everything must cross and validate there. Edges are those crossings. Because a node's contract is total — its input edge, its output edge, and nothing hidden — the pinch points are computable rather than aspirational. Refinement is how decisions survive: a node that classifies a `Person` doesn't return a `Person`, it returns a `Child`, `Female`, or `Male`, so the next node receives the decision as a type rather than re-deriving it. A subgraph with one input edge and one output edge is indistinguishable from a node, so topologies nest; the recursion bottoms out at a **primitive**, a node whose body is host code rather than more graph.

Nothing polls. Origin nodes — a cron, an HTTP request, a queue consumer — are the only places nondeterminism enters, and everything downstream is deterministic and replayable. Effects are data: a node emits a description of what it wants, the runtime performs it, and the result arrives as another edge. The log of edge instances is the source of truth; tables are projections over it, and node implementations are build output. Both are regenerable. The only durable artifacts are the edge definitions and the topology.

Tests live in the node definition, in the same syntax as composition:

```
Person { age: 41 } | birthday | expect Person { age: 42 }
```

Since nodes are pure and edges are fully specified, an edge definition is also a generator specification — so properties (`∀ p . birthday(p).age == p.age + 1`) cost about as much as examples and constrain considerably more. This matters because the implementation inside a node is expected to be written by an agent. The types bound what it can do, the properties pin down what it must do, and the topology stays the human's.

## Status

Early. Nothing works yet.

See [`docs/design.md`](docs/design.md) for the current-state spec, [`docs/design-history.md`](docs/design-history.md) for how it was arrived at, [`docs/getting-started.md`](docs/getting-started.md) for the build order, and [`docs/open-questions.md`](docs/open-questions.md) for what's still unresolved.