# An origin node can never iterate

Status: open.
Last grounded: 2026-09-29 — re-verified against `runtime.ts:611`; still true.

## The question

A node that is both an origin *and* a `feeds` target is never offered instance
candidates, so it cannot iterate however the topology wires it:

```ts
// runtime.ts:611, inside the `single`-input branch
if (origins.has(nodeName)) {
  if (!(nodeName in originPayloads)) return false;
  payload = originPayloads[nodeName];
} else {
  if (instance === undefined) return false;
  payload = instance.payload;
}
```

The origin check comes first and routes to the once-only branch unconditionally.

Surfaced building instance retention (piece 1 of the iteration work), and not
anticipated when that was scoped. It matches pre-iteration behaviour, so it is
not a regression.

## Why it is still open

Nothing has needed it. The practical consequence is a rule authors must know
rather than a thing they cannot do: **a fixture exercising a self-feeding node
needs a separate seed node feeding it**, not the origin doubling as the looped
node. `examples/escalation` is wired that way for exactly this reason.

Undecided whether the fix is to let an origin also consume instances (making the
origin payload the *first* token rather than the only one), or to keep the
restriction and state it in `design.md` where an author would find it. The
second is cheap and nothing currently argues for the first.
