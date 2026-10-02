# `index:` names one field, so a composite identity gets packed into a string

Status: open.
Last grounded: 2026-10-01 — raised by an agent implementing `revise` from a scaffold
and declining to guess what the packed form means.

## The question

`Revision` declares `index: id`, so `id` is the instance identity and has to be
unique per round. But a revision is really identified by a **pair** — which
manuscript, which round — and `index:` names a single field. So the round gets
concatenated into the identity:

```
id: "m-1-r1"   round: 1
id: "m-1-r2"   round: 2
```

The round now exists **twice**: once as a typed `uint8` with `min: 1, max: 10`, and
once inside a `utf8` as an `-r<n>` suffix that nothing declares, validates, or
relates to the field it duplicates.

## What it cost an implementer

An agent given only the sealed contract wrote everything it could decide and then
stopped:

```ts
function nextId(p: reviseInput): string {
  // TODO(jordan): decide what an id without a matching "-r<round>" suffix means.
  throw new Error("revise: nextId not implemented");
}
```

with the reasoning: *"The examples pin one case: `m-1-r1` at round 1 becomes
`m-1-r2`. Everything else is a choice, because the gate will hand this ids like `L`
and `1Q` that carry no `-r<round>` suffix at all."*

That is the right instinct applied to a slightly wrong target. There **is** a total
function, and it needs no decision about suffix-less ids:

```ts
p.id.replace(/-r\d+$/, "") + "-r" + (p.round + 1)
```

An id with no suffix simply gains one (`"L"` at round 1 becomes `"L-r2"`), the
declared example is satisfied, and `weir accept` passes. But look at what it does on
a *disagreeing* input:

```
"m-1-r9" at round 1  ->  "m-1-r2"
```

The suffix is rebuilt from `round`, not carried from the old suffix. **That is a
semantic commitment — `round` is authoritative and the suffix is derived — and
nothing in the contract states it.** The real ambiguity is not what a suffix-less id
means; it is which of the two copies of the round wins when they disagree. The
implementer has to decide that, and has nothing to decide it from.

## The answer was in the repository, where the implementer could not see it

`runtime.test.ts:2845` already contains exactly that expression, in the fixture that
drives this example's topology end to end:

```js
id: r.id.replace(/-r\d+$/, "") + "-r" + (r.round + 1)
```

So the convention exists, is relied upon, and is recorded only in a test. This is the
third thing in one day whose answer was in the repository and absent from the sealed
contract — the others being the property-path grammar (`property.ts`'s header
comment) and the `{edge, payload}` shape of a tagged result.

## Directions, none settled

- **Let `index:` name several fields.** `index: [id, round]` and the identity is the
  tuple, so nothing is packed and the duplication disappears. The largest change: the
  identity is what `many` keys a collection by and what the `index`-agreement rule
  checks, so a composite key has to serialize *somewhere* to be a collection key, and
  then the question is only whether weir does the packing instead of the author.
  Doing it in one place with a declared separator is still better than each author
  inventing one.
- **Declare the derivation.** Keep one field, and say that `id` is derived from
  `(manuscript, round)` — which needs a notion of a computed field that
  [can a closure carry a formula?](can-a-closure-carry-a-formula.md) is already
  circling.
- **Say which copy is authoritative** and leave the packing alone. Cheapest, and it
  only documents the redundancy rather than removing it.
- **Nothing.** Defensible: a string identity is what most systems have, and the
  author can pick a convention. The cost is measured above — an implementer that
  cannot infer the convention, and a correctness rule living in a test fixture.

## Related

This is the third instance today of **structured data packed into a `utf8` because
the type system had nowhere to put it**, and the only one weir's own model forces:

- geometry inside `RawParcelFeature.featureJson` (blue-ribbon) — friction #1, the
  author's choice.
- the round inside `FactFinding.claim` (manuscript-review) — the author's choice,
  fixed 2026-10-01 by declaring `round` as a field.
- the round inside `Revision.id` — **not** a free choice, because `index:` admits one
  field and the identity needs two.

Also related: [positional identity](positional-identity.md), which is the same
question about a node's identity rather than an edge instance's.
