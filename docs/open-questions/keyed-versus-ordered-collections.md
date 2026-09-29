# A collection is keyed, and streamed data is ordered

Status: open.
Last grounded: 2026-09-29 — re-verified; `many` over an index-less edge is still
rejected at elaboration with *"references "LogEvent", which declares no index —
a collection needs a real key."*

## The question

`many` makes two commitments: every element carries an author-chosen unique
`index`, enforced by `elaborate.ts`'s `requireIndex`; and order is explicitly
non-load-bearing, which the coordinate model then builds on by defining **x** as
the collection key rather than a position.

Both hold for domain entities and both fail for rows. A log line has no natural
unique identifier — two identical lines in the same millisecond are distinct
rows that collapse to one key — and an Arrow RecordBatch is positional, `0..N-1`,
where the order *is* the information. So the first thing a log-ingestion
topology needs is the first thing that will not elaborate.

The earlier rejection of synthetic keys — *"a key nobody chose carries no more
meaning than a position does"* — was correct for `Ingredient` and `Todo` and
inverts for a table row, where position is exactly the meaning. The conclusion
was sound; its scope was narrower than it read.

## What has changed since it was written

**The narrower version of this has an answer, and it is "promote position to a
key".** A polygon ring is genuinely ordered, and it declares fine: a `Vertex`
with `index: seq`, a `Ring` with `index: seq` holding `many: Vertex`, a geometry
holding `many: Ring`. Nested `many` elaborates and runs
(`spikes/blue-ribbon-soil`). So weir's rule was never "no ordered data" — it is
"elements need identity", and a position is an identity when you declare it as
one. `readme.md` now says so.

That does **not** close this question, and the distinction is the live part: a
polygon ring has a *bounded, authored* sequence where writing `seq` is honest.
A stream does not. Synthesising `seq` for every row of an unbounded feed is the
synthetic key the original rejection was about, and it also makes the count a
thing the producer must know in advance, which a stream by definition does not.

## Not decided

Whether this is a second collection kind beside `many` (an ordered sequence,
identity by position, consuming position 3 and position 7 as distinct even with
identical payloads), a flag on `many`, or a real edge of its own carrying rows
alongside batch metadata the way a RecordBatch carries a schema and a watermark.
The third is probably what a pipe's unit wants to be.

The knock-on to check before choosing: an ordered collection makes **x**
positional for those edges, which *amends* a settled decision in the coordinate
model rather than adding beside it.
