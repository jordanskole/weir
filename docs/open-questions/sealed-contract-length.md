# Is the sealed contract's length a cost nobody is accounting for?

Status: open.
Last grounded: 2026-10-01 — measured across four contracts actually handed to an
isolated drafting agent. The cost is real and the framing below was wrong about
what kind of cost it is.

The pressure-test's edge files carry long argued prose — one edge's description
alone runs to **1,578 characters**. That prose is *good*, and descriptions are
where it belongs rather than in `#` comments the YAML parser discards.

But it ships verbatim to every isolated agent drafting an implementation against
that contract, on every draft, and nothing budgets for it.

Undecided whether that wants a length cap, a `description` versus `brief` split,
or nothing at all — the contract being complete is the point, and truncating it
to save tokens would be trading the feature for the cost of the feature.

Related: [prose on node declarations](prose-on-node-declarations.md) asks whether
prose should be *required*. If it ever is, this question becomes load-bearing
rather than incidental.

## 2026-10-01: the problem is audience, not length

Four contracts were handed to an agent that had never heard of weir, to draft
implementations from ([what an isolated agent found](../superpowers/specs/2026-10-01-what-an-isolated-agent-found.md)).
Measuring what it received, by bytes of `description`:

| node | prose | share addressed to weir rather than to an implementer |
|---|---|---|
| `routeCounty` | 5,974B | 77% |
| `normalizeParcel` | 16,504B | 89% |
| `parcelCentroid` | 6,780B | 53% |
| `resolveIdentity` | 16,339B | 53% |

`normalizeParcel`'s input description opens with `CORRECTED 2026-09-29. THE
ARGUMENT BELOW IS WRONG. READ THIS FIRST`, argues about `runtime.ts`, cites spec
paths, and deliberately preserves a superseded argument as the record. All of
that is worth keeping. None of it is addressed to the stranger being asked to
implement the node, and it is 89% of what that stranger reads.

**This resolves the menu above toward the `description`/`brief` split and against
the length cap.** Truncating would delete the record to save tokens — the trade
this question already refused. Splitting costs nothing, because the two bodies of
text have two different readers: one reviewing the ontology, one drafting against
the contract. A declaration field acquires that second reader the moment the
declaration becomes a payload, and nothing currently marks which reader a field
was written for.

Still undecided: whether the split is two fields, or one field with the sealed
contract carrying only a declared summary; and whether `brief` being absent should
fall back to `description` (convenient, and reintroduces the problem silently) or
be required once any prose exists (noisy, honest).

**A separate and much cheaper finding from the same measurement.**
`contract.ts:127` builds `failure: { input: contractInputSpec(node.input) }`,
recomputing the structure already present at `input:` six lines earlier. It is
byte-identical in all four contracts and costs 11%, 28%, 30% and 27% of each
payload for no information. `hashNode` fingerprints the `NodeDef`, not the
`SealedContract`, so removing it moves no contract hash and needs no migration.
Not done, because `SealedContract` is a public shape and "every field is readable
without cross-referencing another field" is a defensible reason to keep it — but
if this question's split happens, this should go at the same time.
