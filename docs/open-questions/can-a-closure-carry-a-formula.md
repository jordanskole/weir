# Can a closure carry a formula, or only a value?

Status: open.
Last grounded: 2026-09-29 — split out of
[configuration versus ontology](configuration-versus-ontology.md) when
instantiation shipped, which resolved that question's other half.

## The question

[Instantiation](../superpowers/specs/2026-09-29-instantiation.md) makes counties
that differ in a **field name** cost one table row each. It does nothing for the
ones that differ in **arithmetic** — one needs a Web Mercator latitude
correction (`1/cos²(lat)`, about 1.93 at 44°N), another divides by a constant
because its acreage field truncates to integer.

A closure carries a value, so those stay distinct implementations. The spec
argues that is correct — *they are not varying only in configuration, and the
point of the feature is to stop pretending otherwise* — and for a formula that
differs in **kind**, it plainly is.

But the pressure test's estimate was roughly 60 of 83 counties varying only in
names and 23 varying in arithmetic, and 23 hand-written implementations of
"divide an area by a per-county constant, sometimes with a latitude correction"
is the same complaint one layer down. **The spec's answer is right about the
boundary and may be wrong about where the boundary falls.**

## What makes it more than a wish

weir already has a first-order expression grammar. `property.ts` evaluates
`lit`, `get`, `eq`/`ne`/`lt`/`lte`/`gt`/`gte`, `add`, `sub`, `and`/`or`/`not`,
`implies` over `input`/`output` paths. An area formula is an expression over
input fields, in exactly that shape:

```yaml
closure:
  acres: { div: [{ get: "input.Shape__Area" }, { lit: 4046.8564224 }] }
```

Nothing would need inventing except `div`/`mul`. The grammar, the evaluator and
the path resolver all exist and are already fingerprinted into the contract hash.

## Why it might still be a bad idea

Three arguments against, and the first is the serious one:

- **It moves computation out of the place that checks computation.** An
  implementation passes the acceptance gate — examples, generated cases,
  properties. A closure is declaration, and nothing runs it. Putting the
  latitude correction in a closure makes the most error-prone number on the card
  *less* checked, not more, which is the exact opposite of what modelling it in
  weir was supposed to buy. The pressure test's own finding was that this
  formula has been wrong twice and has no unit test; a closure would keep it
  that way.
- **It is a mini-language with no stopping point.** `div` and `mul` invite
  `cos`, then conditionals, then the thing is a programming language nobody
  designed, embedded in a declaration, evaluated by the framework. weir keeps
  the property grammar first-order deliberately, and decidability is why.
- **A node whose body is one expression is not obviously worse.** Twenty-three
  small gated implementations, each with its own examples, is arguably the
  correct amount of ceremony for twenty-three genuinely different functions.

## What would settle it

Whether a formula-carrying closure can be **checked**. If a closure expression
could be run through the same gate an implementation faces — generated cases
against the declared input, properties over the result — then the first
objection dissolves and this becomes attractive. If it cannot, the answer is
almost certainly no, and the boundary the instantiation spec drew is right where
it is.

That question is shared with [properties over
collections](properties-over-collections.md) and the enum-ordering ask: all
three are "what may the expression language grow, and what still checks it".
