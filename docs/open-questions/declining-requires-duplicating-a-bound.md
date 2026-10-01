# An implementation cannot decline on a declared bound without duplicating it

Status: open.
Last grounded: 2026-10-01 — raised by an agent implementing manuscript-review from
a scaffold, which inlined `MAX_ID = 100` and `MAX_TEXT = 2000` by hand and noted
they can drift.

## The question

`submit` grows an id (`<id>-r1`) and `revise` grows a text (`… (revised)`). Both can
exceed the declared `maxLength` of the field they are written to. The agent
implementing them wrote:

```ts
const MAX_ID = 100;    // from Revision.edge, by hand
const MAX_TEXT = 2000;
…
if (id.length > MAX_ID) throw new Error("submit: id would exceed its bound");
```

and recorded the obvious consequence: *"Inlined bounds can drift from
`Revision.edge`. If those bounds change, `submit` and `revise` need updating by
hand."*

It could not import the bound instead, because
[an implementation is loaded as a lone file](nodes-as-distributable-units.md) — the
gate copies the candidate into a draft directory by itself and the implementation
tree stores it as a single `<node>/<hash>.ts`, so a runtime `import … from
"./schema.js"` cannot resolve.

## Why it cannot simply return and let the membrane reject

The obvious answer — don't check the bound, return the value, let `assertOutput`
reject it — does not work, and the reason is an asymmetry worth deciding about
rather than inheriting.

The gate treats the two differently:

| what the implementation does | gate's verdict |
|---|---|
| `throw` | a **decline** — legitimate, counted as `Failed<In>` |
| return a value outside the declared output | a **failure** — `result matched neither the declared output nor Failed<In>` |

Both end as a `Failed` record at runtime. But only the throw is a *considered*
refusal, so only the throw is tolerated — and an implementation can only throw
deliberately if it knows the bound. Hence the duplication.

That asymmetry is defensible: returning an out-of-schema value usually *is* a bug,
and treating it as a decline would mask one. It is also exactly what forces a
declaration's numbers into every implementation that might brush against them.

## Candidate directions, none settled

- **Let the gate count a declared-bound violation as a decline**, distinguished
  from other out-of-schema results by the reason the membrane already produces
  (`"combined should have length <= 1003"` versus a missing or mistyped field). The
  implementation then needs no bound at all — it returns, and the membrane decides.
  Cheapest, and it narrows what "wrong shape" means, which may be too clever.
- **Carry the sibling schema into the draft directory and the implementation
  tree**, so a candidate may import its own generated schema at runtime. Removes
  the duplication at its source, and makes an implementation no longer a single
  file — which is a real change to what a node *is*, and
  [nodes as distributable units](nodes-as-distributable-units.md) is where that
  belongs.
- **Have the scaffold emit the bounds as generated constants** in the file the
  implementer edits. Does not actually work: the scaffold refuses to overwrite that
  file, so the constants are generated once and drift exactly as a hand-copy would.
- **Accept the drift**, and rely on the gate to catch a stale bound. It will, but
  only when a generated case crosses it — and after the string-length fix the
  generator reaches a declared maximum exactly once per batch, so a stale bound that
  is *looser* than the declaration is caught and one that is *tighter* produces a
  decline the gate reads as legitimate. Asymmetric, and quiet in the direction that
  matters.

The first is the one to evaluate first, because it removes the implementation's need
to know the number at all rather than finding a better way to tell it.

## Related

- [nodes as distributable units](nodes-as-distributable-units.md) — whether an
  implementation is one file is the question underneath this one.
- [the deterministic scaffold](../superpowers/specs/2026-10-01-the-deterministic-scaffold.md)
  now warns that a candidate must stand alone, and `check()` fails a runtime
  relative import, but it has nothing to say about the bound itself.
