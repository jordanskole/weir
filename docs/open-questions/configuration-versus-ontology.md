# No way to say "these N things vary only in configuration"

Status: open. **Currently the top blocker** for the pressure-test project.
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

## Not decided

Nothing has been designed. The shape wanted is something like "one edge,
parameterized by a declared mapping", with the open questions being what a
mapping may contain (renames only? unit conversions? arbitrary arithmetic?) and
whether the parameterization is visible in the contract hash — it must be, or two
counties' nodes are indistinguishable to acceptance.

Note the tension with [prose on node declarations](prose-on-node-declarations.md)
and the sealed contract: a parameterized node's drafting agent needs to know
*which* parameterization it is implementing.
