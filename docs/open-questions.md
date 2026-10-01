# Open questions

Things raised in the design conversation that were not resolved — as opposed to
items in [getting-started.md](getting-started.md#deferred-on-purpose-dont-build-yet),
which are resolved in design but deliberately postponed in implementation order.

**One question per file, in `docs/open-questions/`.** This was a single
15,000-word document until 2026-09-29, and the split has a reason beyond
tidiness: 20 of its 35 entries carried a correction or resolution stacked inside
them, so the current state of any one question was buried in its own
archaeology. One entry stated a premise that had been false since it was written
— weir already validated the boundary it claimed was unchecked — and nothing in
a document that long ever prompted re-reading it.

Every file carries a `Status:` and a **`Last grounded:`** date, the same
discipline the specs already use. Grounded means *somebody checked this against
the code on that date*, not that it was edited. It is also now possible to read
one question's whole history with `git log docs/open-questions/<file>`, which the
single document made impossible.

## Open (25)

Live. Ordered alphabetically, not by priority.

- [An origin node can never iterate](open-questions/an-origin-node-can-never-iterate.md)
- [Can a closure carry a formula, or only a value?](open-questions/can-a-closure-carry-a-formula.md)
- [Cardinality is invisible to a static crossing query](open-questions/cardinality-is-invisible.md)
- [Where do client/server and PII obfuscation map onto nodes and edges?](open-questions/client-zones-and-obfuscation.md)
- [`correlation_id` origin and lifetime for multi-invocation threads](open-questions/correlation-id-lifetime.md)
- [Declarations acceptance gate — required sign-off, loosening undecided](open-questions/declarations-acceptance-gate.md)
- [Should a node ever be invoked directly, or is that just a one-node topology?](open-questions/direct-invocation.md)
- [Which parts of a node declaration are contract, and which are commentary?](open-questions/examples-in-the-contract-hash.md)
- [`Failed<In>.input` is typed as validated data it never was](open-questions/failed-input-is-typed-as-valid.md)
- [Should `Failed<In>` be tagged like `oneOf`'s other branches?](open-questions/failed-tagging.md)
- [A gather composes with nothing](open-questions/gather-composes-with-nothing.md)
- [Should the generator produce `null`, and explore cross-field combinations?](open-questions/generator-coverage.md)
- [The version pin pins the contract, not the implementation](open-questions/implementation-identity.md)
- [Classification says what may not go out; nothing says what may not be trusted coming in](open-questions/integrity-inbound.md)
- [A collection is keyed, and streamed data is ordered](open-questions/keyed-versus-ordered-collections.md)
- [The membrane bounds behaviour, not control — `fn` is still directly reachable](open-questions/membrane-bounds-behaviour-not-control.md)
- [Nodes as compiled, distributable units](open-questions/nodes-as-distributable-units.md)
- [A property cannot quantify over a gathered collection](open-questions/properties-over-collections.md)
- [Prose blocks on node declarations](open-questions/prose-on-node-declarations.md)
- [`weir replay` exits zero even when every invocation refused](open-questions/replay-exit-code.md)
- [Run granularity: a batch job's output has nowhere to live](open-questions/run-granularity.md)
- [Is the sealed contract's length a cost nobody is accounting for?](open-questions/sealed-contract-length.md)
- [Serialization erases classification at exactly the crossing it describes](open-questions/serialization-erases-classification.md)
- [Serialization format for the netlist and log](open-questions/serialization-format.md)
- [Sleep / wait](open-questions/sleep-and-wait.md)

## Blocked (1)

Cannot be built as stated — the reason is in the file.

- [Positional identity: `birthday.then.birthday` should run twice](open-questions/positional-identity.md) — **blocked** — two shipped things use the same syntax with opposite

## Specced, not built (1)

- [A gather is all-or-nothing, and a batch wants partial success](open-questions/gather-is-all-or-nothing.md) — specced, not built — `2026-10-01-gather-accepting.md`, status draft

## Resolved (18)

Kept because the reasoning is worth more than the answer, and because several specs and code comments cite them.

- [The idiomatic way to branch makes every such run red](open-questions/branching-makes-every-run-red.md) — resolved (2026-09-29)
- [No way to say "these N things vary only in configuration"](open-questions/configuration-versus-ontology.md) — resolved (2026-09-29) for the configuration half. The arithmetic half is open by design
- [Drift at a boundary, and forking a run to act on it](open-questions/drift-and-fork.md) — resolved (2026-09-29). Two sub-questions inside it stay open
- [Should `membrane()` build the envelope before asserting input?](open-questions/envelope-before-assert.md) — resolved (2026-09-24 — build it first)
- [YAML examples are tagged, TypeScript examples are bare, and the gate only knew the bare form](open-questions/examples-reach-the-gate.md) — resolved (2026-09-28)
- [No extensible envelope, so cross-cutting metadata is an edit to every edge](open-questions/extensible-envelope.md) — resolved (2026-09-29). Dynamic contribution stays out by design
- [A fan-in fed by two independent origin nodes never fires](open-questions/fan-in-fed-by-two-independent-origins.md) — resolved (2026-09-25, the run root)
- [Is `many` a compositional type, or only a one-way fan-out?](open-questions/gather-and-the-vectorized-consumer.md) — resolved (2026-09-27, `gather`). One half deliberately still unbuilt
- [Which host language elaborates](open-questions/host-language.md) — resolved (2026-09-28 — TypeScript for v1)
- [Iteration, and the "no loop construct" claim](open-questions/iteration-and-the-loop-construct.md) — resolved (2026-09-26, in four specs)
- [`Log` is doing two jobs under one interface](open-questions/log-does-two-jobs.md) — resolved (2026-09-28)
- [There is no fan-out primitive: a `many` output is one token, not N](open-questions/no-fan-out-primitive.md) — resolved (2026-09-26)
- [Pagination cannot be gathered, because a cycle is not a spread](open-questions/pagination-cannot-be-gathered.md) — resolved (2026-09-29)
- [Quiescence is not success, and a root topology declares no end](open-questions/quiescence-and-declared-ends.md) — resolved (2026-09-28, both halves)
- [Does `scope` subsume `allOf:`, or stay a separate declaration?](open-questions/scope-subsumes-allof.md) — resolved (2026-09-24)
- ["System nodes": nodes whose contract determines their implementation](open-questions/system-nodes.md) — resolved (2026-09-26, all three built)
- [`.topology` authoring format](open-questions/topology-authoring-format.md) — resolved (2026-09-25). Kept as a citation target
- [Zones: a line in the topology, not a per-node annotation](open-questions/zones.md) — resolved (2026-09-28, built)

