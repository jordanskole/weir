# Getting started

The concrete next steps that came out of the design conversation, in order.

## Step zero: hand-write the netlist — done, draft

Before any code: hand-author the JSON that elaboration should eventually emit for the smallest possible program —

```
Person { age: 41 } | birthday | expect Person { age: 42 }
```

Written at [`examples/person-birthday/`](../examples/person-birthday/) — `netlist.json` plus a
`README.md` walking through every implicit decision it forced (instance identity, how `expect` and
the origin literal get monomorphized into concrete nodes, where the schema hash lives, envelope
wiring). **This is a first draft, not ratified** — several of those decisions were picked without
strong grounding in the docs and are flagged as open in the README. Worth a read-through and a
sanity check before step 2 (node declarations) commits to matching its shape.

## Build order

1. **Edge definitions — validated as a spike, not a language commitment.** Stole the `defineField` / `defineDataset` pattern from [bankql](../../bankql) wholesale — verified against `packages/schema/src/define.ts` and `types.ts`. Ported to TypeScript at [`spikes/ts-prototype/`](../spikes/ts-prototype/) (renamed `Dataset`→`Edge`; `hashEdge()` reproduces bankql's structural-fingerprint fields exactly — see [design-history.md](design-history.md#prior-art-bankql-already-proves-the-edge-half)). 20 tests, all passing; `npm test` / `npm run typecheck` both green from inside that directory. **This is a spike, not the chosen host language** — see [open-questions.md](open-questions.md) ("which host language elaborates"); current lean is OCaml, where the identity-function inference trick doesn't apply and this would need re-expressing via the module system or GADTs. Only the structural-fingerprint *logic* (which fields the hash covers) is language-independent and carries forward as-is.
2. **Node declarations — validated as a spike.** `defineNode` (name, input edge, output shape, `Fn`, examples) at [`spikes/ts-prototype/`](../spikes/ts-prototype/), following the shape the step-zero netlist's `nodes` block sketched. Resolved the one blocking open item (`Unit` as a real edge, not `input: null`) and updated the step-zero netlist to match. 26 tests passing. Same caveat as step 1: this is a spike, not a host-language commitment — see [`spikes/ts-prototype/README.md`](../spikes/ts-prototype/README.md#node-declarations-step-2) for what it validates and what's punted (`Failed`-as-implicit, composite nodes, properties/prose).
3. **A composition parser** for `A|B|C` syntax → netlist.
4. **An elaborator** that emits the netlist matching what was hand-written in step zero. This is also where generics get resolved — see "Generics: elaboration monomorphizes" in [design-history.md](design-history.md) — so treat the elaborator as load-bearing, not a thin convenience layer.
5. **A runtime** that walks the netlist, calls each node's `Fn`, and appends the resulting edge instances to the log.

## Vocabulary note (don't conflate these)

- **Scalar vs. compound** is about the *shape* of a value — a `uint8`/`utf8`/bool has no internal structure to index into; records/arrays/vectors do. This is the axis field types live on.
- **Primitive vs. composite** is about *reducibility* — a primitive is a base case, not built from other things in the system. A primitive can still be compound (Lisp's `cons` is a primitive procedure that produces a pair). This is the axis nodes live on: a primitive node's body is host code; a composite node's body is more graph (see "Subgraphs are nodes" in design-history.md).

These are independent vocabularies for different layers — keep them from touching.

## Deferred on purpose (don't build yet)

- **Encryption / key management** — label fields, generate redact/rehydrate from labels, put key resolution behind an interface with a hardcoded implementation. Full design (per-subject/per-zone/per-classification derived keys) is in design-history.md but is explicitly a v2+ concern; building it now risks turning into a KMS project instead of a framework.
- **Permission gates as a runtime PDP** — the node declares a permission *name*; something else (Cerbos-shaped) resolves it. Don't let permission logic leak into the node declaration itself.
- **Generics beyond what's needed for step zero** — the monomorphization approach is decided, but there's no need to stress-test `Batched<T>` or bounded polymorphism until the basic elaborator exists.

See [open-questions.md](open-questions.md) for what's still genuinely unresolved (not just deferred).
