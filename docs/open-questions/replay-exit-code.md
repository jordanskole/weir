# `weir replay` exits zero even when every invocation refused

Status: open.
Last grounded: 2026-09-29 — pinned by a test in `fork.test.ts`.

`replay` catches each invocation's error, prints it as `✗ <node> <reason>`, and
returns `code: 0` unconditionally. So a replay in which **every** invocation was
refused — a drifted contract, a changed implementation, a node no longer
declared — reports success to anything reading the exit code.

Found 2026-09-29 while making the contract-drift refusal reach effect nodes: the
refusal fired correctly and the command still exited zero, so the test asserting
it had to assert on output text instead.

## Why it was not just fixed

Changing it changes what `replay` *means* to anything scripting it, and the
current behaviour is defensible: replay's job is arguably to produce a report of
what happened rather than a verdict, which is what `verify` is for — and `verify`
does return a verdict.

If that is the intent, the report should say so much more loudly than it does; a
line of `✗` among `·` lines is easy to miss. If it is not the intent, the fix is
one line.

Undecided which. The neighbouring precedent cuts the other way: `weir run` exits
non-zero on residue precisely because *"a CLI run is someone asking 'did this
work'"*, and a caller of `replay` is plausibly asking the same thing.
