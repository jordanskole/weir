# Weir — Design

The design as it currently stands. No history, no alternatives considered, no open
questions — see `design-history.md` and `open-questions.md` for those.

---

## 1. Primitives

**Edge** — a named schema. Pure data. The complete description of what crosses a wire.
Edges may be parameterized (`Animal<T extends {...}>`); parameters are instantiated
into concrete edges at elaboration and never reach the runtime.

**Node** — a pure function from one edge to another. No instance state, no `this`, no
ambient access. A node whose body is host code is a **primitive**; a node whose body is
a subgraph is a **composite**. A composite with one input edge and one output edge is
indistinguishable from a primitive at its boundary, so topologies nest without limit
upward and bottom out at primitives.

**Envelope** — per-invocation metadata wrapping every edge instance: id (UUIDv7/ULID),
correlation_id, causation_id, timestamp, step index, identity, schema hash. The `Fn`
does not see the envelope by default; nodes that need it (routers, dedupers) take it as
an explicit second argument and are thereby marked context-dependent.

---

## 2. Typing

Edges are structural by default — compatibility is by shape, and this is safe because
wiring is always declared explicitly, never derived from type identity.

**Refinement is how decisions survive.** A node that makes a branching decision must
emit distinct edges: `Person -> one of {Child, Female, Male}`, not `Person -> Person`.
The consumer's input type *is* the proof, so the decision is never re-derived. Shape is
shared by spread (`edge Parrot { ...Animal, wingspan: f32 }`), not inheritance — there
is no type hierarchy.

Generic instantiations are **invariant**: `Animal<Parrot>` is not assignable where
`Animal<Whale>` or `Animal<Animal>` is expected.

Node shape is authored, not inferred, and each shape is reviewable:

| Shape | Signature | Effect |
|---|---|---|
| Rhombus | width in = width out | preserves information |
| Diverging triangle | one general → many refined | *adds* information (the decision) |
| Converging triangle | many specific → one general | *destroys* information (erasure) |

Erasure is legal and deterministic, but must be declared — never inferred. The log
retains the concrete pre-erasure instance even after the type forgets it.

---

## 3. Composition

Composition primitives, closed set: sequential (`|`), parallel (tensor), symmetry
(wire crossing), copy, discard, coproduct (branching). Trace (feedback/loops) is
excluded, or admitted only with a declared iteration bound.

Node outputs come in three distinct modes, which must not be conflated:

- `one of {A, B}` — exactly one fires, chosen by value. Coproduct.
- `all of {A, B}` — all fire, distinct edges. Product. (Fission.)
- `many A` — N instances of one edge. Cardinality.

Copy is a **wiring** fact (one edge to N consumers), not a node output mode.

**Failure is an edge.** Every node's real output signature includes `Failed<In>`,
parameterized by the failing node's own input: `{ input: PayloadOf<In>, reason? }` — it
carries the original payload so a retry node has something to re-emit, not just a
notification that something went wrong. Retry is a node consuming `Failed<In>`;
dead-letter is a node with no output. Unhandled failure is a type error, not a runtime
surprise — that check requires `Failed` to be a real, wired branch, not a nullable field
an envelope might happen to carry; nothing forces a nullable field to be handled.

Authors don't hand-write the catch. The runtime wraps every `Fn` invocation by default —
an uncaught exception becomes `Failed<In>` automatically, `reason` populated from
whatever was thrown. An author who wants a specific `reason` or a distinguishable
failure mode can construct and return `Failed<In>` explicitly instead; nothing obligates
it. Same shape as `env` already being opt-in on `Fn` — implicit by default, more control
available if you reach for it.

---

## 4. Two phases

**Elaboration** — arbitrary host-language code that *builds* the graph. Combinators
(`retry(node, 3)`, `map`, `batch`) live here and are monomorphized away. Output is a
serialized netlist containing only concrete nodes and edges. No type variables may
appear in emitted output; if one does, polymorphism has leaked into the runtime.

**Execution** — the netlist is fixed. Data flows. Topology never varies with runtime
values, which is what makes reachability, cut-vertex analysis, resource bounds, and
exact replay possible.

A node *declaration* and a node *instance* are different things. Declarations live in
source; instances live in the netlist.

---

## 5. Execution model

Nothing polls. **Origin nodes** (cron, HTTP request, queue consumer, file watcher) are
the only place nondeterminism enters; everything downstream is deterministic. An origin
is an ordinary node whose input is the unit edge — the only special edge.

**Effects are data.** A node emits a description (`{fetch, url}`, `{sleep, duration}`);
the runtime performs it and delivers the result as another edge. Replay feeds back the
*recorded* result rather than re-performing, which is what makes determinism hold.

**The log of edge instances is the source of truth.** Node state is a fold over prior
edges keyed by correlation_id. Tables are materialized views over the log; node
implementations are build output. Both are regenerable — the only durable artifacts are
edge definitions and topology.

Replay is forward re-execution from recorded inputs. It never requires invertibility,
so lossy nodes cost nothing.

Every edge instance carries the **schema hash** of the definition it was written under.
The hash covers structural fields only (name, index, type, measure, format, enumValues,
relation, min, max, minLength, maxLength, pattern) and excludes cosmetic ones
(description, unit, sourceKey). Replay on mismatch
either migrates through a declared rule or refuses. If a cosmetic change invalidates
history, the fingerprint is wrong — fix the fingerprint.

---

## 6. Verification

A node definition carries three things beyond its types:

- **Examples**, in composition syntax: `Person { age: 41 } | birthday | expect Person { age: 42 }`
- **Properties**: `∀ p . birthday(p).age == p.age + 1`
- **Prose**: intent, stating *why* — never *how*, which would compete with the code and drift.

`expect` is an ordinary node with `one of {Pass, Fail}`, so a test run is a graph
execution on the same machinery as production, and production log entries can be
promoted to test cases directly.

Properties matter more than examples: a single example underdetermines the function and
the implementing agent can see the test. Edge definitions double as generator specs
(`age: uint8` supplies the domain, `enumValues` the cases), so property tests are close
to free here. `min`/`max` (numeric) and `minLength`/`maxLength`/`pattern` (string) narrow
that domain further where declared; a field without them still generates from its scalar
type's full representable range, so tightening a bound is opt-in, not a new requirement
on existing edges.

**Generation, not mocking.** A property test runs the real `Fn` against a generated
input — there is nothing to fake, because nodes have no impure dependencies to isolate
from (§5, effects are data). An example is a real invocation with a chosen input, not a
substitute for one; mocking exists to manage impurity this design doesn't have. Per-field
generators come straight from `FieldDef` the same way every other derived artifact does
— `type` bounds the domain, `enumValues` enumerates it — composed into a whole-edge
generator. Examples and generated cases aren't redundant: examples are hand-picked to be
legible, what a reviewer reads to see intent; generated cases are unbiased breadth a
human wouldn't think to write by hand. Acceptance (§10) requires both — an implementation
that passes generated cases inconsistently against an *unchanged* contract is exposing
underdetermined examples, not implementation flakiness, and the fix is to the contract.

**Risk ordering, highest first: ontology, topology, examples, implementation.** Ontology
has no mechanical check — nothing can tell you the edge set carves the domain correctly
except review. Topology gets partial mechanical support from §8's `sys` namespace:
cut-vertex analysis and reachability/orphan detection run automatically over the netlist
at elaboration time, so complete mediation is a query, not something a reviewer reads
off a diagram — but whether the *reachable* graph is the graph you meant is still a
review question. Tests can only check a node against a carve already chosen. Implementation
is last and disposable.

---

## 7. Placement and safety

**Zones** annotate where a node runs — client, server, third-party, log. The topology is
unchanged; edges crossing a zone boundary are the network hops. Field-level
classification labels (PII, financial) combine with zones to make leakage a static
query: *no edge carrying an unredacted PII field may cross into a non-client zone.*

Client-side tokenization is a fission/join pair, not an inverse:

```
                 ┌─ RedactedPerson → …server… → RedactedResult ─┐
Person → redact ─┤                                              ├→ rehydrate → Result
                 └─ TokenMap (never leaves client zone) ────────┘
```

The server must pass tokens through unmangled. Deterministic tokenization buys back
equality joins server-side at the cost of revealing which records share a value.

Two independent gates:

- **Type gate** — structural. You cannot call `charge_card` without an
  `AuthorizedPayment`, and only `authorize` mints one. Survives dynamic routing, which
  is why it matters most there.
- **Permission gate** — runtime. Checked by the runtime at the node boundary against
  envelope identity. The node declares *which permission is required* and delegates the
  decision to a PDP. No conditionals in the declaration, ever — that is a second policy
  engine.

Prefer **scoping over checking**: filter data to the identity once at entry, so
downstream nodes never see what they aren't entitled to. This works because everything
is read-or-create-only, which collapses authorization to two questions — what may you
read, what may you append. Scoping rules belong in projection definitions, not at read
time; otherwise derived tables become the leak.

Keys are scoped by *who may read*, never by producer: per data subject (the erasure
answer — drop a key, the fields go inert across the whole log), per zone, per
classification.

---

## 8. System functions

The topology, the ontology, and the log are all data, so the framework ships queries
over them: what edges exist, what refines what, what is unreachable or orphaned, which
nodes are cut vertices, and which paths bypass a given node.

The **planner** is the important one: `plan(from: Edge, to: Edge) → [Topology]`,
type-directed search returning candidate routes annotated with what the definitions
already know — lossy or not, pure or effectful, depth, zone crossings, and observed
success rate drawn from the log. Log statistics are the cost model, the way `ANALYZE`
is for a query planner.

Weights must remain **statistics, not parameters** — attributable to specific runs, or
the planner stops being auditable. Path enumeration requires bounded depth and top-k
pruning. Type-legal is not the same as sensible; types shrink the search space, prose
and statistics rank it.

---

## 9. Two routing modes, one substrate

The netlist may be fixed at elaboration or chosen at runtime by a model. Same edges,
same nodes, same log, same tests — the only difference is who decides the wiring.

In dynamic mode the netlist becomes the **legal-move generator** rather than the plan:
the model selects from the type-narrowed set of nodes reachable from the current edge,
not from a flat list of tools. Static guarantees (cut vertices, complete mediation,
reachability) do not survive dynamic routing; type gates do, and are the reason
refinement edges are worth more here, not less. Dynamic mode additionally requires
declared acceptable terminal edges, since types prevent illegal steps but cannot compel
necessary ones.

Because edge instances are typed and causally logged, recurring dynamic paths can be
mined from history and promoted into fixed subgraphs — probabilistic where the shape
isn't known yet, deterministic once it is.

---

## 10. Authoring format

Edges, nodes, and topologies are authored as real files — `.edge`, `.node`, `.topology`
— real YAML, no bespoke grammar. Schema-driven editor support (validation, completion,
hover docs) is generated mechanically from the same types that already validate
everything else; deferred, not designed away.

`.edge` and `.topology` are pure data — every field maps directly onto existing types,
nothing missing. `.node` is not: `Fn` is host code, which a data format can't and
shouldn't hold (§5, "implementations are build output"). A `.node` file declares the
contract only — name, input, output, examples, closure — never the body.

**The seam.** Contract and implementation are two artifacts, connected by convention and
kept in sync by tooling, not memory — the elaborator (§4) scaffolds and wires the
pairing the same way it already resolves closures and monomorphizes generics. The
separation is structural, not just two extensions in one folder: declarations
(`.edge`/`.node`/`.topology`) and implementations live in genuinely different trees, a
real package boundary — a production fintech platform's `packages/schemas` (declarative)
vs. `apps/durable-functions` (runtime) is the precedent, not just an analogy. A `.node`
file's schema carries no field for `fn` at all — the contract doesn't reference its
implementation, doesn't know whether one exists yet. The elaborator resolves
`{node-name}/{contract-hash}.ts` in the implementation tree by name alone, the same way
that platform's `actionRegistry` never stores a handler's file path — mapping by
convention, enforced by codegen, not by a stored reference. An explicit path field would
also have to survive being resolved across that package boundary, which a bare name
doesn't need to.

For an application built with weir (not this repo, which has no such application yet):
suggested top-level names are `declarations/` and `implementations/`, echoing vocabulary
already in use above (§4's "declarations live in source"; "the implementation becomes
disposable," design-history.md). Organization *within* `declarations/` isn't prescribed
— the elaborator globs by extension, not by folder convention, so grouping by domain,
by feature, or flat is an authoring choice, not a framework rule.

**Versioning.** Each node gets a directory, not a file, for implementations —
`Birthday/<contract-hash>.ts` — one *accepted* implementation per contract state,
written once it passes both its examples and generated property cases (§6), never
overwritten. Draft attempts an agent iterates on before acceptance aren't versions and
don't live here; only what passes gets written. A new file is generated when the node's
schema hash (§5) no longer matches the one an accepted implementation exists for, the
same staleness check already used for edges, applied one layer down. If regenerating
against an *unchanged* contract ever produces a different accept/reject outcome, that's
underdetermination in the examples (§6), not a versioning case — fix the contract, don't
paper over it with more storage. Nothing is destructively regenerated; every accepted
implementation a node ever had stays reachable.

**Replay.** An invocation records which implementation version it actually ran under,
immutable once written, alongside `causation_id` and `schema_hash` in the envelope.
Redeploying a node's implementation never touches invocations already in flight — they
stay pinned to the version they started under; only new invocations pick up the new one.
