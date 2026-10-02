# The deterministic scaffold

Status: implemented (pieces 1-3: `weir emit-zod` and `weir scaffold`). The
workspace files, the typed stub, the examples and the properties are emitted and
tested; what remains is listed under "Still unbuilt".

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
| zod schemas for the input and output edges | the `.edge` files | **built** |
| the typed signature, body `throw new Error("not implemented")` | the node's `input`/`output` kind | **built** |
| the declared examples, as a runnable test file | `examples:` | **built** |
| the declared properties, as runnable tests | `properties:` | **built** |
| a fixture of generated input cases | `generateInputCases` | still unbuilt |
| `package.json` / `tsconfig.json` / `vitest.config.ts` | fixed | **built** |
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

## Pieces 2 and 3, as built

`weir scaffold <node> [dir] --out <dir> [--force]` writes eight files. The
implementer edits one.

```
schema.ts            the input and output edges as zod, validations included
<node>.ts            the typed stub. Throws. YOURS.
check.ts             the declared examples and properties, as source
<node>.test.ts       four lines: expect(check()).toEqual([])
package.json         zod + vitest
tsconfig.json        strict
vitest.config.ts     so the directory tests itself wherever it sits
README.md            how to read a failure
```

It refuses to overwrite an existing `<node>.ts` without `--force`, because that is
the one file holding work the scaffold exists to collect.

### A failure names the artifact at fault

This is the part that answers the pressure test directly. `check()` returns a
stage per failure:

| stage | what is wrong |
|---|---|
| `input-schema` | the example's own `given` is invalid. **A declaration bug; `fn` never ran.** |
| `output-schema` | the result is the wrong shape — including an out-of-range value, since the range is in the schema |
| `value` | right shape, wrong value |
| `threw` | `fn` declined |
| `property` | an invariant did not hold — or **the property itself is broken**, reported separately |

The last two rows are the findings from this morning, mechanised. `routeCounty`
failed as *"the property did not hold"* when its path could not resolve for any
candidate; the scaffold says `"…" is broken: path "output.nope" does not resolve`
instead, so an implementer is not sent to debug correct code.

### The property, rendered

```ts
{
  name: "the centroid lies within the boundary's bounding box",
  // Weaker than point-in-polygon but checkable without a geometry library, and
  // it catches the failure that actually happens: a shoelace implementation
  // that divides by 6*area with the wrong sign…
  holds: (input, output) => {
    const read = reader(input, output);
    return same(read("output.pin"), read("input.pin"));
  },
},
```

The name, the careful description, and a body that compares PINs — four lines
apart. That is the whole argument for emitting rather than describing.

It compares with `node:util`'s `isDeepStrictEqual`, which is the gate's own
comparison, rather than vitest's looser `toEqual`. A scaffold that passed what the
gate rejects would be a new false green in the artifact built to prevent them.

## What the build found

**The scaffold was not standalone, and reading it would not have shown that.**
Run inside another project, vitest walked up, found the parent's config, applied
its `include: src/**/*.test.ts`, and reported *"No test files found"* — a green
exit from a workspace that tested nothing. Fixed by emitting `vitest.config.ts`.
Found by running a scaffolded directory rather than by inspecting its files.

**Three of the scaffold's tests were vacuous, all three found by break-proofs.**

1. *Removing the input-schema stage entirely reddened nothing* — no example in
   the corpus has a `given` that violates its own schema, so the stage that most
   directly answers the misattribution finding was untested. Fixed with a
   synthesized bad example plus an `fn` that throws loudly if called, so a pass
   cannot be the stub quietly succeeding.
2. *Substituting `JSON.stringify` for `isDeepStrictEqual` reddened nothing* — the
   text assertion caught only that the import survived. Fixed with a result whose
   fields are in a different order, which the structural comparison must accept
   and the string comparison must not.
3. Both are the same shape as the two vacuous tests found while building piece 1,
   which is now four instances in one day of *a test that cannot see the thing it
   is named for*. The pattern: an assertion over data a generator produces cannot
   test behaviour that only non-generated data exercises.

**A test case of mine was wrong, not the code.** A "wrong value" probe returned
`lat: 99`, which the schema rejected on its declared max of 90 — so it reported
`output-schema`, not `value`. The range living in the schema rather than in a type
is precisely this emitter's reason to exist, and it caught my test.

## Still unbuilt

- **A fixture of generated input cases**, so an implementer sees that
  `boundaryJson` arrives as `"9r"` before submitting rather than after a
  `vacuous` verdict.
- **The `description`/`brief` split.** `.describe()` currently carries the full
  argued prose, including one field's 4,854 characters. Blocked on
  [sealed contract length](../../open-questions/sealed-contract-length.md).
- **Scaffolding a whole topology** rather than one node at a time.
- **Feeding the gate from the scaffold**, so `weir accept` could take a scaffold
  directory instead of a single source file.

## Running it on blue-ribbon, which is where it earned its keep

Scaffolded all four pure nodes into `spikes/blue-ribbon-slice/scaffold/`. The loop
works: `npm install`, `npm test` reports both examples as
`threw: routeCounty: not implemented`, drop in the drafted implementation, green.

Then reading the generated `check.ts` files found three things, none of which was
visible in the declarations or in the sealed contract.

### Two of the slice's six properties were tautologies

```ts
name: "combined provenance is never stronger than either input",
holds: (input, output) => same(read("output.provenance"), read("output.provenance")),
```

```ts
name: "the canonical PIN preserves every digit group of the source PIN",
holds: (input, output) => same(read("output.pin"), read("output.pin")),
```

Both compare a value with itself, so both hold for **every** possible output.
Demonstrated on the first: with both inputs at `listing claim` (the weakest
provenance) and the output claiming `verified` (the strongest), it returned `true`,
as it does for every value of the enum. The single property guarding this
pipeline's provenance lattice could not fail, and the acceptance gate reported it
as passing.

Tallying the slice: `routeCounty`'s is real (after this morning's path fix),
`normalizeParcel`'s `acres > 0` is real, `resolveIdentity`'s cross-parcel check is
real, two were tautologies, and `parcelCentroid`'s is a real check under a name
describing a different one. **Half the properties did not do what their names
said.**

The cause is the same in every case and it is friction #1 again: the source PIN is
inside the opaque `featureJson`, so there is no `input` path to compare the
canonical form against, and the provenance lattice needs an ordering over
`enumValues` that the evaluator does not have. In both cases the real property was
inexpressible and a tautology looked like the least-bad option.

**`weir check` now refuses the shape.** `assertFalsifiable` (property.ts) rejects an
`eq`/`ne` whose operands are syntactically identical, recursing through
`and`/`or`/`not`/`implies`. Deliberately narrow — it does not attempt to decide
tautology in general — because this is the shape that actually occurred, twice, and
it is decidable in one comparison. Both properties were removed from the slice with
the reasoning recorded in the declarations, and
[no ordering over enumValues](../../open-questions/no-ordering-over-enum-values.md)
captures what would be needed to write the provenance one for real.

Worth noting against the earlier proposal: **the property-coverage check would have
missed both.** `output.provenance` and `output.pin` are mentioned, so coverage would
have called them covered. Coverage detects a field no property *names*, not one no
property *constrains*.

### `elaborate` parsed a native binary as a node declaration

Scaffolding into a declaration root and running `npm install` produced:

```
✗ ../blue-ribbon-slice
  Duplicate node name "fsevents" (also declared in
    "scaffold/resolveIdentity/node_modules/fsevents/fsevents.node").
```

`.node` is weir's node-declaration extension **and** Node.js's native-addon
extension, so a recursive `.node` glob descends into `node_modules` and finds
binaries. Any weir project with an npm dependency hits this, independently of
scaffolding — so all five declaration globs now skip `node_modules`, `dist`, and
dot-directories.

### What it did not find

The `vacuous` problem is untouched, as this spec said it would be. The scaffold
makes the opaque field *visible* — `boundaryJson: z.string().min(2).max(2000000)`
sits directly beneath `lng: z.number().min(-180).max(180)` — but an implementer
still cannot discover that the generator fills it with `"9r"` without submitting.
That is the generated-input fixture under "Still unbuilt".

## The per-node form duplicated every shared edge

Caught by reading the output: scaffolding blue-ribbon's four pure nodes emitted
`NormalizedParcel` **three times**, byte-identical, once per node that touches it
(`normalizeParcel`, `parcelCentroid`, `resolveIdentity`). Four `package.json`s, four
installs, four vitest configs.

That contradicts the model. An edge is weir's unit of shared vocabulary — *"the
complete description of what crosses a wire"* — so a private copy per consumer is
the drift class this repo keeps finding, emitted by the tool meant to prevent it.

`weir scaffold [dir] --out <dir>` now writes one workspace:

```
schemas/            one module per edge, 8 for the slice
  NormalizedParcel.ts     <- one copy, imported by three nodes
  _keyedBy.ts             <- emitted once, only if some edge needs it
nodes/<node>/
  <node>.ts         YOURS
  schema.ts         this node's input/output, importing ../../schemas/
  check.ts          examples and properties as source
  generated-inputs.md
  <node>.test.ts
package.json        one install
vitest.config.ts    one test run
```

Verified: `npm install && npm test` reports four reds, dropping in the four drafted
implementations turns all four green.

**`weir scaffold <node>` is kept** and still emits a self-contained bundle. That is
not an oversight — a single node handed to an isolated agent *should* carry its
schemas, because the agent does not have the rest of the program. Duplication is the
point in that form and a defect in the other.

## The generated-input report, and why it is a report

The gap this closes: an implementer could not learn that `boundaryJson` arrives as
noise without submitting and reading `vacuous`.

Each node gets `generated-inputs.md`, which quotes the gate's real settings (seed
42, 100 cases — anything else would describe inputs nobody is judged against),
flags every `utf8` field whose `maxLength` is ≥ 10,000 as one the generator will
fill with bulk random text, states the `vacuous` verdict that follows, says the
verdict is about the declaration rather than the code, and tells the implementer
**not to invent a plausible value** — with four real inputs from the head of the
same deterministic sequence.

It is a report rather than the inputs themselves because the inputs do not fit.
Measured at the gate's settings, `parcelCentroid`'s 100 cases are **108 MB**:
`boundaryJson` is declared `maxLength: 2000000` and the generator samples length
uniformly, giving a median of 1,157,240 characters and `JSON.parse` succeeding on
0 of 100. Filed as
[generated strings are enormous](../../open-questions/generated-strings-are-enormous.md) —
the numeric generator already emits boundary cases first and samples afterwards,
and the string generator does not, so 95 of 100 cases are a megabyte of noise
testing what 20 characters would have tested.

So this piece is built but weaker than specified: the implementer gets an accurate
description of the generated inputs rather than the inputs. Closing that properly
needs the generator fixed, not the scaffold.

## The generator fix, after the fact

[Generated strings are enormous](../../open-questions/generated-strings-are-enormous.md)
is resolved, so the report above is less of a compromise than when it was written.
`generateStringValue` now emits `minLength`, `minLength + 1`, `maxLength - 1` and
`maxLength` once each and draws everything else from an ordinary span near the floor:

```
boundaryJson over 100 generated cases
  before   min 2   median 1,157,240   max 2,000,000   total 107,972,852
  after    min 2   median 41          max 2,000,000   total   4,033,864
```

Both ends of the declared bound are still reached, 27× less work, and the samples
in each `generated-inputs.md` are now short enough to read — which is most of what
the report is for.

It is **still a report rather than the inputs**, because 4 MB of random noise does
not belong in a git-tracked workspace and nearly all of it is the two deliberate
boundary cases. The remaining option is to ship the ordinary cases and describe the
boundary ones, which costs the fixture the property that made it worth having: being
exactly what the gate runs. Left as recorded in that question rather than decided
here.

## The local green was not the gate's green

This spec claimed the scaffold turns "pass the gate" into "make these green". It did
not, and an agent implementing manuscript-review from a scaffold found it rather than
any test here.

`weir accept` copies the candidate into a draft directory **by itself**
(`accept.ts:148`), and the implementation tree stores it as a single
`<node>/<hash>.ts`. So a *runtime* relative import has no sibling to resolve against:

```
✗ submit did not load
  Cannot find module './schema.js'
```

While the scaffold's own vitest loads the file **in place**, next to its siblings,
and passes it. Reproduced on a real scaffold:

```
scaffold's vitest   ✓ 1 passed
the gate            ✗ submit did not load — Cannot find module './schema.js'
```

A green local run the gate rejects — the precise false green this workspace exists to
prevent, in the workspace built to prevent it.

**Fixed with a `selfContained()` stage in the generated `check.ts`.** It reads the
implementation's own source and fails on a runtime relative import in any of its
forms — named, bare side-effect, re-export, `require`, dynamic `import`, and
parent-relative — while leaving `import type` alone, since type imports are erased
and the stub itself uses one. The same scaffold now reports locally:

```
stage:  "not-self-contained"
detail: "./submit.ts imports "./schema.js" at runtime, and the gate loads this file
         alone, so a relative import cannot resolve. Inline what you need, or use an
         'import type' if you only wanted the types."
```

The stub comment and the README now say it too, because a check that only fires after
someone has written the wrong thing is worse than saying so first.

One nuance kept rather than smoothed over: `require("./x")` in ESM fails at *load*,
so it never reaches `selfContained` — caught by the stricter mechanism. Every other
form loads locally and fails only at the gate, which is the set that was silently
passing.

## Two more the same agent found

**`@types/node` was missing from the scaffold's `devDependencies`**, so `tsc
--noEmit` failed in every node directory with `Cannot find module 'node:util'` — the
generated `check.ts` imports `node:util` and now `node:fs`. Fixed in both scaffold
forms.

And a test of mine was wrong about it: the assertion checked `scaffoldFiles`
(single-node) and the **program** form shipped without it anyway. Caught by running
`tsc` in a regenerated scaffold, not by the suite. The test now covers both forms.
That is the sixth test this day whose coverage was narrower than its name.

**Declining on a declared bound requires duplicating it.** The agent inlined
`MAX_ID = 100` and `MAX_TEXT = 2000` by hand and noted they can drift from
`Revision.edge`. It could not import them, by the constraint above — and it could not
simply return an over-long value either, because the gate counts an out-of-schema
return as a *failure* while counting a throw as a legitimate decline. So a
declaration's numbers end up copied into every implementation that might brush
against them. Filed as
[declining requires duplicating a bound](../../open-questions/declining-requires-duplicating-a-bound.md);
not fixed here, because the most promising direction changes what the gate treats as
a decline.

## Committing a scaffold invalidates the next run

The worst consequence of the above, and it is methodological rather than technical.

The scaffold for manuscript-review was committed (by me, via a careless `git add -A`)
with six gate-accepted implementations in it. On the next pass the agent, asked to
implement from the stubs, reported:

> *"the six `<node>.ts` files were **restored from HEAD, not rewritten**, and then
> re-verified against the new harness and the gate."*

Its reasoning was correct — the declarations had not moved, so the committed
implementations still targeted the same contracts — and it said so plainly. But the
pass was then not a test of the loop at all. The entire value of
scaffold → agent → accept is that the agent starts from the stub; a scaffold in git
is a cache of the answers.

**Fixed by having every generated scaffold emit a `.gitignore` containing `*`**, in
the output root, with a comment saying why and how to opt out. In the output root
rather than the repository's own `.gitignore` because `--out` can point anywhere, so
a repository-level pattern only covers the places someone thought to list.

Untracking the one already committed took `git rm -r --cached`: a `.gitignore` has no
effect on files git is already tracking, which is why adding one appeared to do
nothing.

### Two claims in that report that did not hold

Worth recording, because the agent's notes are the most useful artifact the loop
produces and they are not always right.

**"Re-scaffolding destroys implementations."** It does not. The overwrite guard
fires and preserves the file — verified by scaffolding, editing a stub, and
scaffolding again:

```
✗ 6 implementation file(s) already exist under /tmp/guard/nodes:
  · nodes/submit/submit.ts   …
```

**"It may also delete files it doesn't own"** (the missing `notes.md`). It does not;
nothing in the scaffold write path deletes. The agent marked this one *Unverified*,
which is the right instinct and is how it should have marked the first.

Both observations are explained by the directory having been removed before
regenerating, which resets the stubs and takes `notes.md` with it — and which the
guard correctly does not fire on, because there is nothing left to overwrite.

## The loop's best result so far: an agent that stopped

On the clean pass, the agent implementing `revise` wrote everything it could decide,
and then did not guess:

```ts
function nextId(p: reviseInput): string {
  // TODO(jordan): decide what an id without a matching "-r<round>" suffix means.
  throw new Error("revise: nextId not implemented");
}
```

It addressed the TODO to a person by name, and `weir accept` rejected it cleanly on
the stage that was actually at fault:

```
✗ revise was not accepted
  example   given {"id":"m-1-r1","text":"The manuscript","round":1}
            expected {"edge":"Revision","payload":{"id":"m-1-r2",…}}
            actual   {…,"reason":"revise: nextId not implemented"}
```

This is the behaviour the scaffold's README asks for — *"say so rather than returning
a value you made up"* — and the first time an agent has taken it on something other
than an opaque field.

**Its reasoning was right and its target was slightly off.** There is a total
function, and it needs no decision about suffix-less ids:
`p.id.replace(/-r\d+$/, "") + "-r" + (p.round + 1)`, which turns `"L"` at round 1
into `"L-r2"`, satisfies the example, and is accepted. What the contract genuinely
fails to say is subtler: on `"m-1-r9"` at round 1 that expression yields `"m-1-r2"`,
rebuilding the suffix from `round` rather than carrying it — a commitment that
**`round` is authoritative and the suffix derived**, which nothing declares.

And the convention already exists in `runtime.test.ts:2845`, in the fixture that
drives this example end to end. Third time in one day that the answer was in the
repository and absent from the sealed contract, after the property-path grammar and
the `{edge, payload}` shape of a tagged result.

Filed as [`index:` names one field](../../open-questions/index-names-one-field.md),
because the duplication is **forced**: `Revision` declares `index: id`, a revision is
identified by (manuscript, round), and `index:` admits one field — so the round is
packed into the identity string and then exists twice, once typed and once not.
