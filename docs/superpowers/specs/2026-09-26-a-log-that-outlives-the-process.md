# A log that outlives the process

Status: draft.

## Motivation

`InMemoryLog` is the only `Log` there is, so every run starts empty and dies with the process. `readme.md` names it under "not built yet"; the CLI shipped without `run` or `replay` for the same reason, and said so in its help text rather than shipping a demo as a tool.

Three things are waiting on it:

- **`weir run` and `weir replay` as real commands.** `replayInvocation` already replays against a pinned implementation version, which is meaningless if the invocation it replays cannot survive a process boundary.
- **Retention as a real question.** Spread made the cost concrete — a `many` output now costs N+1 instances — and design-history.md ("Fan-out and pipes are duals") records that a fan-out needs every instance kept while a pipe wants them gone once consumed. There is nowhere to put that policy while the only store is a `Map` that lives and dies with one call.
- **`open-questions.md`'s "`Log` is doing two jobs"**, which is genuinely live.

## A stale claim, corrected first

That open-questions entry says two questions "both become live the instant `InMemoryLog` is replaced by a real store — that's one decision, not two." One of the two is already gone.

The second was that `runtime.ts`'s `tryFire` rebuilds an `allOf` node's bag with its own `log.latest` loop, duplicating a read the membrane's `allOf` invoke performed internally, so the two could drift if reads stopped being same-tick. **The membrane stopped resolving `allOf` inputs in piece (3) §5** — it takes the bag as an argument and only asserts it. Verified: `membrane.ts` contains no `log.latest` call outside the interface declaration and `InMemoryLog`'s own implementation, and `runtime.ts` mentions it only in a comment. There is one read. The hazard is not dormant, it is absent, and the entry should be corrected rather than carried into this work.

What remains live is the first half: `append` both records a provenance-carrying emission and stages an input with no invocation behind it, and a durable store makes that ambiguity permanent rather than per-process.

## Design

### 1. Write-through, not async

The obvious move — make `Log` async because storage is — is the wrong one, and the cost is worth stating before it is dismissed. Every read would have to be awaited, and the readers are `eligibleForEdge`, `joinRows`, `selfAndAncestorIds` and the pulse loop's snapshot, several of them inside nested loops per pulse. That is an invasive change to the most carefully reasoned code in the spike, and it buys nothing a spike needs.

**Resolved: an append-only file with an in-memory index in front of it.** Reads stay synchronous and answer from the index; `append` pushes to the index and writes one line. That is how an append-only log is normally built — a durable segment plus an index over it — rather than a compromise, and it leaves the async question to whoever needs a store this one cannot be.

The bound it accepts: the index holds the working set in memory. That is the same bound `InMemoryLog` already has, so nothing regresses; what changes is that the *file* is complete even when the index is not, which is what makes eviction possible later (§4).

### 2. Format

One JSON object per line (`.jsonl`), one line per instance, in append order:

```json
{"id":"…","seq":0,"correlationId":"run-1","edge":"Run","payload":{…}}
{"id":"…","seq":1,"correlationId":"run-1","edge":"Dough","payload":{…},"envelope":{…}}
```

`edge` and `correlationId` are stored per line because the index is rebuilt from the file and they are its keys. `seq` is stored rather than recomputed on load: it is a logical clock and the lineage join orders by it, so a reload that renumbered would change which ancestor is "nearest".

### 3. Staging becomes explicit

`append`'s `envelope` is optional, and its absence currently means two different things: "this was staged from outside" and "this node's envelope could not be built". A durable log makes that permanent, and `eligibleInstances` already treats an envelope-less instance as eligible by type alone — a real bypass, keyed on an ambiguity.

**Resolved: staged instances are marked.** A `"staged": true` field, written by a `stage()` method distinct from `append()`. The bypass then keys on an explicit marker rather than on an absence, and a reloaded log can still tell the two apart. `invokeWithInput` no longer stages (piece (3) §5), so the only caller is tests — which is an argument for making it explicit, not for leaving it implicit.

### 4. Retention is deliberately not implemented

The file keeps everything; the index keeps everything; nothing evicts. Recorded as a decision rather than an omission: eviction policy is per-mode (a fan-out needs its instances for the rejoin, a pipe does not), and getting it wrong silently breaks lineage — the failure mode is a join that stops firing for reasons nothing in the log explains. The right time is when a topology exists that needs it, with a test that reddens.

What this spec does is make eviction *possible*: because the file is complete and the index is derived, an index that drops an instance is recoverable, and an index that drops one lineage still needs is a bug with a fix rather than data loss.

### 5. Cross-run reads

A durable log spans runs, which `InMemoryLog` never did. `instanceById` is already documented as global across correlations; `instances(edge, correlationId)` is scoped and stays so. Loading rebuilds both indexes from the file in one pass.

Cross-*correlation* joining stays out of scope, as it has been since piece (3): nothing joins across runs by design.

## Testing

Break-proofs required for each. `tsconfig.json` excludes `src/**/*.test.ts`, so test files are never typechecked.

1. A `FileLog` satisfies the same behaviour as `InMemoryLog` — run the existing `Log` assertions against both, so the durable one cannot quietly diverge.
2. Append, close, reopen: every instance is present with the same `id`, `seq`, payload and envelope.
3. `seq` survives a reload unrenumbered, and a lineage join over a reloaded log picks the same nearest ancestor. This is the assertion that matters: renumbering would change grouping, silently.
4. A staged instance reloads as staged, and an emitted one does not.
5. Two runs in one file do not see each other's instances through `instances(edge, correlationId)`, and `instanceById` finds both.
6. `weir run` executes a program against a `FileLog` and the log is readable afterwards; `weir replay` reads an invocation back out of it.

## Explicitly out of scope

- **Making `Log` async**, and with it any store this shape cannot be.
- **Eviction and retention policy** (§4).
- **Concurrent writers.** One process, one file, append-only. A second writer is a different design, not a bigger one.
- **fsync durability.** Writes go through the OS buffer; a crash can lose the tail. Named so it is a known limit rather than an assumed guarantee.
- **Compaction**, log rotation, and segment files.
