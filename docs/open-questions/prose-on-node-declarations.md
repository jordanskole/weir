# Prose blocks on node declarations

Status: open.
Last grounded: 2026-09-29 — `SealedContract.description` exists and is optional
and unchecked; nothing else has changed.

## The question

A plain-language description alongside a node's typed contract — directly useful
as the tool-calling "description" field once nodes are exposed as agent tools.

Not decided: whether it is required, optional, machine-checked against
behaviour, or purely documentation.

## Instances to check any answer against

- A sibling project's `prediction_prompt` field — a concrete instance of this
  content, which does not settle the mechanism but gives it something real.
- `contract.ts`'s `SealedContract.description` — a second real instance, still
  optional and not machine-checked. One more data point, not a resolution.

## Newly relevant

The pressure test found `exportContract` ships each edge's **full**
`description` to every drafting agent, and one edge's ran to 1,578 characters of
argued prose. So this question now has a cost attached that it did not when it
was raised: prose on a declaration is not free once the declaration is a payload.
See [sealed contract length](sealed-contract-length.md).
