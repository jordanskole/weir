# Zones: a line in the topology, not a per-node annotation

Status: resolved (2026-09-28, built).
Last grounded: 2026-09-29.

`design.md` §7 says *"zones annotate where a node runs"*, which implies a field
on every `.node`. The placement taken instead: **a `.topology` declares its
zone**, and every node it wires runs there. A topology is already the declared
boundary, so placement is one more key on the file that says where the unit
begins and ends, rather than a field repeated across every node inside it.

Built as [zones are a line in the topology](../superpowers/specs/2026-09-28-zones-are-a-line-in-the-topology.md).
A node's zone is derivable after inlining because the qualified key records which
topology it came from, so the planner's crossing annotation is a lookup rather
than a new mechanism. And the unit of placement is the unit of *review*.

The corroboration arrived from outside rather than from reasoning about the
examples: two of the sibling project's county adapters route through a
commercial proxy behind an interface **identical** to the direct ones. Nothing
in the types distinguishes them, so a zone genuinely cannot be inferred from the
data or the contract — it has to be declared by somebody who knows where the
code runs.

## What it did not decide

- Whether a node may override its topology's zone.
- What a zone *is* beyond a name — client/server/third-party/log are examples,
  not a closed set, and nothing validates against a vocabulary.
- Zone *paths*. The pressure test wanted `county-gis/osceola`, because
  "county-gis" flattens five separate county governments into one boundary.

Field-level classification, the other half of §7, shipped separately and has
since been found to have a hole of its own — see
[serialization erases classification](serialization-erases-classification.md).
