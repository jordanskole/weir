# No way to say "these N things vary only in configuration"

Status: resolved (2026-09-29) for the configuration half. The arithmetic half is open by design.
Last grounded: 2026-10-01.

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

[Instantiation](../superpowers/specs/2026-09-29-instantiation.md) is built:
the closure is applied by partial application at resolution, so an
implementation can finally read it, and a `for:` table elaborates one
declaration into N contracts, one per row.

## What stays open under it

- **The arithmetic does not dissolve**, and it has its own file:
  [can a closure carry a formula?](can-a-closure-carry-a-formula.md). A closure
  carries a value, so counties differing in kind — a Web Mercator latitude
  correction, an integer-truncating acreage field — stay distinct
  implementations. The spec argues that is correct; whether the boundary falls
  in the right place is the open half.
- **Edge instantiation** is deliberately out of scope and is the larger half,
  since an edge template's fields vary in *name*, which is what structural
  hashing is most sensitive to.

## 2026-10-01: mechanical evidence from the sealed-contract loop

An isolated agent drafting `routeCounty` from its sealed contract alone was
**accepted carrying four invented production URLs**
([what an isolated agent found](../superpowers/specs/2026-10-01-what-an-isolated-agent-found.md) §5). The
contract gives two of five counties by worked example and says nothing about the
other three; the agent extended the pattern by analogy, reported that it had, and
noted that nothing in the gate could detect it. Of seven distinct URLs in the
accepted source, three ArcGIS endpoints and one proxy referer appear nowhere in
the contract.

The gate could not catch this and no addition to the gate would. An acceptance
gate verifies shape and invariants; "is this the correct host for Manistee
County" is neither, so a well-formed invention is indistinguishable from the real
thing. The same is true of a human reviewer skimming a diff of URL constants.

**Corrected 2026-10-01, same day.** This paragraph first claimed the agent had
invented a provenance classification for three counties. It had not, and the
error was in the grounding rather than in the agent: the branch assignment *is*
declared, in the output edges' own enums — `DirectCountyQuery.county` is
`["Osceola","Manistee","Roscommon"]` and `ProxiedCountyQuery.county` is
`["Iosco","Otsego"]`. The agent derived it correctly and marked only the URLs as
guesses.

The corrected finding is narrower and argues this question's thesis better than
the overreach did:

**The part modelled as ontology was conveyed intact. The part left as
configuration was fabricated.** County-to-branch is an enum on an edge, so it
crossed the contract boundary and arrived correct. County-to-URL is a constant
table with nowhere to live, so it was invented by analogy and accepted. The
boundary this question draws is exactly where the behaviour changed — which is
the strongest available evidence that the boundary is drawn in the right place,
and that what falls on the configuration side needs a home rather than a better
gate.

Status note: this does not reopen the resolved half. It is the first instance
where the cost of *not* having done it is measured rather than predicted.
