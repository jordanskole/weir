# TS prototype

A spike, not the canonical implementation. The host language for weir's elaborator/runtime isn't
decided — [`docs/open-questions.md`](../../docs/open-questions.md) lists it as open, and the
current lean is OCaml, not TypeScript. This directory exists to validate design ideas cheaply
before that's settled, not to become the codebase by inertia.

Specifically, this ports `@bankql/schema`'s `defineField`/`defineDataset`/`hashDataset` pattern
(`docs/getting-started.md` step 1) to weir's vocabulary, to check that the "edges are structural,
hash only the structural fields" design (`docs/design.md` §5) actually holds together. That check
is done — 20 tests passing, see `src/hash.test.ts`.

**Worth knowing if this gets ported to OCaml (or dropped) later:** `defineField`/`defineEdge`
(`src/define.ts`) are identity functions that exist *only* for TypeScript literal-type inference —
that trick is TS-specific and has no OCaml equivalent. An OCaml version would express the same
"rich typed edge definition" idea through the module system or GADTs instead, not an identity-function
wrapper. Only `hash.ts`'s structural-fingerprint *logic* (which fields count, which don't) is
genuinely language-independent and worth carrying forward as-is.

## Node declarations (step 2)

`defineNode` (`src/define.ts`) follows the same identity-function trick as `defineEdge`, plus four
small constructors for the output shapes in `docs/design.md` §3 — `single`, `oneOf`, `allOf`,
`many`. `src/node.test.ts` replicates the step-zero netlist's `birthday` (rhombus) and
`expect_Person_age_42` (oneOf, closing over its expected value via `closure`) nodes and runs their
`Fn`s against real examples, plus one `allOf` and one `many` node to exercise the two shapes step
zero didn't (design-history.md's `place_order` example, and a `many Person` sibling generator).

What this resolves, punts, or leaves as-is:

- **`Unit` is a real edge, not `input: null`.** Per design.md §5 ("an origin is an ordinary node
  whose input is the unit edge — the only special edge"), `Unit` (`src/types.ts`) is an `EdgeDef`
  with no fields. `examples/person-birthday/netlist.json` and its README were updated to match —
  this was the one open item getting-started.md flagged as blocking step 2.
- **"Fn reference" is a real typed function, not a string/path.** `NodeDef.fn`'s type is derived
  from the input/output edges' field maps (`Payload<F>` in `types.ts`), so `defineNode` catches a
  mismatched `Fn` at compile time the same way `defineEdge` catches a malformed field. This is
  TS-specific ergonomics, not a design commitment — an OCaml port would express the same "Fn is
  checked against the declared edges" idea some other way (see the top of this README on the
  `defineField`/`defineEdge` trick already being TS-only).
- **`Failed` is not added to every node's output type here.** design.md §3 says every node's real
  output includes `Failed`; modeling that automatically (rather than authors writing `oneOf(X,
  Failed)` by hand everywhere) looks like an elaborator concern — deciding how retry/dead-letter
  nodes consume `Failed` needs the topology, which doesn't exist yet (step 4). Left as future work,
  not decided against.
- **Composite nodes aren't modeled.** `NodeDef` only covers primitives (`Fn` is host code). A
  composite node's body is a subgraph, which has no representation until the elaborator/topology
  steps exist.
- **Properties and prose are not modeled.** design.md §6 lists examples, properties (`∀ p . ...`),
  and prose as the three things a node declaration carries; only examples are here.
  `open-questions.md`'s "Prose blocks on node declarations" is still genuinely open (required vs.
  optional vs. machine-checked), so nothing was added that would silently answer it. Properties
  need a generator/property-testing story this spike doesn't have yet.
- **`expect`'s equality semantics are still undecided.** `node.test.ts`'s `expect_Person_age_42`
  uses full-struct equality (`person.age === 42`) because `Person` only has one field here, same
  punt the netlist README already flagged (its decision 3) — field-by-field-over-named-fields vs.
  full-struct equality doesn't get exercised until an edge has fields the example literal omits.

## Running it

```
npm install
npm test
npm run typecheck
```
