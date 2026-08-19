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
