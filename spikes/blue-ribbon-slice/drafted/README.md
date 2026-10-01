# Drafted implementations, and why they are kept

These four `fn`s were written on 2026-10-01 by an agent that had never heard of
weir. It was given each node's sealed contract (`weir contract <node>`), the
`weir accept` command, and an explicit prohibition on reading anything else in
this repository — no declarations, no weir source, no docs. `REPORT.md` is its
own account, unedited.

**They are evidence, not the pipeline's implementations.** Three of the four do
not pass the acceptance gate, and the one that does
(`routeCounty.ts`) passes while carrying four invented production URLs and an
invented provenance claim for three counties. Nothing here should be wired up
without review.

The findings they produced are in
[what an isolated agent found](../../../docs/superpowers/specs/2026-10-01-what-an-isolated-agent-found.md).
The short version:

| file | gate verdict | whose defect |
|---|---|---|
| `routeCounty.ts` | `✓` after a declaration fix | the property path, not the code |
| `normalizeParcel.ts` | `vacuous` | opaque `utf8` geometry defeats the generator |
| `parcelCentroid.ts` | `vacuous` | same — and this is the *honest* implementation |
| `resolveIdentity.ts` | `vacuous` | the generator violates the runtime's join invariant |

Two of these files are worth reading for a specific reason:

- **`parcelCentroid.ts`** is correct, careful geometry — and it is rejected
  because it throws on input it cannot parse, where a stub returning
  `{lng: 0, lat: 0}` is accepted. It also clamps its result into the bounding box
  to satisfy a declared property that does not check bounding boxes.
- **`routeCounty.ts`** labels every value it invented with
  `// GUESSED - not stated anywhere in the contract`. The gate does not read
  comments. Those labels are the only record that three of five counties' trust
  classifications were produced by analogy.

Kept in the repository because they were otherwise in a temporary directory, and
the spec above cites them.
