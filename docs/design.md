# Weir — Design

The design as it currently stands. No history, no alternatives considered, no open
questions — see `design-history.md` and `open-questions.md` for those.

---

## 0. Principle

**Decomposition is bounded by determinism.** A component can be treated as a black box, and so composed, replaced, tested, replayed or handed to an agent on its own, only to the extent that its outputs are determined by its inputs. Every source of nondeterminism a component touches must sit inside its boundary, so the granularity of any decomposition is set by how widely nondeterminism is spread. weir's rules exist to make that spread as small as possible:

- nondeterminism enters only at origin nodes;
- effects are data, performed by the runtime and recorded;
- no node reads anything its contract does not declare.

**Nondeterminism sets the floor of the recursion.** A subgraph with one input edge and one output edge is a node, so a topology can be opened up into smaller topologies. It can't be opened indefinitely. A box can be cut apart only where every piece's output depends on nothing but its input edge. Nondeterminism that isn't recorded spreads to everything that depends on it, and that whole reach has to stay in one box.

weir doesn't reduce nondeterminism. It records nondeterminism where it enters, at origin nodes and as effect results, which turns it into data on an edge. After that its reach is zero, and the recursion can go all the way down to primitives: the smallest box is a single pure function. Everything else in this document builds on that.

**Lineage.** None of this is new; weir makes it mechanical.

- Ashby, *An Introduction to Cybernetics* (1956): a system is a set of variables chosen so its behavior is determinate. When a real system seems not to be, a variable is missing, and the remedy is to add it. His Markovian machine extends this to probabilistic behavior: the transition probabilities, not the outcomes, are fixed by the state. weir's log is the "add the missing variable" step, done by the runtime.
- State-space theory (Zadeh & Desoer, 1963; Kalman): state is the minimal information that, with future inputs, determines future outputs. Anything else that affects the future is hidden state, and hidden state is what makes boxes big.
- State machine replication (Lamport; Schneider, 1990): replicas agree only if each is a deterministic state machine fed the same ordered log, so nondeterminism is resolved before it enters the log, never inside a replica. Record/replay debugging applies the same rule.
- Simon, "The Architecture of Complexity" (1962): complex systems are nearly decomposable hierarchies. Principle 0 names what binds boxes together: shared, unrecorded nondeterminism.

---

## 1. Primitives

**Edge** — a named schema. Pure data. The complete description of what crosses a wire.
Edges may be parameterized (`Animal<T extends {...}>`); parameters are instantiated
into concrete edges at elaboration and never reach the runtime.

**Node** — a pure function from its declared input to an edge. Input comes in three
kinds (§5): one edge; several at once via `allOf:`; or N of one edge via `gather:`, the
dual of a `many` output. No instance state, no `this`, no ambient access. A node whose body is host code is a **primitive**; a node whose body is
a subgraph is a **composite**. A composite is indistinguishable from a primitive at its
boundary, so topologies nest without limit upward and bottom out at primitives. Its
boundary is an ordinary node contract and gets every output mode a node has — and it is
*declared* in the `.topology`, alongside the `terminals` whose outputs are that output,
rather than inferred from the inner wiring
([spec](superpowers/specs/2026-09-26-composite-nodes.md)).

**Envelope** — per-invocation metadata wrapping every edge instance: id (UUIDv7/ULID),
correlation_id, causation_ids, timestamp, step index, identity, the producing node, the
contract hash it ran under, the implementation hash it is pinned to (§10), and — per
instance rather than per invocation — the schema hash of the edge it was written under.
`causation_ids` is a list, not a single id, because a multi-input (`allOf`) node
consumes several instances at once, and only a list can name all of them. Deliberately
does not carry a `state` or `history` field — an accumulated per-thread state map was
considered and rejected in favor of resolving it on demand, at each node's boundary,
from the per-edge-type logs themselves (§5); baking it into the envelope's own persisted
shape would have made it exactly the ambient, ungated blob multi-input resolution is
designed to avoid. The `Fn` does not see the envelope by default; nodes that need it
(routers, dedupers) take it as an explicit second argument and are thereby marked
context-dependent.

---

## 2. Typing

Edges are structural by default — compatibility is by shape, and this is safe because
wiring is always declared explicitly, never derived from type identity.

**Refinement is how decisions survive.** A node that makes a branching decision must
emit distinct edges: `Person -> one of {Child, Female, Male}`, not `Person -> Person`.
The consumer's input type *is* the proof, so the decision is never re-derived. Shape is
shared by spread (`edge Parrot { ...Animal, wingspan: f32 }`), not inheritance — there
is no type hierarchy ([spec](superpowers/specs/2026-09-09-edge-spread.md)). Spread composes with override the way it does in any language that
has it — a later explicit key wins over a spread-inherited one, no separate merge rule
needed (`edge CompletedTodo { ...Todo, is_complete: true }`). A bare literal in that
position is its own field kind, not a `bool` with a value attached: pinned to that one
value, never `nullable`, never `validations`.

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
(wire crossing), copy, discard, coproduct (branching). No loop construct exists, and
none is needed: a node has no instance to loop back into (§1), so what a loop gets you
is already available as ordinary forward composition through the log (§5) — ostensibly
cyclic wiring (`C` feeding `A` again) is just a fresh, later application of the same
function to new data, ordinary in every way, never a revisit of a prior one. A `while`
loop needs a mutable slot re-entered in place, which the ambient-state exclusion already
rules out; nothing here is a special case of that on top.

Node outputs come in three distinct modes, which must not be conflated:

- `one of {A, B}` — exactly one fires, chosen by value. Coproduct.
- `all of {A, B}` — all fire, distinct edges. Product. (Fission.)
- `many A` — N instances of one edge. Cardinality.

Copy is a **wiring** fact (one edge to N consumers), not a node output mode.

`many A` is the fan-out, and what it puts in the log is both the collection token *and*
one real instance of `A` per entry, each citing the collection. Materializing the elements
is the feature, not an implementation detail: firing a downstream node N times against one
collection token would give every element's descendants the same nearest common ancestor,
so a later fan-in would pair across elements — the exact mispairing the lineage join exists
to prevent, reintroduced by the mechanism meant to make per-element work possible
([spec](superpowers/specs/2026-09-26-spread-materializes-elements.md)). Note this is `many`
in *output* position; `many` inside an edge's fields is ordinary nested data in one payload
and fans out nothing.

**Input has its own closed set**, and it is not the same set:

- one edge — fires once per unconsumed instance reaching it along a declared arc.
- `all of {A, B}` — fires once per lineage group (§5). A readiness condition, not a wire.
- `gather A` — fires once per *barrier*: every instance of `A` descended from a single
  spread, collected into one keyed payload. The dual of a `many` output, and `sequence` in
  the functional sense (`t (f a) → f (t a)`), which is what settles its failure policy:
  one element's failure is the whole group's.

A `gather`'s cardinality is the one thing in a weir declaration that is *not* statically
known — it comes from the spread above it at runtime — which is why it is the only input
kind whose readiness cannot be answered from the contract alone.

There is a fourth thing an `input:` may say, and it is **sugar rather than a kind**:
`anyOf: [A, B]` means *one or more of these edges may arrive, each independently*, and it
desugars at elaboration into N ordinary single-input nodes named `<name>__<edge>`, one per
listed edge. It is deliberately **not** the input-position mirror of `oneOf`: an output's
`oneOf` guarantees exactly one branch fires, which is a promise the producer makes and
nothing on the input side can offer
([spec](superpowers/specs/2026-08-31-oneof-input-becomes-anyof.md)). Desugaring rather than
adding a kind is what keeps the runtime's readiness rules at three
([spec](superpowers/specs/2026-08-31-any-desugaring-design.md)).

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

**The membrane.** Every node invocation passes through it, never bypassed. It is not a
primitive an author declares (§1's Edge/Node/Envelope) — it's framework-owned execution
machinery, generated purely from a node's own contract (`input`, `scope`), never
hand-written and never exposed to a `.node` author to modify. Concretely:
`membrane(nodeDef, input, context)` returns `{ result, envelope }` — it builds the
envelope, narrows `identity` to what `nodeDef.scope` declares, asserts the input against
the edges `nodeDef.input` names, and only then calls `Fn`. A membrane failure (a failed
assert, an unsatisfied scope) produces its own tagged edge (§3, "failure is an edge"),
never an uncaught exception escaping the boundary.

**The membrane asserts; it does not resolve.** It receives the input the runtime already
chose and checks it. That division matters for every multi-instance input kind: the
runtime's readiness rules below decide *which* instances belong together, and handing that
job to the membrane instead would mean re-reading the log after the choice was made —
silently discarding the choice, and reintroducing the cross-lineage pairing the join exists
to prevent. The envelope is built *before* the input is asserted, so a rejected input is
observable too: every *attempted* invocation gets an envelope and a trace entry, not only
every completed one.

Resolution differs by input kind. A `single`-input node fires once per unconsumed
instance reaching it along a declared arc in the topology's wiring — not on its input
edge's latest instance, which is what makes recurrence (§3) actually run rather than
overwrite itself. An `allOf`-input node fires once per **lineage group**: the runtime
gathers each declared edge's unconsumed candidates, groups them by their nearest common
ancestor — the highest-`seq` member of the intersection of each candidate's
self-and-ancestor set — and zips a complete group's candidates positionally by `seq`,
firing once per row and leaving ragged leftovers unconsumed until partners arrive. The
membrane no longer resolves the bag itself; it receives the row the runtime already
chose and only asserts it. A candidate is also **held** rather than grouped when it has a
strictly nearer ancestor that is currently incomplete — candidates on some of the node's
declared edges but not all — and a peer instance of that ancestor's own node holds one of
the missing edges: two items mid-flight in opposite directions, which would otherwise
fall through to a shared ancestor and pair with each other. When no candidate on any
declared edge has been produced by a node invocation at all, there is no lineage to group
on, so resolution falls back to reading each edge's latest instance and fires once, same
as a `single`-input node's readiness used to work for every kind. No production caller
reaches that fallback today — direct invocation hands its bag straight to the membrane and
never joins at all — so it is the answer for a host that stages envelope-less instances
into a real log, which today means tests
([spec](superpowers/specs/2026-09-25-allof-joins-by-lineage.md)).

A `gather`-input node fires once per **barrier**. Its candidates arrive on one arc under the
ordinary rule, and they are grouped by the nearest collection token in their lineage — the
`many` output that spread them. **That token records the count**, which is what makes a
runtime-decided cardinality answerable at all: a group is complete when its size equals the
collection's entry count, so the barrier needs no scoped notion of quiescence, just a count
and the ancestry walk that already existed. A group that can no longer complete — some
element's subgraph produced `Failed<In>` instead of the gathered edge — fails as a whole
rather than waiting, because `gather` is `sequence` and a silent stall is the worse outcome.
A spread of zero elements gathers immediately to an empty collection, which falls out of the
count rather than needing a case ([spec](superpowers/specs/2026-09-27-gather.md)).

Which spread a gather collects from is **not declared, and must not be.** It is the nearest
collection ancestor its candidates share. Declaring it would make a node's contract depend
on the topology above it, which is the property this design exists to avoid: a node in the
middle of a fan-out declares `Entity -> IdentityContext` and knows nothing about being one
of N.

**The external trigger is a token, which is what makes ancestry total.** One run-root
instance is appended per run before any node fires, and every origin node's output cites it.
Without it an origin's output carried `causation_ids: []` — descended from nothing — so two
separate origins' descendants shared no common ancestor at all, no lineage group ever
formed, and a fan-in fed by both sat unfired at quiescence, silently and with no error.
That was a real gap against the very shape this section blesses below (one external event,
several origin-shaped inputs resolved from it at once), and the run root closes it
([spec](superpowers/specs/2026-09-25-system-nodes-run-root-and-noop.md)).

The root deliberately carries **no envelope of its own**: an envelope records an invocation,
and nothing invoked this. It is also deliberately not a join point — at an ancestor with no
envelope, only its *direct* children group. Two instances that both descend from the root
through intermediate invocations share nothing but having happened in the same run, which is
not a reason to pair them; two the root produced directly — one event's several origins —
genuinely do belong together, which is the case this section blesses.

Nothing polls. **Origin nodes** (cron, HTTP request, queue consumer, file watcher) are
the only place nondeterminism enters; everything downstream is deterministic. An origin
node is not a distinct kind of node — every invocation is `membrane(fn(edges))`
regardless — it's distinguished only by where its `edges` come from: an internal node's
edges are resolved by the membrane from prior nodes' logs; an origin node's edges are
handed in directly by whatever triggered the graph (the HTTP handler, the cron tick, the
queue message), asserted the same way. A graph with several origin-shaped inputs doesn't
trigger them independently at different times — there is exactly one call to the graph's
outer membrane per external event, and every origin-shaped edge it declares needing
resolves from that single payload at once. That is what an entry topology's `input`
declares and what `resolveTrigger` performs — above `runNetlist`, because the outer
membrane is the host boundary and the runtime sits below it. Two elaboration checks keep
it honest in both directions: an origin the trigger cannot supply could never fire, and an
edge the trigger declares that no origin consumes is a promise the program does not keep.

**Multi-input nodes** declare `input: { allOf: [A, B] }` rather than a bare edge name.
This is a readiness condition, not a wire: the runtime resolves it by checking whether
an `A`-shaped and a `B`-shaped instance both exist yet, belonging to the same lineage
group, and calls `Fn` once a complete group is present, however many other invocations
separate their arrival. No synchronous join, no accumulator — presence in the log is
itself the signal, the same way awaiting several promises doesn't care what order they
resolve in. (The membrane itself only asserts the bag the runtime hands it; see above.)
A node that itself required `A` to produce `B` (`A -> B -> C` alongside `A -> C`
directly) doesn't need `C` to redeclare that dependency: reading `B`'s log entry already
implies `A` was available when `B` ran.

**Effects are data.** A node that needs the outside world declares `effect: http` and
resolves to a host-supplied handler rather than to a drafted implementation; the runtime
performs it and delivers the result as another edge instance citing the request. Everything
else about such a node is unchanged — it is wired like any node, its input is asserted at
the membrane like any node, and lineage threads through it — so arcs, joins, spread and
composites all apply with no second mechanism, and *where the outside world is touched is
visible in the wiring*, which is the property Principle 0 is about. A missing handler is a
hard failure at run start, not at fire time: a program whose effects cannot be performed
should not begin.

Replay feeds back the *recorded* result rather than re-performing, which is what makes
determinism hold — a replay that re-fetches is not a replay. That has a consequence worth
stating rather than discovering: comparing an effect node's replay to its record is vacuous
by construction, so `verify` reports effect nodes as a third category — *nondeterminism
enters here by declaration* — rather than counting them as passing checks
([spec](superpowers/specs/2026-09-27-effects-are-data.md)).

**Every topology declares its beginning and its end.** A `.topology` declares
`input` — what one external event supplies — `output`, and the `terminals` whose
outputs count as that output. There is no second kind of file: a topology another
topology *references* is inlined where it is named, and one nothing references is
an **entry point** whose wiring is the program. Which it is, is derived rather than
declared ([spec](superpowers/specs/2026-09-28-a-topology-declares-its-beginning.md)). Both halves are checked: at
elaboration, the declared terminals must be able to produce the declared output;
at the end of a run, the log must hold an instance of that output **produced by
one of those terminals**.

Naming the terminal is what makes that instance-level rather than type-level, and
it is not pedantry — a topology can easily have two nodes producing one edge
(`examples/todo-list` does), so "an instance of `TodoList` exists" is satisfied by
an intermediate one emitted long before the run finished. Terminals are declared
rather than inferred for the same reason a composite's are: a cyclic topology has
no structural leaf, and even where one exists, which leaf *means finished* is an
authoring decision rather than a fact about the wiring
([spec](superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md)).

A declared terminal that never fires is **not** an error. Under a `oneOf` end
exactly one branch fires by construction, so the check is on the output and never
on "every terminal ran".

**Quiescence is not success.** The loop ends when a pulse fires nothing, which
is not the same as nothing being left to do — and the difference is a whole class
of silent bug. A run therefore reports its **residue**: every node still holding
eligible unconsumed input on a declared arc when it stopped. At `quiescence` that
is a **stall**, and something is waiting that nothing will ever deliver; after
`budget` it is ordinary, because a bounded run stops mid-flight. Terminal outputs
and unrouted `oneOf` branches are not residue — nothing declares them as input,
so no node is waiting on them.

The runtime *reports* rather than *errors*, because bounding a run is the host's
job and the host is what knows whether a stall matters; `weir run` is such a host
and exits non-zero. It is deliberately **not** a `Failed<In>` edge: an envelope
records that a node ran, at quiescence none did, and minting one to report the
problem would put a false statement in the source of truth
([spec](superpowers/specs/2026-09-27-quiescence-is-not-success.md)).

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
either migrates through a declared rule or refuses. Only the refusal is built — there is no
migration story for contracts yet, and `replayInvocation` says so in the error it throws
rather than implying one exists
([spec](superpowers/specs/2026-09-26-replay-and-the-determinism-check.md)). If a cosmetic
change invalidates history, the fingerprint is wrong — fix the fingerprint.

---

## 6. Verification

A node definition carries three things beyond its types:

- **Examples**, in composition syntax: `Person { age: 41 } | birthday | expect Person { age: 42 }`
- **Properties**: `∀ p . birthday(p).age == p.age + 1`
- **Prose**: intent, stating *why* — never *how*, which would compete with the code and drift.

`expect` is an ordinary node with `one of {Pass, Fail}`, so a test run is a graph execution
on the same machinery as production, and production log entries can be promoted to test
cases directly. **Intent, not built:** today an example is a declared `given`/`expect` data
pair that the acceptance gate (§10) invokes through the membrane directly, not a graph
execution, and nothing promotes a log entry into one.

Properties matter more than examples: a single example underdetermines the function and
the implementing agent can see the test. Edge definitions double as generator specs
(`age: uint8` supplies the domain, `enumValues` the cases), so property tests are close
to free here. `min`/`max` (numeric) and `minLength`/`maxLength`/`pattern` (string) narrow
that domain further where declared; a field without them still generates from its scalar
type's full representable range, so tightening a bound is opt-in, not a new requirement
on existing edges.

An example is written **tagged by edge name** in a `.node` file (`given: { Recipe: … }`) and
is translated at elaboration into the shape `Fn` receives and returns, so a declaration's
examples mean one thing regardless of whether it was authored as YAML or constructed
directly. The tagging is an authoring affordance, not part of the contract
([spec](superpowers/specs/2026-09-28-examples-reach-the-gate.md)).

**Generation, not mocking.** A property test runs the real `Fn` against a generated
input — there is nothing to fake, because nodes have no impure dependencies to isolate
from (§5, effects are data). An example is a real invocation with a chosen input, not a
substitute for one; mocking exists to manage impurity this design doesn't have. Per-field
generators come straight from `FieldDef` the same way every other derived artifact does
— `type` bounds the domain, `enumValues` enumerates it — composed into a whole-edge
generator ([spec](superpowers/specs/2026-09-10-generator-and-fuzz-harness.md)). Examples and generated cases aren't redundant: examples are hand-picked to be
legible, what a reviewer reads to see intent; generated cases are unbiased breadth a
human wouldn't think to write by hand. Acceptance (§10) requires both — an implementation
that passes generated cases inconsistently against an *unchanged* contract is exposing
underdetermined examples, not implementation flakiness, and the fix is to the contract.

**Risk ordering, highest first: ontology, topology, examples, implementation.** Ontology
has no mechanical check — nothing can tell you the edge set carves the domain correctly
except review. Topology gets partial mechanical support at elaboration time, and it
is worth being exact about how much. **Reachability is built** — a topology refuses an arc
that can carry nothing its consumer declares, a node no parent can satisfy, and a `gather`
with no spread above it, all before anything runs. **Cut-vertex analysis and complete
mediation are not** — they are §8 `sys` queries, and §8 is unbuilt, so today they are
something a reviewer reads off a diagram rather than a query. Either way, whether the
*reachable* graph is the graph you meant stays a review question. Tests can only check a node against a carve already chosen. Implementation
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

**Concretely, identity is a JWT, and `Identity` is the one true system edge.** The
graph's outer membrane verifies the token once, on the way in, and populates `Identity`
(`sub`, `iss`) directly. A granted-scopes claim belongs there too and is **not** carried
yet — weir's field model has no scalar-array type, so there is nothing to declare it as; an
independent gap, not the deferred PDP question below — no node produces it, because verifying the
token *is* the trust boundary. Everything richer built on top of it — a user profile, an
account lookup — is not framework magic; it's an ordinary node like any other
(`LookupUserProfile: Identity -> UserProfile`), just one the framework ships a sensible
default implementation for (`Std.*`, batteries-included, replaceable the same way any
`.node` contract's implementation is replaceable — §10 already has the mechanism: a
different accepted implementation for the same contract hash). Keeping the framework-only
set to just `Identity` means almost everything reachable from identity is reviewable,
versioned, and swappable like the rest of the graph, not runtime internals. An earlier draft
of this section named a second framework edge, `Std.Now`, and cross-referenced §5 for it;
§5 never described one and none exists. A clock is an **effect** (§5) — `effect: clock`,
performed once by the host and fed back on every replay — which is the same job done by a
mechanism that already exists, so there is nothing for a system edge to add.

A node reads `Identity` the same way it reads any other edge — declared, not ambient. A
`.node` file's `scope` field names exactly which field(s) it needs (`read:Identity:sub`),
and the membrane resolves each declared entry to precisely that field before calling
`Fn` — never the whole object. Whether `scope`'s `verb:edge:field` shape is really the
same mechanism as `allOf:` applied to ordinary edges too, or a separate declaration that
happens to look similar, isn't settled (open-questions.md). This doesn't reintroduce
ambient state (§5): nothing ever writes to `Identity` once the outer membrane populates
it, and a node's ability to *proceed* still depends on a gate it explicitly declared,
checked by that node's own membrane call before `Fn` runs. A scope mismatch is a failure edge (§3),
same as any other membrane rejection. The set of valid scopes should itself be generated by
scanning every `.node`'s declared `scope` (§10's schema-generation discipline, applied one
layer up), so there is no separately hand-maintained grant registry to drift out of sync
with what nodes actually enforce. Not built: `scope` is parsed, hashed into the contract and
enforced per node, but nothing yet collects the set across a program.

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
nothing missing. A `.topology` declares `output`, `terminals` and `wiring`, plus
`input` when it is a composite meant to be invoked where a node would be (§5). `.node` is not: `Fn` is host code, which a data format can't and
shouldn't hold (§5, "implementations are build output"). A `.node` file declares the
contract only — never the body. What it may carry: `label`, `description`, `input`,
`output`, `examples`, `properties` (§6), `closure` (values fixed at elaboration), `scope`
(§7), and `effect` (§5, naming a host handler instead of a drafted implementation). Its name
is its filename, not a field — one place to write it down means it cannot drift out of sync
with itself, the same rule `.edge` follows.

**The seam.** Contract and implementation are two artifacts, connected by convention and
kept in sync by tooling, not memory — the elaborator (§4) scaffolds and wires the
pairing the same way it already resolves fixed values and monomorphizes generics. The
separation is structural, not just two extensions in one folder: declarations
(`.edge`/`.node`/`.topology`) and implementations live in genuinely different trees, a
real package boundary — a system I built previously split `packages/schemas` (declarative)
from `apps/durable-functions` (runtime), and that's the precedent here, not just an analogy. A `.node`
file's schema carries no field for `fn` at all — the contract doesn't reference its
implementation, doesn't know whether one exists yet. The elaborator resolves
`{node-name}/{contract-hash}.ts` in the implementation tree by name alone, the same way
that project's `actionRegistry` never stores a handler's file path — mapping by
convention, enforced by codegen, not by a stored reference. An explicit path field would
also have to survive being resolved across that package boundary, which a bare name doesn't
need to. The contract an isolated agent actually receives — every referenced edge embedded
in full, so nothing has to be looked up — is the *sealed contract*
([spec](superpowers/specs/2026-09-10-sealed-contract-and-implementation-metadata.md)).

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
**contract** hash no longer matches the one an accepted implementation exists for — the same
staleness check §5 describes for an edge's *schema* hash, applied one layer up rather than
down: a node's hash covers its name, input, output, closure, scope and properties, and
transitively the schema of every edge it names, so an edge change reaches its nodes
automatically. **`examples` is deliberately excluded** — examples are the acceptance suite
*for* a contract, not part of the contract being accepted against. The cost of that asymmetry
(adding an example does not invalidate an already-accepted implementation) is recorded in
open-questions.md rather than settled. If regenerating
against an *unchanged* contract ever produces a different accept/reject outcome, that's
underdetermination in the examples (§6), not a versioning case — fix the contract, don't
paper over it with more storage. Nothing is destructively regenerated; every accepted
implementation a node ever had stays reachable.

**Replay.** An invocation records which implementation version it actually ran under,
immutable once written, alongside `causation_ids` and `schema_hash` in the envelope
([spec](superpowers/specs/2026-09-23-invocation-records-and-replay.md)). Redeploying a
node's implementation never touches invocations already in flight — they stay pinned to the
version they started under; only new invocations pick up the new one.

The pin is **implementation-shaped, not contract-shaped**, and the distinction is what makes
the determinism check usable. A contract hash alone cannot tell "the declaration moved" from
"the body moved", so `verify` could not say whether a disagreeing replay meant a
nondeterministic node or merely a different implementation. With both recorded, a changed
declaration and a changed body each arrive as a *skip with a reason*; what is left, when a
replay completes and disagrees, is the node itself. (Built alongside the determinism check
rather than under a spec of its own — `Envelope.implementationHash`, and
`resolveImplementationAt` refusing an implementation whose bytes no longer hash to it.)
