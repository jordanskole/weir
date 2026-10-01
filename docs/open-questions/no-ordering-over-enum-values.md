# The expression language has no ordering over `enumValues`

Status: open.
Last grounded: 2026-10-01 — raised by the one property guarding blue-ribbon's
provenance lattice turning out to be a tautology, because the real property was
inexpressible.

## The question

A provenance lattice ranks `verified > inferred > aggregator > listing claim`, and
the invariant that matters is *"a combined value is never stronger than either
source"* — the lattice meet. The expression language cannot say it.

`lit get eq ne lt lte gt gte add sub and or not implies` all exist, so `lte` is
there. The problem is what it compares. `evaluateProperty` applies `<=` to the
resolved values directly, and these values are strings, so the comparison is
lexicographic:

```
lattice order : listing claim < aggregator < inferred < verified
string order  : aggregator < inferred < listing claim < verified
```

Different orders. `lte` on this enum would assert *the wrong thing* rather than
nothing, which is worse than being unable to express it.

## Why it is load-bearing rather than tidy

The property that wanted this was
`resolveIdentity`'s *"combined provenance is never stronger than either input"*,
and what was actually declared was:

```yaml
expr:
  eq:
    - get: output.provenance
    - get: output.provenance
```

A self-comparison. It held for every possible output — demonstrated with both
inputs at `listing claim` and the output claiming `verified`. So the single
property guarding the most carefully built thing in that pipeline could not fail,
and the acceptance gate reported it as passing.

`weir check` now refuses that shape (`assertFalsifiable`), which converts the
false green into a decision: express it or drop it. It was dropped, because it
cannot currently be expressed. **That is the cost this question measures** — the
missing operator is why a tautology looked like the least-bad option to the author
who wrote it.

## `ordinal: true` exists and is not sufficient

`FieldDef.ordinal` is already declared, added for the envelope's `meet`/`join`
combination rules: *"This enum's declared `enumValues` order is a total order,
weakest first."* So the declaration side is done.

The missing half is the evaluator. `lt`/`lte`/`gt`/`gte` would need to resolve an
ordinal enum's value to its **rank in `enumValues`** rather than compare the string.
That is the whole change, and it has one subtlety worth deciding rather than
discovering: the comparison operators would then behave differently depending on
the *field* a path resolves to, so an expression's meaning depends on the schema
and not only on the expression. That is arguably already true (`add` on a `utf8`
is nonsense) but it becomes load-bearing here.

## Options, none settled

- **Rank-aware comparison operators.** `lte` resolves an ordinal enum to its index.
  Smallest change, and it makes the property a one-liner. The subtlety above is
  the whole of the design question.
- **An explicit `rank` operator**, so `lte: [{ rank: { get: … } }, …]` says what it
  is doing and nothing changes meaning silently. More verbose, more honest, one
  more operator.
- **Leave it out, and let the membrane enforce lattice combination** via the
  envelope's `combine: meet`, which already exists and already does this for
  envelope fields. Possibly the real answer: if `provenance` were an envelope field
  with `combine: meet` and `ordinal: true`, the meet would be enforced by
  construction and no property would be needed. Worth checking before building an
  operator — it may be that the right fix is to move the field rather than extend
  the language.

The third option is the one to evaluate first, because it would mean this question
resolves to "you were holding it wrong" rather than to new machinery.

## Related

- [the deterministic scaffold](../superpowers/specs/2026-10-01-the-deterministic-scaffold.md)
  is what found this, by rendering the property as source.
- [property coverage over output fields](property-coverage-over-output-fields.md) —
  note that the coverage check proposed there would **not** have caught this
  tautology, since `output.provenance` is mentioned. Recorded there.
- [can a closure carry a formula?](can-a-closure-carry-a-formula.md) is the same
  tension from the other side: how much computation belongs in a declaration.
