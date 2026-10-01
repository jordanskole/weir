# Implementations, rescued from `/tmp`

These are the node bodies, effect handlers and payload that make this spike
**runnable**. They were written when the spike was, and they lived only in
`/tmp/soil-bodies` — so the README's claims were one `/tmp` clear of being
unverifiable. Moved here 2026-10-01.

Verified on the way in, against the current declarations:

```
weir test ../blue-ribbon-soil --impl /tmp/soil-impl
  ✓ 9 passed, 0 failed, 0 skipped

weir run ../blue-ribbon-soil --impl … --payload … --effects …
  ✓ quiescence — 14 firings, 12 pulses
```

Both match what the spike's README claimed, so nothing here has rotted.

## Running it

`weir run` resolves implementations by **contract hash**, not by filename, so these
sources have to be placed at their hashed paths before a run. The hashed tree is
not checked in — build it with `weir accept`, or see the per-node hashes a failing
`weir run` prints.

```bash
cd ../../ts-prototype
npx tsx bin/weir.ts run ../blue-ribbon-soil \
  --impl <hashed impl tree> \
  --payload ../blue-ribbon-soil/impl/payload.json \
  --effects ../blue-ribbon-soil/impl/effects.ts \
  --run soil-1
```

## What is here

| file | what it is |
|---|---|
| `buildSoilQuery.ts` … `assembleAdjacency.ts` | the nine pure node bodies |
| `effects.ts` | handlers for the three chained effects, answering as USDA SDA would |
| `payload.json` | one parcel's geometry, the run's trigger |

`measureSoilPolygon.ts` is the one worth reading: it is the area formula that in
blue-ribbon is a SQL string constant whose own comment records two earlier versions
"proven wrong by ~8.4x at this latitude." Here it is a pure function with declared
properties, including the one that catches the real bug class — `abs()` on a signed
area, because SDA does not guarantee ring winding.

These were never put through `weir accept`, so they have no `.meta.json` and carry
no acceptance record. Same caveat as
[the slice's drafted implementations](../../blue-ribbon-slice/drafted/README.md),
for the same reason: they were written to make the spike run, not to pass the gate.
