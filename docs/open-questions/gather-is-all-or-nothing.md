# A gather is all-or-nothing, and a batch wants partial success

Status: open. **The last blocker on `run-granularity`.**
Last grounded: 2026-10-01 — split out of
[run granularity](run-granularity.md), whose other two blockers both shipped.

## The question

A gather whose group contains a `Failed_*` descendant fails as a whole, under a
synthesized `Failed_Many_X`. That is not an accident — `gather` **is**
`sequence`, and `sequence`'s signature says one element's failure is the whole
result's:

```
t (f a) → f (t a)
```

There is no `f (t a)` for "most of them worked".

**And a batch job wants exactly that.** The pressure-test's real workload is
~3,265 parcels per corridor producing one artifact, and its stated semantics are
*"that parcel gets a null with a note; the other 3,264 still produce cards"*. One
failed lookup currently kills the group, so the corridor produces nothing.

## Why the obvious workaround is not enough

A node can route a legitimate absence as `oneOf: [Found, Unavailable]` and both
branches can be handled — that shape works, and since 2026-09-29 it no longer
reports a false stall. So *expected* absence is already expressible.

What is not is **unexpected** failure: a node that throws, a response that fails
assertion, an effect handler that times out. Those produce `Failed_X`, and no
amount of declaring can convert them into an `Unavailable` the author
anticipated — which is the point of `Failed_X` existing.

## What it would have to be

A `traverse` that tolerates failures returns **two** things: the partial
collection and the failures. Candidate shapes, none designed:

- A gather whose output is `allOf: [Collection, Failures]`, making the failure
  list a declared edge a downstream node must consume — the most weir-ish, and it
  forces the author to say what happens to the failures rather than ignoring
  them.
- A declared tolerance (`tolerate: 0.01`), which turns a judgement into a number
  and will be wrong for somebody.
- Report residue **into the payload** rather than only to the exit code, which is
  what the reporter actually asked for and is the smallest change — though it
  answers "what did not finish" rather than "what failed".

The first is the one worth designing. The reason is the usual one: it makes the
failure a thing on a wire that something must handle, rather than a number in a
declaration or a line in a log.

## What this is not

Not the dead-group rule being wrong. `gather`'s all-or-nothing behaviour is
correct *for a gather*, and was built deliberately to stop a group hanging until
the budget. The question is whether weir also needs the other operation, beside
it, with a different signature and a different name.
