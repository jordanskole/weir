# The deterministic scaffold

Status: draft. Piece 1 (the zod emitter) is specified in full below and being
built; the rest is the shape it is being built toward.

## Motivation

An agent handed four sealed contracts wrote four functions beginning
`export default function parcelCentroid(p: any)`
([what an isolated agent found](2026-10-01-what-an-isolated-agent-found.md)).
`any` was the honest annotation, because the contract is a JSON document: there
was no name to refer to, and writing an inline type literal would have meant
re-declaring the schema by hand, free to drift from the contract being drafted
against.

So the agent had to invent, before writing a line of logic: the module shape, the
parameter type, the return shape (it discovered `{edge, payload}` by probing), the
error-signalling convention, and the import story. **Every one of those is
mechanically derivable from the declarations.**

The generalisation: *everything mechanically derivable should be mechanically
derived before an agent is involved, and the thing handed to the agent should be
the derived artifact rather than a description of it.*

## Why this is more than ergonomics

Each of the five findings in the pressure test has one shape: **weir held the
implementer responsible for something only weir could see.** The declaration's
unresolvable property path, the property whose expression compares PINs, the
generator's uncorrelated `allOf` bags, the endpoint table nothing constrains — the
implementer had a JSON document and no way to observe any of it.

Two consequences of a scaffold are load-bearing rather than cosmetic:

**1. It gives a baseline to diff against.** Today "what did the agent invent?" is
unanswerable. The only reason the four fabricated production URLs are known is
that the agent volunteered them in `// GUESSED` comments the gate does not read.
If weir emits the skeleton, then by construction anything in the submission that
is not in the scaffold is the agent's own contribution — and "what did it make
up" becomes a diff. That is a direct answer to
[configuration versus ontology](../../open-questions/configuration-versus-ontology.md)'s
newest instance, where an invented branch assignment silently asserted two
counties' data was `verified`.

**2. A false green becomes readable.** `parcelCentroid`'s only property is named
*"the centroid lies within the boundary's bounding box"* and its expression
compares PINs. Emitted as a generated test it reads:

```ts
it("the centroid lies within the boundary's bounding box", () => {
  expect(out.pin).toBe(input.pin);     // <-- the whole property
});
```

Nobody misses that. The agent believed the name precisely because the expression
was buried in JSON it had to interpret, and
[property coverage](../../open-questions/property-coverage-over-output-fields.md)
notes that an agent holding a sealed contract treats `name` as binding because
nothing distinguishes a name backed by a real check from one backed by a PIN
comparison. Generated code distinguishes them.

A third, smaller: the scaffold can ship the generator's own cases as a fixture, so
an agent discovers `boundaryJson` arrives as `"9r"` immediately instead of after a
`vacuous` submission.

## Scope

`weir scaffold <node> [dir] --out <dir>` eventually emits a standalone workspace:

| artifact | derived from | status |
|---|---|---|
| zod schemas for the input and output edges | the `.edge` files | **piece 1, below** |
| the typed signature, body `throw new Error("not implemented")` | the node's `input`/`output` kind | piece 2 |
| the declared examples, as a runnable test file | `examples:` | piece 2 |
| the declared properties, as runnable tests | `properties:` | piece 3 |
| a fixture of generated input cases | `generateInputCases` | piece 3 |
| `package.json` / `tsconfig.json` so it runs standalone | fixed | piece 2 |
| the brief | `description`, once split | blocked on [sealed contract length](../../open-questions/sealed-contract-length.md) |

"Pass the gate" then becomes "make these tests green", which is a loop the agent
runs locally instead of round-tripping a submission.

**Out of scope, deliberately.** The scaffold does not fix the `vacuous` verdict
([the gate rewards fabrication](../../open-questions/the-gate-rewards-fabrication.md))
or the uncorrelated `allOf` bags
([allOf generation ignores lineage](../../open-questions/allof-generation-ignores-lineage.md)).
It makes both *visible to the implementer*, which is worth doing and is not the
same as fixing them. Claiming otherwise would be this project's own recurring
defect: prose asserting more than the mechanism performs.

## Piece 1: the zod emitter

### Why zod rather than TypeScript types

A type throws the validations away. `lng` declares `min: -180, max: 180`; as a
type that is `lng: number`. The declared integer widths make it sharper still —
`uint8` is `z.number().int().min(0).max(255)`, and *every* hand-written type for
it says `number`. `z.infer` then yields the type as a derived artifact, so the
types come free and cannot drift from the schema.

Zod is also the form an agent writes best, being heavily represented in training
data, which is a real argument for it over a bespoke emitted validator.

### The mapping

| declaration | emitted |
|---|---|
| `utf8` | `z.string()` |
| `bool` | `z.boolean()` |
| `uint8` / `uint16` / `uint32` | `z.number().int().min(0).max(255 / 65535 / 4294967295)` |
| `int8` / `int16` / `int32` | `z.number().int().min(-128).max(127)`, etc. |
| `f32` / `f64` | `z.number()` |
| `datetime` | `z.iso.datetime()` (zod 4; `z.string().datetime()` is deprecated) |
| `enumValues` | `z.enum([…])` |
| `literal: true` | `z.literal(true)` |
| `nullable: true` | `.nullable()` |
| `min` / `max` | `.min()` / `.max()` |
| `minLength` / `maxLength` | `.min()` / `.max()` on the string |
| `pattern` | `.regex(new RegExp("…"))` |
| `description` | `.describe("…")` |
| a compound field (nested edge) | a nested `z.object({…})` |
| a `many` field | `z.record(z.string(), …)`, keyed by the element's `index` |
| `allOf` input | `z.object({ EdgeName: …, OtherEdge: … })` |
| `oneOf` output | `z.discriminatedUnion("edge", [ z.object({ edge: z.literal("…"), payload: … }), … ])` |

The `oneOf` row is the one that pays for itself immediately: the tagged shape
becomes structural rather than something to discover by probing.

**Not emitted:** `classification`, `measure`, `format`, `unit`, `relation`,
`combine`, `ordinal`, `index`. Those are weir semantics rather than validation, and
an implementer does not need them. Omitting them is a decision, not an oversight —
`classification` in particular is what `weir sys` reasons about, and putting it in
a validator would imply it constrains data.

### The membrane keeps `assertPayload`, and a test holds the two together

Decided 2026-10-01. The emitted schema is **not** wired into the membrane. Three
options were weighed:

- *Emit only.* Rejected: the agent would then validate against a second
  implementation of one rule, so a local green could be a gate red — today's
  misattribution pattern relocated rather than removed.
- *Replace `assertPayload`.* The right destination, deferred: it is a refactor of
  a load-bearing module, puts zod in weir's runtime dependencies, and
  `assertPayload`'s weir-voiced reasons (`"RawParcelFeature: featureJson should be
  string, got undefined."`) feed the `Failed` envelope and the trace, so those
  strings change observably.
- **Emit, and test agreement.** Chosen. `assertPayload` stays the enforcer, and a
  test asserts the two accept and reject *identical* payloads across every edge in
  every example app. Divergence then fails a test rather than surfacing as a
  confusing gate verdict, and the replacement decision is deferred without letting
  the two drift.

### Testing

The emitter's output is **source text**, so the test must exercise the text rather
than a parallel in-memory builder — a second implementation beside the renderer
would be the drift class this spec exists to close. The test writes the emitted
module to a temp file, dynamically imports it, and compares behaviour.

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed, including breaks that do **not** redden.

1. **Agreement, per edge, across every example app.** For every edge, for every
   generated payload: `assertPayload` accepts it iff the emitted schema parses it.
   The core assertion.
2. **Agreement on rejection, not just acceptance.** Mutated payloads — a dropped
   required field, a wrong scalar type, an out-of-range number, an over-long
   string, a non-enum value, a `null` in a non-nullable field — must be rejected by
   both. An emitter that dropped every `.min()` would pass test 1 alone, which is
   what makes this one the real guard.
3. Every scalar type in `SCALAR_TYPES` appears in at least one asserted edge, so
   the mapping table is covered rather than assumed. Fails loudly if a scalar is
   added without an emitter case.
4. A `oneOf` output emits a discriminated union that accepts `{edge, payload}` for
   each branch and rejects an unknown `edge` tag.
5. An `allOf` input emits a bag keyed by edge name.
6. A compound field emits a nested object, and a `many` field a record.
7. The emitted module typechecks, and `z.infer` of the output schema is assignable
   from a declared example's `expect`.
8. `.describe()` carries the field description, so the prose has a home at field
   level rather than only in the contract's envelope.
9. No contract hash moves — the emitter reads declarations and writes nothing the
   fingerprint sees.

### Explicitly out of scope for piece 1

- Wiring the emitted schema into the membrane (above).
- The `description`/`brief` split. The emitter puts whatever `description` holds
  into `.describe()`, which means it currently carries the argued prose too. That
  is [sealed contract length](../../open-questions/sealed-contract-length.md)'s
  problem and should not be pre-empted here.
- Emitting the signature, examples, properties or workspace files — pieces 2 and 3.

## What the build found

**The declared integer widths are not enforced.** The emitter maps `uint8` to
`z.number().int().min(0).max(255)`, and the agreement test immediately reported the
membrane as the *looser* of the two. Confirmed directly for all six widths: a
field declared `uint8` accepts `-5`, `1e9` and `1.5`, because `typeofFor` collapses
every numeric type to `"number"` and only an explicit `validations: {min, max}` is
checked. 15 declaration files across 6 apps use an integer type, and four of the
six widths are declared in the vocabulary and used by nothing. Filed as
[integer widths are decorative](../../open-questions/integer-widths-are-decorative.md);
the emitter stays stricter and the divergence is an enumerated test that fails
when the gap closes.

**Two of the emitter's own tests were vacuous, and break-proofs are what caught
it.** Switching the emitted objects to `.strict()` reddened nothing. Dropping
`.nullable()` reddened nothing. Both are invisible to `generateInputCases`, which
emits only declared fields and never emits `null`
([generator coverage](../../open-questions/generator-coverage.md)) — so the
agreement test could not see the two behaviours an implementer is most likely to
trip over. Fixed with explicit probes that inject an undeclared key and a `null`
per field; both breaks now redden.

That is this spec's own subject matter arriving in its own tests: a check whose
name claimed more than it performed, invisible until something deliberately broke
the thing it claimed to check.

**No constraint-dropping break reddens the agreement test at all.** Dropping
`.min()`, `.max(maxLength)` or `z.enum` leaves it green, because generated payloads
are well-formed and a loosened schema still accepts them — each reddens the
mutation test instead. So the agreement test guards agreement on *well-formed*
data (type mapping, nullability, the stripped result) and the mutation test is the
constraint guard. Worth stating because the first version of that test's comment
claimed it caught a dropped `.min()` "with 14 disagreements across 4 apps", a
figure that was never measured and is wrong.

**`datetime` has the same shape as the integer gap, and is milder.** `types.ts`
calls it an ISO-8601 string; the membrane checks only that it is a string; no
declaration uses it. The emitter matches the membrane rather than diverging in two
places at once.

**`weir emit-zod <node> [dir]`** is wired into the CLI, because the emitted
header names it and generated output should not reference a command that does not
exist.
