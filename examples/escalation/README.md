# escalation

**What this example is for: iteration.** A cycle in the wiring that runs to quiescence, terminating
on a `oneOf` base case rather than on a loop construct.

A support ticket arrives, starts at tier 1, and is handed up a tier at a time until it reaches one
that can actually resolve it.

## The topology

```
openTicket (NewTicket -> Ticket, origin)
     |
     v
  triage (Ticket -> oneOf [Resolution, Ticket])
     |  ^
     |  |  the Ticket branch feeds straight back in
     +--+
```

```yaml
openTicket:
  then:
    triage:
      then:
        triage: {}
```

That is the whole cycle: `triage` names itself under its own `then:`. Weir has no loop construct and
needs none — a node whose output includes its own input edge, wired back to itself, *is* the
recursive form, and `oneOf` supplies the base case. `while` would need somewhere to keep a counter;
recursion does not.

## How it terminates

`triage` receives a `Ticket` and returns one of two tagged branches:

- `Ticket` at `tier + 1` — which is routed back to `triage`, so it fires again
- `Resolution` — which nothing routes anywhere, so nothing more becomes ready

The run ends at **quiescence**: a pulse in which nothing fired. Termination is a property of the
data, not of the language. With `difficulty: 3` the ticket is triaged at tiers 1, 2 and 3, and the
third tier resolves it — four firings, four pulses.

A runaway graph is bounded by the host rather than by weir: `budget` caps firings and `maxPulses`
caps pulses. Neither is a language-level loop bound.

## Why it fires more than once

A node fires **once per unconsumed instance reaching it along a declared arc**. The log retains every
instance instead of overwriting, so `triage`'s second firing consumes the tier-2 `Ticket` — a
genuinely different token from the tier-1 one it already ate, not the same edge re-read. Consumption
is tracked per node, so each node gets its own turn at every token.

That is a Petri net's transition rule: edges are places, nodes are transitions, an instance is a
token, and `wiring.feeds` is the arc set saying which tokens a transition may consume.

## What it deliberately does not show

Per-item lineage. There is one ticket here, so there is never a question of which `Ticket` belongs
with which — see `manuscript-review` for the fan-in that has to answer that.

Also worth knowing: the origin node cannot be the looping node. The runtime routes an origin to its
once-only branch before it ever considers instance candidates, so a self-feeding node needs a
separate seed node in front of it. That is why `openTicket` exists as well as `triage`.
