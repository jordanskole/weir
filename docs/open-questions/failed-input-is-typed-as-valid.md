# `Failed<In>.input` is typed as validated data it never was

Status: open.
Last grounded: 2026-09-29 — still cast at `membrane.ts:699` and `:706`.

When an input is rejected at the boundary the membrane returns
`{ input: payload as InputPayload<In>, reason }` — but that payload is precisely
the value that **failed** validation, cast to the type meaning "a valid payload
of this shape".

The consumer that makes this more than cosmetic is the one `design.md` §3 names:
*"Retry is a node consuming `Failed<In>`"*, carrying the original payload so a
retry node has something to re-emit. A retry node reading `failed.input` is
handed data the type promises is valid and the runtime knows is not, and
re-emitting it puts it back on the wire under that promise.

Nothing dereferences it today, which is why this is recorded rather than fixed.

## Candidate answers

- Type it `unknown` and make a retry node re-assert explicitly. Honest, and it
  pushes the check to where the value re-enters.
- Give `Failed<In>` two shapes, distinguishing "rejected before validation" from
  "threw during execution" — the second already carries a genuinely validated
  input, which is why one type covering both is what forces the lie.

**Now demonstrable:** `examples/flaky-source` routes a `Failed_RateRequest` into
a real recovery node, so this stopped being hypothetical the moment the corpus
gained its first failure-consuming node. That node reads `failed.input.base` and
`failed.input.quote` — fields which happen to be valid, because the failure was
in the *output* assertion rather than the input one. A node consuming a genuine
input rejection would be reading the lie.
