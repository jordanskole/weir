# manuscript-review scaffold: implementation and `weir accept` notes

Handoff notes for the weir agent. Covers what was implemented, the exact gate
invocation, the outcome, and the one thing that broke on the way.

## Outcome

All 6 nodes pass `weir accept` (2026-10-01). `npm test` in the scaffold also
passes (6 files, 6 tests). No node was reported `vacuous`.

| node | gate | note |
|---|---|---|
| `submit` | accepted | first run failed to load; fixed (see below) |
| `revise` | accepted | first run failed to load; fixed (see below) |
| `checkStyle` | accepted | first run |
| `checkFacts` | accepted | first run |
| `confirmCitations` | accepted | first run |
| `verdict` | accepted | first run |

Only `nodes/<node>/<node>.ts` was edited. Nothing is committed.

## What each node does

- `submit`: `Draft -> Revision`. id `<id>-r1`, same text, round 1.
- `revise`: `Revision -> oneOf [Accepted, Revision]`. Rounds below 3 return the next
  `Revision` (`m-1-r1` -> `m-1-r2`, text + ` (revised)`). Round 3 and above returns
  `Accepted { id: <revision id>, rounds: <round> }`. Rounds 4-10 also accept, because
  the schema allows them and the examples only pin round 3.
- `checkStyle`: `style ok at round N`, `revision_id` from `id`.
- `checkFacts`: `claim at round N`, and carries `round` through as its own field.
- `confirmCitations`: `facts ok at round N`, reading `FactFinding.round` (no parsing
  the round out of the claim prose; `FactFinding.edge` has a comment on why).
- `verdict`: `<style.note> | <fact.note>` for the shared `revision_id`. **Throws if
  the two reports name different revisions.** The gate's generated bags mostly
  mismatch, so most generated cases decline; the matching ones are what keep it
  from being `vacuous`.

Overflow is declined, not truncated. `submit` and `revise` throw when the grown id
(max 100) or text (max 2000) would exceed its bound, since the output schema would
reject it and the gate counts an out-of-schema output as a failure but a throw as a
legitimate decline.

## How to run the gate

The CLI lives in `spikes/ts-prototype`. From there:

```
npx tsx bin/weir.ts accept <node> <decl-dir> --source <file> --impl <out-dir>
```

- `<decl-dir>` = `examples/manuscript-review` (the directory holding `src/`
  with the `.node`, `.edge` and `.topology` files, not the scaffold).
- `--source` = `examples/manuscript-review/scaffold/nodes/<node>/<node>.ts`
- `--impl` = where an accepted candidate is persisted
  (`<out-dir>/<node>/<contract-hash>.ts` + `.meta.json`). I pointed it at a scratch
  directory so the repo stayed clean. A rejected candidate writes nothing.

Loop used:

```
S=/Users/jordan/code/weir/examples/manuscript-review
for n in submit revise checkStyle checkFacts confirmCitations verdict; do
  npx tsx bin/weir.ts accept $n $S --source $S/scaffold/nodes/$n/$n.ts --impl <out-dir>
done
```

The scaffold's own README doesn't mention `weir accept`'s flags. The usage text is
in `spikes/ts-prototype/src/cli.ts` and the loader is `src/accept.ts`.

## The one failure, and the fix

First run: `submit` and `revise` reported

```
✗ submit did not load
  Cannot find module './schema.js'
```

**Cause:** `acceptImplementation` copies the candidate into a fresh draft
directory (`<impl>/.drafts-XXXX/<hash>.ts`, to dodge dynamic-`import()` URL
caching) as a single file. My first versions did a runtime import,
`import { submitOutput } from "./schema.js"`, to `.parse()` the result, and that
sibling file isn't in the draft directory.

**Fix:** make the candidate self-contained. Bounds (`MAX_ID = 100`,
`MAX_TEXT = 2000`) are inlined as constants with explicit length checks that throw.
`import type { ... } from "./schema.js"` is still fine, because the type import is
erased before load.

## Things worth carrying forward

- **A node file must be loadable alone.** No runtime imports of `./schema.js`,
  `../../schemas/*`, or anything else relative. The scaffold's vitest run does *not*
  catch this, because it loads the file in place. Only the gate does. Worth either
  making the scaffold template say so, or having the gate draft directory carry
  the sibling files.
- **Inlined bounds can drift** from `Revision.edge`. If those bounds change, `submit`
  and `revise` need updating by hand.
- `tsc --noEmit` in the scaffold fails with `Cannot find module 'node:util'` in the
  six generated `check.ts` files: `@types/node` is missing from the scaffold
  `package.json` `devDependencies`. Generator-side fix. Not touched here.
