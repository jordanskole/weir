# A durable trace, replay, and the determinism check

Status: draft.

## Motivation

`design.md` §0 now states Principle 0 — *decomposition is bounded by determinism* — and says of its lineage that **weir makes it mechanical**. Nothing currently does. A node's `Fn` can call `Date.now()`, sample at a temperature above zero, or read a hosted endpoint, and every check built this week passes: elaboration, the wiring rules, the acceptance gate, the contract hash. The principle is asserted and unenforced.

The parts of a check already exist and have never been connected:

- `TraceEntry` records `{envelope, input, result}` for every invocation.
- `replayInvocation` re-runs a pinned implementation against a recorded input, and **deliberately does not compare** — its own header says *"judging the result is the caller's."*
- Nobody is that caller.

**Replay the recorded input, compare to the recorded result, and a mismatch is proof that the node read something its contract does not declare.** That is Principle 0's first bullet, checked, from parts already on disk.

### Why the comparison isolates exactly the violation

Worked through against the case that prompted it (Jordan, 2026-09-26, on probabilistic boxes):

| the node | on replay | verdict |
|---|---|---|
| fixed-weight classifier — deterministic, output merely expresses doubt | identical result | passes, correctly |
| nondeterminism declared as an **effect** — performed by the runtime, recorded | the recorded result arrives as *input data*, so the same input yields the same output | passes, correctly |
| nondeterminism reached for directly — `Date.now()`, an unseeded sample | different result | **caught** |

The middle row is the important one: an effect that was properly declared is invisible to this check, which is what makes a mismatch *mean* something rather than merely correlate with "this node touches the world".

## 1. `FileTrace`

The Trace is the missing half of the durable pair. `FileLog` landed 2026-09-26; the CLI shipped `run` but not `replay` because `replayInvocation` reads a `TraceEntry` and the Trace still dies with the process.

`Trace` is two methods — `record(entry)`, `entries(correlationId)` — so `FileTrace` mirrors `FileLog` exactly and is smaller: an append-only `.jsonl` file with an in-memory index, reads synchronous and answered from the index, one line per entry. The same reasoning applies about not making it async, for the same reason, and both run against one shared behaviour suite so the durable implementation cannot diverge from the in-memory one.

One difference worth naming: a `TraceEntry` has no `seq` and no id of its own. Its identity is `envelope.id`, the invocation. That is enough to index by and enough to address one entry from the CLI.

## 2. `weir replay <run-id>`

Reads every entry for a correlation and re-runs each against the implementation its `contractHash` pins, reporting what came back. No judgement — this is the primitive, and `replayInvocation` already refuses a declaration that has drifted since the invocation.

The point of shipping it separately from §3 is that replay is useful without a verdict: it is how you get a failed invocation back under a debugger.

## 3. `weir verify <run-id>` — the check

Replay every entry and compare the result to the recorded one. Report each mismatch with the node, both results, and the input that produced them.

**Comparison is structural equality on the payload**, not identity. Two objects with the same fields are the same result; ordering within a keyed collection is not significant, consistent with `many` being keyed rather than positional.

**A mismatch is a hard failure, exit non-zero.** It is not a warning: the whole claim that a node can be handed to an agent, replaced, or replayed rests on it being false.

What `verify` cannot see, stated so it is not mistaken for a guarantee: nondeterminism that happens to produce the same answer twice. A node reading a clock at second granularity passes if the replay lands in the same second. The check finds violations; it does not certify their absence — which is the ordinary asymmetry of a test, and worth writing in the output rather than implying otherwise.

## 4. What this deliberately does not do

**It does not sandbox.** Preventing a node from reaching a clock is a different mechanism — the membrane bounding *behaviour* rather than checking it afterwards — and `open-questions.md` already carries that as its own question ("the membrane bounds behaviour, not control"). This is detection, which is cheap and available now; prevention is not.

**It does not settle the version pin.** `verify` replays against whatever the contract hash resolves to, which is the current file rather than the one that ran (open-questions.md, "The version pin pins the contract, not the implementation"). A mismatch could therefore mean *the implementation changed* rather than *the node is nondeterministic*, and the output must say so rather than accuse the node. That ambiguity is a reason to fix the pin, not a reason to delay this.

## Testing

Break-proofs required for each. `tsconfig.json` excludes `src/**/*.test.ts`, so test files are never typechecked.

1. `FileTrace` satisfies the shared `Trace` behaviour suite, alongside `InMemoryTrace`.
2. Record, close, reopen: every entry returns with the same envelope, input and result.
3. `verify` passes a deterministic node — including one whose output expresses uncertainty, so "probabilistic" is not confused with "nondeterministic".
4. `verify` **fails** a node whose `Fn` reads a clock, naming the node and both results. This is the test the feature exists for, and it must fail before the feature exists.
5. `verify` **passes** a node whose nondeterminism arrived as recorded input, proving the check does not merely flag every node that touches the world.
6. A mismatch exits non-zero; a clean run exits zero.

## Explicitly out of scope

- **Sandboxing** (§4).
- **Fixing the version pin**, tracked separately.
- **Cross-run verification.** One correlation at a time, consistent with everything else.
- **Re-running whole topologies.** `verify` replays recorded *invocations* independently; it does not re-execute the graph, which would reintroduce scheduling as a variable and check something else.
