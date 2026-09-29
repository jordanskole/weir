# No way to say "these N things vary only in configuration"

Status: specced, not built — `2026-09-29-instantiation.md`, status draft.
Last grounded: 2026-09-29.

## The question

Five county parcel adapters share one interface and differ in a field name, an
area formula and a PIN separator. weir offers five edges and five nodes, or a
lie. At five that is fine. The project's stated ambition is **statewide: 83
counties** — and 83 edges plus 83 nodes whose differences are
`{fieldName, areaFormula, pinSeparator}` is *configuration wearing an ontology
costume*.

weir cannot say "these N edges are one edge under a renaming", which is
precisely what a schema mapping is.

Surfaced by modelling a slice of the sibling project's ETL as weir declarations
— the exercise recorded in
[what a real program found](../superpowers/specs/2026-09-28-what-a-real-program-found.md),
which covers the four *defects* it turned up; this is one of the design questions
it left behind.

## How it became the top blocker

It absorbed two other frictions that turned out to be the same thing:

- **"No opaque type" (retracted).** The reporter originally argued a county
  response was undeclarable — `Record<string, unknown>` by necessity. It is not:
  the project already sends `outFields=PIN,OWNER,PROPCLASS,UNIT,Shape__Area` to
  the server on every request, which **is** a schema declaration, and the five
  projections are 5, 2, 2, 2 and 2 fields. Their words: *"I dressed laziness as
  necessity."* So the honest modelling is five real schemas — which is exactly
  what makes this question bite.
- **"The contract is true and useless" (partly retracted).** Field names and PIN
  separators become declarations under the five-edge modelling. What does *not*
  dissolve is the arithmetic — one county's Web Mercator latitude correction,
  another's integer-truncating acreage field. That stays in bodies and no
  contract conveys it.

So making the ontology honest is what makes the duplication real. The two moves
are not independent.

## Specced 2026-09-29, and "nothing has been designed" was wrong

This entry previously said no design existed. Checking before building found
three things that already did:

- `design-history.md`, **"Generics: elaboration monomorphizes"**, settles the
  mechanism — templates in source, concrete instances in the netlist,
  elaboration as the boundary, invariant variance. Its own second stated cost is
  this exact failure: *"if the elaborator isn't pleasant to use, the forty
  declarations get hand-written instead."*
- **`NodeDecl.closure`** exists — *"parameters baked in at elaboration time"* —
  and is already **fingerprinted**, so two parameterizations are already two
  contracts. That is the property the whole feature rests on and it holds today.
- The corpus already pays the cost **at N=1**:
  `examples/person-birthday/src/nodes/expect_Person_age_42.node` hand-writes its
  monomorphization in its own filename, and `expect_Person_age_41` would be a
  second file differing in one number.

And a defect found while checking: **nothing reads `closure`.** It is parsed,
hashed and exported in the sealed contract, and appears nowhere in `membrane.ts`,
`invoke.ts`, `runtime.ts` or `accept.ts`. So the parameter reaches the drafting
agent and never reaches the function — a declared parameter no implementation can
read.

[The instantiation spec](../superpowers/specs/2026-09-29-instantiation.md)
covers both: delivering the closure by partial application at resolution, and a
`for:` table that elaborates one declaration into N contracts.

## What stays open under it

- **The arithmetic does not dissolve.** A closure carries a value, not a formula,
  so counties differing in kind — a Web Mercator latitude correction, an
  integer-truncating acreage field — stay distinct implementations. That is
  correct: they are not varying only in configuration.
- **Edge instantiation** is deliberately out of scope and is the larger half,
  since an edge template's fields vary in *name*, which is what structural
  hashing is most sensitive to.
