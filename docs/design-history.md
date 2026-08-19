# Design history

This is a record of how weir's design arrived at what the readme describes. It's reconstructed from a rubber-duck conversation (2026-08-17 to 2026-08-18) and kept so decisions are traceable to the problem that forced them, not just stated as conclusions.

## The seed

Starting frustration: foundational principles — Rich Hickey's "Simple Made Easy," SOLID, data-centric/schema-first design — don't show up naturally in code without constant discipline. Working in PHP made this sharper: classes tend to violate single responsibility just by existing as classes, and `this` is inherently a smell (hidden, mutable, ambient state).

The seed idea: what if the framework is just **edges** (pure data — the shape of what crosses the wire) and **nodes** (pure transformers — input edge to output edge)? Side effects live in middleware. Nothing polls; everything is evented.

This is flow-based programming territory — Morrison's FBP, Erlang/OTP, core.async + transducers, Kafka Streams, Node-RED all land near here, and each hit the same walls this history works through.

## Splitting edge into schema vs. wiring

"Edge = shape of the data" and "edge = the wire between two nodes" turned out to be two different concepts fused together. A schema is a value — inert, comparable, versionable. A connection is topology — which output feeds which input, with cardinality and routing. Fusing them meant the same schema couldn't be wired differently between two node pairs, and topology couldn't be validated or diffed as its own thing.

Resolution: schemas are data; edges (as wiring) are `(from_node, output_port, to_node, input_port, schema_ref)`. Topology becomes data you can validate, diff, and render.

## Prior art: bankql already proves the edge half

Partway through, it became clear that a sibling project — [bankql](../../bankql) — is already running the "edges" half of this design in production, just without the name. Verified against the actual source (`packages/schema/src/`):

- `defineField` / `defineDataset` (`define.ts`) are identity functions that exist purely to pin TypeScript inference on a rich `FieldDef` / `DatasetDef` shape (`types.ts`) — label, description, measure, format, unit, enumValues, a typed `relation` to another dataset, and a `sourceKey` mapping back to the raw source column. That `DatasetDef` is, functionally, an edge definition.
- One `DatasetDef` already drives multiple downstream artifacts from a single source of truth (`index.ts`): DuckDB `CREATE TABLE` DDL (`duckdb.ts`), an LLM-facing description/system prompt (`llm.ts`), agent tool specs (`agent/queryDataTool.ts`), and the foreign-key graph via each field's `relation` (`relations.ts`). That's the "edges are the tables" claim from this design, already shipped rather than proposed.
- `hashDataset()` (`hash.ts`) fingerprints only the *structural* fields of a dataset — `type`, `measure`, `format`, `enumValues`, `relation` — deliberately excluding `description`, `unit`, `sourceKey`, `blobPath`, `isDeprecated`. That's exactly the identity-bearing-vs-cosmetic split an edge's `schema_ref` needs, and it comes with a rule worth transferring directly: if a description change busts a cache, the fingerprint is wrong — fix the fingerprint, don't work around it.

The transferable conclusion: every edge instance in weir's log should carry the schema hash it was written under, the same way bankql's `assertDatasetHash` catches drift at startup/test time. Replay compares the recorded hash against the current definition and either migrates through a declared rule or refuses — the schema-evolution problem doesn't need to be invented from scratch, bankql already has a working answer to steal.

## Middleware was where purity leaked

If a node is `input → output` but middleware does the actual I/O, the node was never pure — the impurity just moved behind a decorator, and the testability purity was supposed to buy got lost.

Resolution: **effects are data.** A node returns a description of what it wants (`{fetch, url}`, `{write, table, row}`); the runtime interprets it and feeds the result back in as another edge.

## The envelope

Persistence and cross-cutting concerns (tracing, dedupe, retry policy) still needed somewhere to live without becoming middleware. The fix: every edge instance is `{envelope, payload}` — envelope carries `id`, `correlation_id`, `causation_id`, `timestamp`, step index. The payload is what the schema describes.

This is CloudEvents / Kafka headers / event-sourcing's standard shape. Cross-cutting concerns become **readers of the envelope**, not wrappers around the node — nothing decorates anything.

Open call, resolved as opt-in: does a node's `Fn` see the envelope? Default no — `(payload) => ...` stays context-free. A node that needs identity (routers, dedupers) opts in with an explicit second argument, `(payload, env)`, so context-dependence is visible in the signature rather than implicit.

## Nominal edges: a wrong turn, corrected within the hour

The `birthday: Person -> Person` example exposed a real problem: if routing follows type identity and there's only one `Person` type, `birthday`'s output is its own input. It feeds itself; everyone ages forever. Add `capitalize: Person -> Person` and now there's a two-cycle with undefined ordering on top of the self-loop.

**First proposed fix (rejected): make edges nominal.** Split shape from identity — `type Person {...}`, then distinct named edges `edge PersonReceived : Person` and `edge PersonAged : Person`, with `node birthday: PersonReceived -> PersonAged`. No self-loop, wiring is intentional, and `PersonReceived`/`PersonValidated` stay distinct even when byte-identical, avoiding the accidental-fan-in failure mode of content-based pub-sub (every node emitting `Order` implicitly feeding every node consuming `Order`).

**Why it was rejected almost immediately:** the premise — "routing follows type identity" — was never actually true. Wiring in this design is *always* declared explicitly, node by node; nothing is auto-derived from matching shapes. Once that's true, the self-loop was never real: `birthday`'s declaration doesn't cause it to feed itself, it just describes its interface. And nominal edges would have broken the thing that motivated the whole design in the first place — `birthday|birthday|birthday` (increment age three times) only composes *because* the ends match structurally. Nominal-by-default kills that example.

**The actual resolution: structural by default, wiring always explicit.** Edge compatibility is by shape. Nominal naming (`PersonReceived` vs. `PersonValidated`) survives only as an opt-in tool for **refinement** — reached for deliberately when a specific decision needs to be visible in the topology (see "Fan-out is three different things" and "Failure as an edge" below), not as a blanket rule for every edge in the system.

**The consequence this uncovered:** `birthday|birthday|birthday` differing from a single `birthday` is the entire point of composing nodes — measuring a node against idempotence was the wrong instinct. But it breaks naive log replay: three invocations of the same node, same name, same shape — if the log records node name plus payload, replay can't distinguish position two from position three. Fixed by giving the log **positional identity**: the [envelope](#the-envelope)'s per-invocation id/step index, not the edge type, is what disambiguates repeated invocations. This is also where the envelope's id was pinned down as being allowed to just be a timestamp/UUIDv7 — created per invocation, describing that run, never part of the data itself.

## Fan-out is three different things

Node-RED's failure mode was conflating three distinct behaviors under "multiple outputs":

- `one of {A, B}` — exactly one fires, chosen by value. Branching, a coproduct.
- `all of {A, B}` — every one fires, distinct edges. True fission, a product.
- `many A` — N instances of the *same* edge. Cardinality, a list functor.

`validate: PersonReceived -> one of {PersonValid, PersonInvalid}` and `place_order: OrderPlaced -> all of {InvoiceRequested, InventoryReserved}` are wildly different control flow and need to be declared as such, not both just "outputs."

## Subgraphs are nodes

A subgraph with exactly one input edge and one output edge is indistinguishable from a node — same signature, same contract. So graphs nest, and "node" and "graph" are the same kind of thing at every level (the box-inside-a-box picture from string diagrams). The system is self-similar rather than one sprawling flat network.

Deliberately declined: naming the nesting levels ("galaxy," etc.). Naming them would break the property that makes them useful — a node has to stay transparently swappable for a subgraph, the way a directory full of directories is still just a directory (Composite pattern: leaf and composite share one interface so callers can't tell them apart).

The one distinction that does carry information points down, not up: does this bottom out in host code, or in more graph? That's **leaf vs. composite** — one word for the general thing (node), one qualifier for the floor (primitive).

This also creates a log granularity decision: a composite node's run produces internal edge instances — record them (transparent: full causal trace, large logs) or don't (opaque: smaller logs, can't replay the inside).

## Failure as an edge

If a node's `Fn` throws, that can be bolted on the side (try/catch, retry policy, dead-letter queue as separate mechanisms) — or every node's real output signature can be `one of {…successes, Failed}`, making failure just another wire that has to be terminated somewhere.

Resolution: the second. A retry becomes a node that consumes `Failed` and emits the original edge; a dead letter is a node with no output; the type checker flags unhandled failure paths. It also keeps the log honest — a failure is an edge instance like any other, and replay sees it. Cost: every node gains an output edge and topologies get busier. Judged worth it, and flagged as nearly impossible to retrofit later — this had to be decided early.

## Persistence and execution model

- The log of edge instances *is* the persistence layer.
- State is a fold over that log.
- Replay requires the fold to be deterministic.
- The framework is "composition, not a program": you elaborate the topology, then execute it — a query-planner-like split between declaration and execution.

## Generics: elaboration monomorphizes

Flagged as the one item that couldn't be deferred: `retry: T → T`, `log: T → T`, `batch: T → many T` need a way to be written once but still emit concrete, fully-typed edges into the netlist — every edge instance in the log needs a named concrete type, so a live type variable can't survive to runtime. Protobuf has spent fifteen years not solving this.

Resolution: **elaboration monomorphizes.** `log<Parrot>` is written once, polymorphically, but expands at elaboration time into a concrete `log_Parrot: Parrot → Parrot` node in the netlist. The type variable lives in phase one (authoring) and is gone before anything executes — same move Rust makes with generics, and Verilog with generate blocks. Polymorphic authoring, concrete artifact.

This makes a **node declaration** and a **node** different things: `feed: Animal<T> → Animal<T>` is a template; the netlist contains `feed_Parrot: Animal<Parrot> → Animal<Parrot>`. Templates live in source, instances live in the topology, elaboration is the boundary. If a type variable can ever appear in the *emitted* netlist, polymorphism has leaked into the runtime and a unifier is needed after all — worth being strict about in the serialization format.

Two costs this creates, taken deliberately:
- **Netlist size** — `log` across forty edge types is forty nodes. Fine for analysis, but the topology you query is bigger than the topology you wrote.
- **Authoring ergonomics** — if the elaborator isn't pleasant to use, the forty declarations get hand-written instead, and the elaborator goes from "nice separation of concerns" to load-bearing.

Where the type parameter lives also moved: not on the node, but instantiated into a concrete edge before anything runs (e.g. `Animal<Parrot>` is a real named edge in the netlist) — the same opt-in-naming move as refinement edges above (`PersonReceived` vs. `PersonAged`), just applied to generic instantiation instead of a branching decision: give the concrete thing its own identity rather than letting it collapse into its structural shape. Variance was decided deliberately as **invariant**: `Animal<Parrot>` is not assignable where `Animal<Whale>` or `Animal<Animal>` is expected. Each instantiation is its own edge, full stop — covariance is where generics grow soundness holes and the type checker stops being a weekend project. Can be relaxed later; can't be tightened later. Bounded polymorphism (`T extends {legs: uint8}`) is fine and brings structural matching back in at the bound — checking whether a type satisfies the bound is structural, same as everywhere else — without making distinct instantiations assignable to each other.

## Permission gates, distinct from type gates

Two different checks turned out to be needed at a node boundary, and worth keeping distinct rather than merging:

- **Type gate** — you can't call `charge_card` without holding an `AuthorizedPayment`. Structural, no runtime check, about data provenance. (See "The weir in dynamic topologies" below.)
- **Permission gate** — you can't *traverse* `charge_card` unless the calling principal holds the grant. Runtime, checked against the envelope, about actor authority.

This works precisely because the node's `Fn` can't see the envelope: the runtime checks the permission at the node boundary, and the function stays pure and identity-blind. The check happens at the weir, not inside the fish.

**Exit permissions** are the more interesting half — information-flow control over who may *receive* an edge, not just who may traverse a node. A node that widens `Transaction` to `PublicTransaction` is a declassifier, and exit permissions are where that gets declared. This matters more here than in most systems because the log holds everything — every edge instance ever produced, including the pre-declassification ones — so read authorization on the log is a real, self-inflicted problem, and exit permissions are the natural place to answer it.

Discipline to hold: a node declares *which permission is required* (a name) and delegates the actual check to a PDP (policy decision point) — same move as delegating to Cerbos elsewhere in this design. The moment a node declaration contains permission logic itself, the purity that made this tractable is gone.

## Encryption keys: scope to reader, not writer

A related question — should each node get its own key — was rejected: keying by producer answers the wrong question. If node A encrypts with `key_A`, every downstream consumer of A's output needs `key_A`, so keys propagate along the edges until everyone holds everything — N keys, zero isolation.

Keys should scope to **who may read**, composed along three axes:
- **Per data subject** — the erasure answer. Dropping one person's key makes their fields inert everywhere in the log at once, without rewriting an append-only store.
- **Per zone** — client holds the vault, server structurally cannot decrypt (already the shape of a prior design elsewhere; the zone annotation just makes it explicit).
- **Per classification** — PII vs. financial vs. public, so a compromise is bounded to one class.

Composed as a derived key per `(subject, classification)`, wrapped by a zone key — standard envelope encryption. Worth knowing before the log format is designed, since retrofitting field-instance-granularity encryption is awkward.

For v1, explicitly: **don't build any of this.** Label fields, generate the redact/rehydrate pair from the labels, and put key resolution behind an interface with a hardcoded implementation — the same discipline as delegating authorization to Cerbos. The framework declares which key class a field needs; something else answers where the key comes from. Key management is a KMS-shaped problem that will eat the project if tackled prematurely.

## The pivot: this is a substrate for agent-written code

The framing that reframed several "costly" decisions as the actual point: the human doesn't write node bodies. The human defines edges, defines nodes (as typed contracts), and composes the graph. An agent writes the implementation inside each node. That changes what the design is optimizing for:

- **Total contracts** stop being a burden and become the entire prompt — input edge, output edge, nothing else, no ambiguity for the agent to resolve wrong.
- **Purity** means generated code is verifiable locally, without mocking a world.
- **Effects-as-data** means an agent structurally cannot reach outside its declared type — the blast radius of a bad node is bounded by its type, not by what the code happens to do.
- **No `this`** means no hidden state an agent couldn't see — which is where most agent-generated bugs actually originate.
- **The log** turns every historical run into a regression suite: regenerate a node, replay, diff.
- A further, previously unnamed property: **the implementation becomes disposable.** If a node is pure and fully specified by its types, its body is derived, not authored. The durable artifact is the topology plus edge definitions; the code is a build output you can throw away and regenerate.

The corollary: review, not generation, is the actual bottleneck for agent-written code. Reading a 400-line service to judge correctness doesn't scale; reading a pure function with a fully specified type, checked against recorded inputs, does. The design cuts the work at the seam where agents are strong (small, plausible, locally-typed functions) and keeps the part where they're weak (deciding what should exist — the topology).

Also noted directly: the mapping to tool-calling is real without having been designed for it — nodes are tools, edges are their schemas, a node's prose description is the tool description.

## The weir, formalized: cut vertices are computable

The salmon-run intuition behind the project's name already had names in adjacent fields, and naming it precisely is what made it mechanical rather than aspirational. Architecture calls it the **narrow waist** (IP is the narrow waist of the internet — validate once at the pinch, everything above and below inherits the guarantee). Security calls it **complete mediation** — a checkpoint only works if there's no path around it. But the graph-theoretic name is the one that matters, because it's *computable*: a **cut vertex** (articulation point) is a node whose removal disconnects the graph — every path from A to B is forced through it.

Because the topology is data (the elaboration decision above), cut vertices aren't a property you argue for in review — they're a query. Run the cut-vertex algorithm over the netlist and get back the complete list of pinch points, plus, just as usefully, the list of places flow *bypasses* one — "this invariant is supposed to be enforced at node V, and here are the three paths that reach the downstream region without touching V." That bypass-detection is the complete-mediation check, computed instead of read off a diagram by a reviewer.

This also folds topology validation into a mechanism that already existed rather than requiring a new one: because a subgraph with one input and one output edge *is* a node (see "Subgraphs are nodes" above), a property test at a subgraph's boundary is already a topology test. Validating a whole topology isn't a new capability — it's the same node-level property-test mechanism, one level up.

## System functions: topology and log as queryable data

`plan(from: Edge, to: Edge) -> [Topology]` — a function to find routes between two edges — turned out to be a **planner**, and the SQL analogy runs deeper than intended: it's type-directed search (the same shape as Hoogle searching Haskell by signature, or a query optimizer enumerating legal plans and ranking by cost). And because the planner is itself a node, it lives inside the graph the same way `information_schema` lives inside the database it describes, rather than as an external tool bolted on.

The ranking metadata falls out of decisions already made, for free:
- **Lossy or not** — does a candidate path contain a converging triangle (erasure)? The triangle vocabulary from "Refinement is how decisions survive" becomes planner output.
- **Pure or effectful** — does the path emit effect descriptions an agent should know about before choosing it (e.g. "this route charges a card")?
- **Depth, fan-out, zone/process-boundary crossings.**
- **Observed success/failure rate, read straight from the log.** This is the real prize: a SQL query planner ranks using table statistics from `ANALYZE`; this planner ranks candidate topologies using *actual recorded outcomes* from real runs, because every execution already writes typed, causal edge instances to the log. Nobody else can do this ranking, because nobody else has a typed causal record of every execution to rank from.

This generalizes to a whole `sys` namespace — system tables/functions analogous to `information_schema`: what edges exist, what refines what, what's unreachable or orphaned, which nodes are cut vertices, which paths bypass a given node, and the planner itself. Ontology and topology reviews (see "Verification" risk ordering) get partial mechanical support from this namespace — cut-vertex analysis and reachability/orphan detection run automatically over the netlist at elaboration time — where node-level correctness still relies on tests and review of the types.

## The weir in dynamic topologies

A late distinction, connecting the framework name back to its purpose: everything above assumes a topology fixed at elaboration time. But applications built by/for agents increasingly look like **elastic, dynamic topologies** — an agent choosing the next node at runtime rather than a human fixing the graph in advance. That's a different mode: static graph analysis (cut vertices, reachability, complete mediation) doesn't exist for a topology that isn't fixed until runtime.

The resolution was not to treat the weir as DX-only (a nice-to-have for the human author) that stops mattering once routing goes dynamic. It matters *more*: the chokepoint relocates from the graph to the type. `charge_card: AuthorizedPayment → Receipt` means an agent cannot call `charge_card` without holding an `AuthorizedPayment` — and only `authorize` mints one. You lose static proof of the chokepoint, but keep automatic runtime enforcement, because the enforcement lives in the refinement types rather than in someone remembering to check a policy.

Precedent: a query planner picks a different plan every execution, cost-based, and nobody worries — relational algebra guarantees the *result* is correct regardless of which plan the optimizer picks. The target for agent-routed weir topologies is the same property: any route the agent takes is correct by construction, because an incorrect route is structurally impossible to construct, not just discouraged.

This means the decisions made early for reasons that read as pure DX — nominal refinement on branching nodes, total contracts, no row polymorphism — turn out to matter more, not less, once the topology is chosen by a model at runtime instead of declared by a human ahead of time.

## Relation/Cardinality: ontology, not a wiring bypass

Raised while reading `types.ts` during node-declarations work: `FieldDef.relation` (`{edge, field, cardinality}`, ported wholesale from bankql — see "Prior art" above) looked at first glance like it might let one edge join to another directly, bypassing nodes — which would break "wiring is always declared explicitly, node by node" (see "Nominal edges" above).

It doesn't. `relation`/`Cardinality` (`1:1`, `1:many`, `many:1`, `many:many`) is ontology metadata — a domain fact, the same role a foreign key plays in a relational schema — not a routing mechanism. No edge instance ever reaches another edge's data without a node in between; a `Relation` only tells whoever (or whatever agent) is authoring a node's body what shape of lookup it's implementing. A node enriching `Order` with its `Customer` implements the `many:1` side and should declare `single Customer` output; a node fetching a customer's orders implements the `1:many` side and should declare `many Order`. `many:many` almost always wants a junction edge rather than collapsing into one node.

So `Relation.cardinality` and `OutputSpec`'s `single`/`oneOf`/`allOf`/`many` (see "Fan-out is three different things" above) are the same vocabulary at two different layers: `Relation` is a fact about the domain; `OutputSpec` is what a specific node declares it produces when it chooses to enact that fact. Nothing currently checks the two agree — that's a legitimate future validation, not yet built.

## Considered and rejected: ambient shared state (ADF, state machines)

Raised while looking for prior art on the open questions around accumulators, wait/sleep, and join keying (see `open-questions.md`): could a node just read and write some shared state pool instead of being strictly `In → OutputSpec`? Three real systems were checked against this instead of speculating.

**Azure Durable Functions** (a production fintech platform's `apps/durable-functions`) answers all three questions concretely, without ambient state. Its accumulator (the `collector` XState machine, `packages/schemas/src/automations/machines/collector.ts`) holds state as a persisted, versioned snapshot advanced one event at a time, deduped by an id — the same role weir's envelope `id` plays. Its wait is a durable timer (`createTimer(deadline)`, a duration) or, unused in this codebase but present in the platform, `waitForExternalEvent(name)` — a real `waitUntil(signal)` that suspends indefinitely at zero cost until something calls `raiseEvent(instanceId, name, data)`, and composes with `Task.WhenAny`/`Task.WhenAll` over several named events for timeout-races and joins. None of this needs a shared pool: state is scoped to one orchestration instance, and "join" is naming several events and waiting on some/all of them by name — much closer to `OutputSpec`'s `oneOf`/`allOf` than to a shared variable.

**LangGraph** is the one system that actually does this the ambient way, and it's worth naming exactly why that was rejected rather than just "different." LangGraph has no typed edge between nodes at all — one shared `state` object every node reads and partially writes, with conflicting concurrent writes resolved by a **reducer** attached to each field (e.g. `Annotated[list, operator.add]`). That's LangGraph's single answer to both accumulation and joining — a merge function on a shared channel, not correlation by id. The cost is exactly what showed up when this was checked against weir's decisions: no type gate per node, since any node can read any state field regardless of whether it's wired to whoever wrote it. That's structurally the same shape as **Azure Data Factory**'s pipeline-scoped variables (state set by one activity, mutable and readable by any other activity in the pipeline, lifetime-scoped to the whole run rather than to an edge) — both are the "ambient, mutable state" the readme's opening line (`no classes, no this, no ambient state`) was written against, just relocated from an object instance to a pipeline/graph run.

**State machines carry more primitives than their node/edge diagram admits**, which is a separate reason to keep `NodeDef` as-is for now. XState and LangGraph both draw as boxes-and-arrows, but the real vocabulary is six-plus parts — states, events, transitions, guards, actions, context (LangGraph adds channels/reducers/checkpointer on top). a production fintech platform's own `reactorMachineTemplate` demonstrates the cost directly: the *template* (`setup()` — guards + actions, static) and the *topology* (`createMachineConfig()` — states + transitions, built from user config) had to be authored as two separate pieces that get assembled at runtime, because a state machine's full vocabulary doesn't fit into one declaration. weir's two-part vocabulary (edge = schema, node = pure fn) is a deliberate simplification against that, and closer to the mental model most people already have from IFTTT/Zapier/n8n-style "nodes passing data" than to a state machine's.

**Resolution:** keep `NodeDef` exactly as it is — single `In extends EdgeDef`, no shared/ambient state channel. The three open questions (accumulators, wait, join keying) stay open, but "give nodes a shared state pool" is now a rejected direction rather than an unexplored one, and multi-input/many-to-one nodes (if/when they're added) should still resolve via named, typed edges — closer to Durable Functions' named-event joins than to a reducer over ambient state.

## The netlist is an IR; start with the AST

A late naming pass over vocabulary that was already there without being said out loud: the design keeps reaching for compiler terms because it *is* one. "Generics: elaboration monomorphizes" above describes monomorphization by name. "Netlist" is EDA/HDL vocabulary — a flat, typed listing of component instances and their wiring, the thing a hardware description language compiles *down to*. `plan(from, to) → [Topology]` "turned out to be a planner" — type-directed search over an IR, ranked by cost, same shape as a query optimizer. Cut-vertex/reachability analysis "computed instead of read off a diagram" is dataflow analysis over that IR, the same category of pass as liveness or reaching-definitions, aimed at weir's own invariant (complete mediation) instead of register allocation. Dynamic mode's "netlist becomes the legal-move generator rather than the plan" (`design.md:208`) is an interpreter walking IR at runtime where static mode has a compiler resolving it ahead of time — AOT vs. JIT, mapped onto agent-routed vs. human-fixed topologies.

Naming it sharpens a question raised independently and then recognized as the same one: a normal compiler pipeline takes rich, ambiguous source — comments, naming, control-flow shaped for a human reader, the "why" — and *discards* it on the way to an AST/IR, keeping only what execution needs. That's real fidelity loss; decompiling back is lossy forever for exactly this reason. weir doesn't have that step. The AST-shaped thing — edges plus topology — *is* the source; node bodies are generated outward from it, not compiled inward into it. This is "The pivot" section's claim restated: *"the durable artifact is the topology plus edge definitions; the code is a build output you can throw away and regenerate"* (above). Nothing is lost going in because nothing narrative was there to lose — the "why" that would normally live in prose comments lives instead in the edge's own typed vocabulary (`measure`, `format`, `relation`, refinement naming like `PersonReceived` vs. `PersonAged`) and, per the still-open "Prose blocks on node declarations" question (`open-questions.md`), optionally in a description attached *to* the AST-level node rather than compiled *from* prose into one.

The practical corollary: weir isn't a new idea bolted onto flow-based programming, it's the well-understood source → AST → IR → execution pipeline with the authored/derived roles swapped — durable artifact and disposable artifact trade places, but the pipeline shape (and the tooling that shape unlocks: validation before "compiling," diffable topology, deterministic replay as a VM trace) is the same one compilers have used for decades. That's most of why this direction has felt more solid under scrutiny than the ambient-state alternatives in the entry above: it isn't being invented from scratch, it's reusing a shape with fifty years of prior art behind exactly the properties (static analysis, replay, monomorphization) weir keeps needing.

## Identity is the actor; edges are the resource; the node boundary is a membrane

Raised while narrowing `Envelope.identity` away from `identity?: string` (`types.ts`): what should fill in for "who/what this invocation runs as," and does it ever legitimately not exist?

**It never doesn't exist.** Tried to find a counterexample — an unauthenticated request, a cron firing, a pure computation with no side effects — and none of them hold up. ABAC/PDP systems (Cerbos and others) deliberately model "anonymous" as a real principal rather than the absence of one, because a policy check needs something to evaluate against; a cron still fires under some execution context; a pure node still inherits the identity of whatever caused it, the same way `correlationId` propagates. `identity` is better read as **"on behalf of"** than "who's logged in" — a system-triggered event still runs on behalf of the system, accountable the same way a human actor would be. a production fintech platform's `BaseActivity` (`packages/schemas/src/activities/base.ts`) confirms this is how a real production system already modeled it: `actorType`/`actorId` are required on *every* activity, no exceptions, and `ActorType` (`enums.ts`) includes `System` as a first-class value — there's no "no actor" case in the schema, only different kinds of actor. Resolution: `identity: Identity`, required, not optional — matches `causationId`'s reasoning above (a meaningfully-always-present fact belongs in the type as required, not as something that might be missing) but lands on the opposite nullability, because unlike causation, there's no root case where "on behalf of" is truly nothing.

**This completes a triad `design.md`'s permission-gates section already implied without naming it.** *"The node declares which permission is required and delegates the decision to a PDP"* is a Cerbos-shaped `check(principal, resource, action)` call: `identity` is the **principal**, the edge instance crossing the wire is the **resource**, and the node being invoked (`charge_card`) is the **action**. Keeping `Identity` narrowly "just the actor" — not also carrying tenant/institution scope — is what keeps that PDP call clean; scope-like attributes (a production fintech platform's `rssdId` on every activity, alongside `AutomationScope`'s `self`/`institution`) belong as attributes on the *resource* side (a field or `relation` on the edge), the same way Cerbos keeps principal attributes and resource attributes in separate bags rather than one merged identity blob. Non-nullable `identity` also keeps the PDP check total rather than needing a null-branch, which matters given "no conditionals in the declaration, ever" is already a hard rule for permission gates.

**Naming continuity, worth keeping on record:** the original rubber-duck conversation used **membrane** for this exact mechanism — the node's in/out boundary, where both the type gate and the permission gate actually run. "Weir" names the macro architecture (the narrow crossing, system-wide); "cut vertex" and "complete mediation" name the graph-theoretic and security properties; "membrane" is the term for the boundary *doing* the checking at one specific node. Three names, three angles, one mechanism — consistent with how the rest of this history tends to accumulate vocabulary rather than replace it.

`Identity`'s actual shape is still a placeholder (`Record<string, never>`, `Unit`'s idiom — not `{}`, which types as "any non-nullish value" and would narrow nothing) — designing the real actor model is future work, not resolved here.

## Composition parser deferred; authoring format designed instead

Started as "is a composition parser (`getting-started.md` step 3) next." Turned into a longer brainstorm that ended up reframing the step rather than building it.

**The parser isn't needed yet.** Composition syntax's documented job (`design.md` §6) is node-level examples — `given → expect` — not general topology authoring; step zero already settled topology-as-data (`netlist.json`). And examples are already fully representable without any parsing: `Example<In,O>` (`types.ts`) is exactly `{ given, expect }`, already written by hand in `node.test.ts`, 26 tests passing. Nothing currently depends on parsing pipe strings — composition syntax stays a prose convention for docs and design conversations, real and decided but not blocking, the same category as encryption/PDP in `getting-started.md`'s deferred list. Fan-out syntax candidates were explored first (bracket-per-kind, OCaml `match`, keyword-call syntax mirroring `oneOf()`/`allOf()`/`many()`) before this reframe made the question moot for now — worth revisiting if something eventually needs to parse free-typed examples (an agent prompt surface, a checked-docs tool).

**What actually turned out to be missing: a real authoring format for edges, nodes, and topologies**, as files rather than TS object literals or hand-maintained JSON. Landed on real YAML (not a custom grammar — explicitly rejected inventing a dialect, the way GitHub Actions/Azure Pipelines YAML stay real YAML with schema-driven tooling layered on by filename convention, not new syntax) across three file kinds, `.edge`/`.node`/`.topology`. Two of the three are pure data with no design gap (`.edge`, `.topology`); `.node` isn't, because `Fn` is executable code and a data format can't hold it — nor should it, per "the implementation becomes disposable" (the pivot section, above).

**The `.node` seam mirrors a production fintech platform's registry/handler split precisely**, not just by analogy: `actionRegistry` (declarative, `packages/schemas`) stays separate from its handler files (`apps/durable-functions`), paired by naming convention and kept in sync by codegen (`codegen-actions.ts` scaffolds the handler stub from the registry entry) rather than by memory. `.node.yaml` plays the registry's role — contract only, no body — and weir's elaborator (§4) is the natural place for the equivalent scaffolding, since it already does the same kind of work resolving closures and monomorphizing generics.

**Versioning came from a real operational worry, not tidiness**: mutable `Fn` implementations break replay determinism, and redeploying a node's code out from under a long-running or replayed invocation is exactly the failure mode a production fintech platform's reactor orchestrators already had to solve — *"running instances are frozen to v1's data"* even after v2 ships (`activity-subscriber.md`, "Version Pinning"). Resolution: each node gets a directory of append-only implementation files rather than one mutable file; regeneration triggers off the same schema-hash mismatch check already used for edges (§5) and a production fintech platform's Arrow cache, applied one layer down; and an invocation now needs to record which implementation version it actually ran under, alongside `causation_id`/`schema_hash` in the envelope, so replay is exact regardless of what's since been regenerated. Written into `design.md` as a new §10, "Authoring format," since this is now decided architecture, not just how the decision happened.

**The version identifier is the contract hash, full stop — a walked-back detour.** First instinct: name each implementation file by its contract's schema hash — content-addressed, reproducible. Second-guessed that over a retry scenario (a rejected attempt redone against the same unchanged contract would collide on a bare hash) and landed briefly on a combined `<contract-hash>-<timestamp>` identifier to give retries distinct filenames. That was solving a problem that shouldn't exist: a *draft attempt* isn't a version and was never meant to be written into the append-only directory at all — only an implementation that's actually passed its examples gets persisted, one per contract state. Under that framing, "regenerate against an unchanged contract, get a different accept/reject outcome" isn't a storage case to design around, it's the examples underdetermining the function (§6, "a single example underdetermines the function") — a defect to fix in the contract, not a versioning scenario to accommodate. Filename reverts to `<contract-hash>.ts`; a timestamp, if wanted, is file metadata, not identity.

**Left open:** the version-pin field's exact name/shape on the envelope; whether `.node.yaml` and its implementation directory need a structural package boundary between them (the way a production fintech platform really does separate schemas from runtime) or just live side by side; the `oneOf`/`allOf`/`many` YAML shape inside `output:` beyond the `single`-sugar case sketched in passing; JSON Schema generation itself, still deferred.

## Property tests are generation, not mocking

Raised directly out of the retry/underdetermination conversation above: what if edges had generators — property tests running against N generated instances instead of hand-typed cases, the way `fast-check`/QuickCheck-style libraries work? Not a new idea, just a missing mechanism: `design.md` §6 already named this — *"Edge definitions double as generator specs... property tests are close to free here"* — without ever specifying how it runs. This concretizes it rather than invents it, and it's proven prior art, not speculative: property-based testing libraries already derive a per-field generator from a type shape and compose them into a whole-record generator, a near-literal transliteration of `FieldDef`'s existing `type`/`enumValues` fields — the same "mechanically derivable from the same types" move as the JSON Schema tooling, a different downstream artifact off the same source. No library named here, deliberately — same "spike, not a host-language commitment" caveat as everything else in `spikes/ts-prototype/`.

**The sharper realization: examples and mocks are not the same thing, and it's not incidental.** Floated dropping hand-written examples in favor of generated-only, walked back immediately — examples help authoring/thinking, and it wasn't clear *why* they're not redundant with generation until the mocking question got asked directly. Mocks exist to fake out **impure dependencies** — a database, an HTTP client — so a test can isolate code that can't avoid touching them. Weir nodes have no such dependencies to fake: "effects are data" (§5) means a node never calls anything impure directly, it just returns a value describing what it wants done. This isn't a new conclusion either — "the pivot" section already said it: *"Purity means generated code is verifiable locally, without mocking a world."* An `Example` is a real invocation of the real pure function against a chosen input, not a substitute for anything absent. So examples and generated cases were never competing ways to do the same job — examples are hand-picked for legibility (what a reviewer reads to see intent), generated cases are unbiased breadth a human wouldn't think to write by hand. Both stay; acceptance (§10, updated) now requires passing both, which also strengthens the earlier underdetermination point directly — broad generated coverage is what would surface a flip-floppy contract *before* acceptance, rather than via a flaky retry after.

## `Failed` gets a shape, and the catch stops being hand-written

"Failure as an edge" (above) resolved *that* failure is a real, wired edge rather than a bolted-on try/catch, and flagged the concrete shape as "nearly impossible to retrofit later." It sat unshaped since — no fields, nowhere in `types.ts`. Picked back up from a proposal to soften it into a nullable `envelope.error`, closer in spirit to Rust and "even more implicit."

Worth being precise about why that particular softening doesn't hold, since the instincts behind it (Rust, implicit) actually point the other way. Rust's `Result<T,E>` is not nullable or implicit — it's a checked sum type the compiler forces callers to handle, the same shape `Failed` already is. A nullable envelope field is the option "Failure as an edge" already considered and rejected (*"bolted on the side"*), and for the same reason the earlier null-vs-undefined work landed on `causationId: string | null` over an optional field: a nullable field doesn't force anything, and the entire point of choosing `Failed` as a real edge was *"the type checker flags unhandled failure paths"* — a property only a wired branch gives you.

What survives from the proposal, reconciled: `Failed<In>` stays a real edge, now shaped — `{ input: PayloadOf<In>, reason? }`, parameterized by the failing node's own input so a retry node has something to re-emit, not just a signal. What's genuinely new is authoring ergonomics, not the type: the runtime wraps every `Fn` invocation by default, an uncaught exception becomes `Failed<In>` automatically — no hand-written `try`/`catch` per node. An author can still construct and return `Failed<In>` explicitly for a specific `reason`, but isn't obligated to. Same opt-in shape `env` already has on `Fn` — implicit by default, more control available if reached for, not a competing mechanism.
