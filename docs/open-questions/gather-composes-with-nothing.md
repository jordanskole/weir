# A gather composes with nothing

Status: open.
Last grounded: 2026-09-29 — `InputSpec` is still `single | allOf | gather`, with
no mixed-multiplicity form.

## The question

`gather: X` takes N of one edge and nothing else, so a node cannot join a
gathered collection *with* a scalar edge in one firing.

Concretely, in `examples/soc-triage`: `summarizeAlert` sees every `Assessment`
but cannot see the `Alert` those assessments are about, so `AlertAssessment`
carries entity ids and counts and **no alert id** — it says what it can see
rather than what a real SOC summary would want.

The shape it wants is:

```yaml
input:
  allOf:
    - gather: Assessment
    - Alert
```

which no `InputSpec` expresses. `allOf` takes a list of edges at single
multiplicity; mixing multiplicities inside it is a new thing, not a parse change.

## The workaround, and what it costs

Have the spread put whatever the gather needs into each element, so it arrives
with every member. That is duplication in the payload standing in for a missing
combinator, and it means the scalar context has to be known at spread time —
fine for an alert id, not fine for anything computed on a sibling branch.

## Why it is not obviously easy

A mixed `allOf` has two different readiness rules in one node: the scalar arms
are "has an instance arrived", the gathered arm is "has the barrier closed".
Those resolve at different times and the join would have to hold the scalar arm
open across the gather's whole window, which is the hold rule's problem in a
shape it was not designed for.
