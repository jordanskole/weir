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

## Running it

```
npm install
npm test
npm run typecheck
```
