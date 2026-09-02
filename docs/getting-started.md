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

1. **Edge definitions — validated as a spike, not a language commitment. Built.** Stole the `defineField` / `defineDataset` pattern from [bankql](../../bankql) wholesale — verified against `packages/schema/src/define.ts` and `types.ts`. Ported to TypeScript at [`spikes/ts-prototype/`](../spikes/ts-prototype/) (renamed `Dataset`→`Edge`; `hashEdge()` reproduces bankql's structural-fingerprint fields exactly — see [design-history.md](design-history.md#prior-art-bankql-already-proves-the-edge-half)). `npm test` / `npm run typecheck` both green from inside that directory — the test count has grown well past this step's original scope as the spike matured; don't trust a number here, run the suite. **This is a spike, not the chosen host language** — see [open-questions.md](open-questions.md) ("which host language elaborates"); current lean is OCaml, where the identity-function inference trick doesn't apply and this would need re-expressing via the module system or GADTs. Only the structural-fingerprint *logic* (which fields the hash covers) is language-independent and carries forward as-is.
2. **Node declarations — validated as a spike. Built.** `defineNode` (name, input edge, output shape, `Fn`, examples) at [`spikes/ts-prototype/`](../spikes/ts-prototype/), following the shape the step-zero netlist's `nodes` block sketched. Resolved the one blocking open item (`Unit` as a real edge, not `input: null`) and updated the step-zero netlist to match. Same caveat as step 1: this is a spike, not a host-language commitment — see [`spikes/ts-prototype/README.md`](../spikes/ts-prototype/README.md#node-declarations-step-2) for what it validated at the time and what was punted then (`Failed`-as-implicit — since built, see design-history.md; composite nodes, properties/prose — still open).
3. **An authoring format — `.edge`/`.node`/`.topology` as real YAML files. The loading half is built** (`elaborate.ts` parses and cross-validates all three; `schema.ts` generates editor-tooling JSON Schema for `.field`/`.edge`/`.node`/`.topology`, wired into VS Code via `.vscode/settings.json`). **The versioned-implementation-directory mechanism is only half built:** `resolveImplementation` (`implementation.ts`) *reads* `{node-name}/<contract-hash>.ts` by convention, but nothing yet *writes* one — §10's accept-before-persist gate (an implementation is written once it passes its examples and generated property cases) doesn't exist. Design settled in [design.md](design.md#10-authoring-format) (§10) and [design-history.md](design-history.md#composition-parser-deferred-authoring-format-designed-instead).
4. **An elaborator that reads `.edge`/`.node`/`.topology` and resolves each node's implementation-directory seam. Built** (`elaborate.ts` + `implementation.ts`'s `elaborateWithImplementations`). **Netlist serialization is built:** `netlist.ts`'s `serializeNetlist()` turns an `Elaborated` into JSON — edges with schema hashes, nodes with edge-object references flattened back to the bare names/tagged shapes `.node` YAML uses, and a `topology` of instances/wires with `${nodeName}#1` instance ids (real positional identity — telling two instances of the same node apart within one topology — isn't built; `Wiring` itself can't represent that yet, see [`examples/person-birthday/README.md`](../examples/person-birthday/README.md), "Instance identity is `node-name#n`"). Deliberately excludes `trace` (a run's log, not elaboration's output) and doesn't attempt to match `examples/person-birthday/netlist.json` byte-for-byte — that file is a first-draft illustration, not a ratified target (its own README says so), and its origin-node/`Unit` convention isn't implemented by the real `.node`/`.topology` fixture it sits next to. **Not built:** scaffolding a *new* implementation file for a node with none yet (only resolution of an already-accepted one — see step 3), and generics/monomorphization — see "Generics: elaboration monomorphizes" in [design-history.md](design-history.md) — untouched since this step was originally scoped.
5. **A runtime that walks the netlist, calls each node's `Fn`, and appends the resulting edge instances to the log — built.** `runtime.ts`'s `runNetlist` walks a `Program`'s wiring as a worklist (the pulse/wave model design-history.md already decided — "`every` lands...", since renamed `allOf`), firing each node through `membrane()` once its declared input is ready. `Failed<In>` routing exists for every `InputSpec` kind that exists at runtime — `single` and `allOf` (see `runtime.ts`'s own header comment); `anyOf`/`oneOf`-shaped `.node` input is desugared into ordinary `single`-input nodes at elaboration time, so the runtime never sees a third kind at all (design-history.md, "`any` comes back out... `every` becomes `allOf`"). **Not built:** replay against the implementation version an invocation was pinned to (no versioning/pinning mechanism exists yet — step 3's accept-before-persist gate, which would produce a `<contract-hash>.ts` to pin against, isn't built), a real discriminant for `Failed<In>` vs. a same-shaped success value (`looksLikeFailed` is a documented heuristic, not an actual one), and cycle/bounded-iteration support (a node whose own name recurs fires at most once per invocation, not a claim repeated application is actually supported — design-history.md, "Weir has no loop construct").

## Vocabulary note (don't conflate these)

- **Scalar vs. compound** is about the *shape* of a value — a `uint8`/`utf8`/bool has no internal structure to index into; records/arrays/vectors do. This is the axis field types live on.
- **Primitive vs. composite** is about *reducibility* — a primitive is a base case, not built from other things in the system. A primitive can still be compound (Lisp's `cons` is a primitive procedure that produces a pair). This is the axis nodes live on: a primitive node's body is host code; a composite node's body is more graph (see "Subgraphs are nodes" in design-history.md).

These are independent vocabularies for different layers — keep them from touching.

## Deferred on purpose (don't build yet)

- **Encryption / key management** — label fields, generate redact/rehydrate from labels, put key resolution behind an interface with a hardcoded implementation. Full design (per-subject/per-zone/per-classification derived keys) is in design-history.md but is explicitly a v2+ concern; building it now risks turning into a KMS project instead of a framework.
- **Permission gates as a runtime PDP** — the node declares a permission *name*; something else (Cerbos-shaped) resolves it. Don't let permission logic leak into the node declaration itself.
- **Generics beyond what's needed for step zero** — the monomorphization approach is decided, but there's no need to stress-test `Batched<T>` or bounded polymorphism until the basic elaborator exists.
- **A parser for pipe-string composition syntax** (`Person{41} | birthday | expect Person{42}`) — real and decided as a documentation/prose convention (design.md §6), but nothing currently needs to parse it: examples are already fully representable as `Example<In,O>` objects, written directly in the step 3 authoring format. Build a parser only when something needs to accept examples as free-typed text instead — an agent prompt surface, a checked-docs tool.

See [open-questions.md](open-questions.md) for what's still genuinely unresolved (not just deferred).
