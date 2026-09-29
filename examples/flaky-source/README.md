# flaky-source

**The example that exists because every other one is clean.**

Every other example in this corpus is a well-behaved fixture: the data is the
shape it says it is, and nothing outside the program is involved. That made a
whole half of weir invisible. The first outside reader to model a real
integration read the docs end to end and concluded that weir does not validate
what comes back from an effect — it does, and has since effects shipped — and
then designed around a problem that did not exist.

So this example is about what happens when something goes wrong at a boundary.

It is also the only example that declares an `effect:`, the only one that
routes a `Failed_*` edge, and the only one with an `enumValues` field. Each of
those was a thing a reader had to learn from an error message.

## The program

```
RateRequest --> fetchRate  [effect: http] --> Rate
                    |
                    | Failed_RateRequest
                    v
                useFallback ----------------> Rate
```

Two nodes, two edges, and **both nodes are terminals**. A run answers through
exactly one of them.

## Run it

```bash
cd spikes/ts-prototype

# The recovery path is an ordinary node, so it goes through the gate first.
npx tsx bin/weir.ts accept useFallback ../../examples/flaky-source \
  --source ../../examples/flaky-source/implementations/useFallback.ts \
  --impl /tmp/fs-impl

echo '{"base":"EUR","quote":"USD"}' > /tmp/fs-payload.json
E=../../examples/flaky-source

# The service behaves.
npx tsx bin/weir.ts run $E --impl /tmp/fs-impl --payload /tmp/fs-payload.json \
  --effects $E/effects.ts --run ok1 --log /tmp/fs-ok.jsonl

# The service misbehaves.
BAD=1 npx tsx bin/weir.ts run $E --impl /tmp/fs-impl --payload /tmp/fs-payload.json \
  --effects $E/effects.ts --run bad1 --log /tmp/fs-bad.jsonl
```

Behaving:

```
Rate {"base":"EUR","quote":"USD","rate":1.09,"provenance":"live"}
```

Misbehaving — the handler returns `rate` as a string:

```
Failed_RateRequest {"input":{"base":"EUR","quote":"USD"},
                    "reason":"Rate: rate should be number, got string."}
Rate               {"base":"EUR","quote":"USD","rate":1,"provenance":"fallback"}
```

Both runs exit **zero**. The second one did not fail; it took the other route,
and said so in the output.

## What each piece is here to show

**A host handler is not trusted.** `fetchRate` declares `effect: http` and the
host performs it. Its result is asserted against `Rate` *at runtime*, before it
can reach the log. This is not belt-and-braces: a drafted implementation's
output is guaranteed by the acceptance gate, and an effect handler never passes
through the gate, so runtime is where the equivalent check has to live.
Ordinary nodes are checked earlier; effects can only be checked later.

**A failure is an edge, not an exception.** Nothing in `effects.ts` throws, and
nothing anywhere catches. The assertion failed, so the invocation produced
`Failed_RateRequest` — a real edge instance, in the log, citing the request
that caused it. `useFallback` declares `input: Failed_RateRequest` like any
other input. Lineage, joins, replay and `weir graph` all apply to it with no
second mechanism.

The name is worth pinning down because the docs elsewhere write the concept as
`Failed<In>`: the synthesized edge is named after the **input** edge it
carries, so a node taking `RateRequest` has `Failed_RateRequest`, and that is
the name you wire.

**Recovery is visible in the topology.** `weir graph` shows the fallback arc.
A reader can see that this program has a degraded path without reading a body,
and `weir sys` can tell you the failure edge is routed rather than dropped —
in most programs most `Failed_*` edges are unrouted, which `sys` reports.

**The answer says how it was obtained.** `Rate.provenance` is an
`enumValues: [live, fallback]` field, so a consumer can branch on a degraded
answer. The fallback's rate is deliberately a bad number: the value is not
trustworthy and the edge says so in a field, rather than in a comment nothing
downstream can read.

Note the syntax, since no other example has one: `enumValues` is a **sibling**
of `type`, not a member of `validations`.

## What this example does not do

- **It does not retry.** `useFallback` answers instead of re-attempting. A
  retry node is the same shape — consume `Failed_RateRequest`, emit
  `RateRequest` — and would make the topology a cycle, which weir runs to
  quiescence rather than bounding in the language.
- **It does not show a failing *input*.** Only a failing result. Both produce
  `Failed_X` by the same path.
- **It does not exercise undeclared fields.** A handler returning a field `Rate`
  never declared is currently accepted and lands in the log, which is a real
  hole rather than a feature — see
  [drift and fork](../../docs/superpowers/specs/2026-09-29-drift-and-fork.md).
