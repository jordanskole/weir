# YAML examples are tagged, TypeScript examples are bare, and the gate only knew the bare form

Status: resolved (2026-09-28).
Last grounded: 2026-09-29.

## The question

In YAML, `given` is tagged by edge name for every input kind
(`given: { Alert: {...} }`). In TypeScript, `given` is `InputPayload<In>` — the
*bare* payload for a `single` input. Nothing untagged between them, so an
elaborated `.node`'s examples would fail their own acceptance gate on shape.

Nobody noticed because `acceptImplementation` had only ever been called with
hand-constructed `NodeDef`s in tests. **Every example in `examples/` was
validated for shape by the schema and never actually run.**

The same claim-vs-enforcement gap as "`weir check` reported ✓ on `descriptoin:`",
one level further in: the examples are the acceptance gate's whole content, and
this repo's corpus of them had never been through it.

## What resolved it

[Examples reach the gate](../superpowers/specs/2026-09-28-examples-reach-the-gate.md).
The elaborator untags on the way in. All 30 declared examples across 26 nodes
pass, `weir accept` makes the gate reachable at all, and a corpus test asserts
every declared example is well-formed against its own contract.

Confirmed a live defect rather than a missing feature by running it first: a
*correct* implementation of `examples/recipe`'s `mix` was **rejected**, because
`{Recipe: {…}}` was asserted against the `Recipe` schema and resolved to
`Failed<In>`.

The translation is asymmetric in a way worth knowing: an `allOf` **input** bag
is already keyed by edge name so nothing is stripped, while an `allOf` **output**
becomes a list of `{edge, payload}` and a `oneOf` output *gains* structure. No
contract hash moves, because examples are not fingerprinted.
