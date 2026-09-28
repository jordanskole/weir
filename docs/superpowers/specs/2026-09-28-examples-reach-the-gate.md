# Examples reach the gate

Status: draft.

## Motivation

A **correct** implementation of `examples/recipe`'s `mix` is rejected by the
acceptance gate. Verified by running it, not reasoned about:

```
given  = {"Recipe": {"title": "Chocolate Chip Cookies", "servings": 24, …}}
actual = {"input": {"Recipe": {…}}}          ← Failed<In>
accepted: false | reason: checks-failed
```

A `.node` file's `examples` are **tagged by edge name** — `given: { Recipe: … }`
— which is what `schema.ts` validates and what `parseAnyOfNodeFile` relies on to
route each example to the right shadow. A `NodeDef`'s TypeScript `examples` are
**bare**: `given` is `InputPayload<In>`, the payload `Fn` actually receives.
Nothing translates between them. `accept.ts` hands `example.given` straight to
`invokeWithInput`, the membrane asserts `{Recipe: {…}}` against the `Recipe`
schema, it fails, and the example resolves to `Failed<In>` — which cannot equal
the declared `expect`.

So **every example in `examples/` fails its own acceptance gate**, and the reason
nobody noticed is that `acceptImplementation` has only ever been called with
hand-constructed `NodeDef`s in tests.

This is the claim-versus-enforcement pattern at the most load-bearing place left.
The pitch is that *a drafted implementation is not allowed to persist until it
passes its declared examples* — and the corpus of declared examples in this repo
has never been through the gate that sentence describes. They are validated for
**shape** by `nodeSchema()` and never **run**.

**A second instance, found while writing this and worth recording because of who
wrote it.** `design.md` §10 claimed a node's contract hash covers `examples`.
`hash.ts` excludes them on purpose, and says so in a comment. That line was
introduced *by the docs accuracy pass two days ago* — a pass whose entire job was
removing claims the code did not support. Corrected. It also decides this spec's
migration cost: because examples are not hashed, changing their shape invalidates
no accepted implementation.

## 1. Where to translate

Two places could do it, and only one keeps a single shape.

**At the gate** (`accept.ts` untags before invoking) means `NodeDecl.examples`
has one shape when it came from YAML and another when it came from TypeScript,
and every future consumer has to know which. Rejected.

**At elaboration** (`parseNodeFile` untags on the way in) means `NodeDecl` is
uniform: `examples` always holds what `Fn` receives and returns. The tagging
becomes what it should always have been — an *authoring affordance*, present in
the file and gone by the time anything reads the declaration.

**Resolved: at elaboration.** One consequence to sequence rather than discover:
`parseAnyOfNodeFile` routes examples to shadows by `edge.name in example.given`,
so untagging has to happen *after* that routing, in the same function.

## 2. The translation, which is smaller than it looks and asymmetric

`given`, by input kind:

| kind | authoring form | runtime form |
|---|---|---|
| `single` | `{ Recipe: p }` | `p` |
| `gather` | `{ Assessment: c }` | `c` (the collection) |
| `allOf` | `{ A: pa, B: pb }` | `{ A: pa, B: pb }` — **unchanged** |
| `anyOf` | `{ A: pa }` | routed to the `A` shadow, then `pa` |

`expect`, by output kind:

| kind | authoring form | runtime form |
|---|---|---|
| `single` | `{ Dough: p }` | `p` |
| `many` | `{ Entity: c }` | `c` (the collection) |
| `oneOf` | `{ Ticket: p }` | `{ edge: "Ticket", payload: p }` |
| `allOf` | `{ A: pa, B: pb }` | `[{ edge: "A", payload: pa }, { edge: "B", payload: pb }]` |

**The asymmetry is the interesting part, and it is not an inconsistency.** An
`allOf` *input* bag is keyed by edge name by design — the authoring form and the
runtime form genuinely coincide, so there is nothing to strip. An `allOf`
*output* is a list of tagged branches, so they genuinely differ. Same word, two
positions, and the translation table is where that stops being confusing.

`oneOf` is the one case where untagging *adds* structure rather than removing it:
the tag carries which branch fired, which the runtime form spells out as
`{edge, payload}`.

## 3. What this will find

Stated in advance, because "the gate now runs and everything passes" would be the
least likely outcome and the one most worth being suspicious of.

Once examples are actually executed, an example whose `expect` was never checked
against a real `Fn` can be wrong — a typo in a field name, a value that drifted
when the edge changed, an `expect` for a branch the example's `given` does not
produce. The `soc-triage` and `manuscript-review` examples were hand-written
alongside implementations that live in test files, so their examples and their
implementations have never been compared by anything.

**Any example this turns up is a finding, not an obstacle.** Fixing them is part
of the build; recording what was wrong is the point of doing it.

## 4. The gate needs a way to be run

Untagging makes the gate *correct* for real declarations. It does not make it
*reachable*: `acceptImplementation` has no CLI entry, so the only callers are
tests. Two pieces, and they are separable:

**A test that runs every example in `examples/` through the gate.** This is the
guard that would have caught the defect and the one that keeps it caught. It
needs an implementation per node, which the runtime tests already supply for
every example — those move to a shared fixture rather than being written twice.

**`weir accept <dir> --node <name> --source <file> --impl <dir>`**, so an agent
or a human can run the gate on a candidate from outside the test suite. Smaller
value than the test and easy to add alongside it.

## 5. What this does not change

- **No contract hash moves.** Examples are not fingerprinted (`hash.ts`), which
  is what makes this a shape change rather than a migration.
- **The authoring form stays exactly as it is.** Every `.node` file in the repo
  is untouched; `nodeSchema()` still validates the tagged shape, because that is
  still what an author writes.
- **`exportContract` carries the translated form**, which is a small improvement
  rather than a cost: the sealed contract an isolated agent receives will show
  examples in the shape its `Fn` actually sees, instead of a shape it must guess
  the encoding of.

## Testing

Break-proofs required for each, recorded in the test's own comment along with
what the break-proof showed — including breaks that do **not** redden, since
three of `gather`'s did not and saying so is what kept them honest.

1. **A real example from `examples/` passes the gate with a correct
   implementation.** `mix` is the case from the motivation; assert accepted,
   which fails today.
2. A correct implementation is still **rejected** when an example is genuinely
   wrong — the gate must not have been loosened into uselessness by the fix.
   Mutate one expected value and assert the rejection names it.
3. Each input kind untags correctly: `single`, `gather`, `allOf` (unchanged), and
   an `anyOf` node's examples routed to the right shadow *and then* untagged.
4. Each output kind untags correctly, `oneOf` and `allOf` especially, since those
   two *change shape* rather than merely losing a wrapper.
5. **Every node in every example runs its declared examples through the gate.**
   The corpus-wide guard, and the test that makes §3's findings visible.
6. `exportContract`'s examples are the translated form, so an agent is shown what
   `Fn` receives.

## Explicitly out of scope

- **Changing the authoring form.** The tagged YAML shape is good and stays.
- **Putting `examples` in the contract hash.** A real open question
  (open-questions.md, "which parts of a node declaration are contract"), made no
  more urgent by this, and deliberately not bundled.
- **`weir accept`'s draft/iterate loop.** This spec adds a way to run the gate
  once on a candidate, not an agent workflow around it.
