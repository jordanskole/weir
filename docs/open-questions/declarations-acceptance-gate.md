# Declarations acceptance gate — required sign-off, loosening undecided

Status: open (the loosening mechanism).
Last grounded: 2026-09-29 — nothing built; no `declarations/` tree exists yet.

`design-history.md` ("Acceptance gating, generalized one layer up") generalizes
the accept-before-persist mechanism from implementations to **declarations**: a
change to `.edge`/`.node`/`.topology` is not accepted until a human signs off,
independent of who drafted it. Buildable today as required review on
`declarations/**`, CODEOWNERS-shaped.

**Decided: ship it as a required gate rather than optional from the start** — a
constraint that is optional from day one never gets pressure-tested.

## Not designed

The loosening mechanism itself:

- Who may be the accepting reviewer once a project has earned enough trust to
  relax it.
- Whether that is a `.node`-file-shaped permission (§7's PDP shape) or a
  repo-level setting entirely outside weir's own contract.
- Whether the gate applies uniformly to all of `declarations/`, or
  per-file, per-directory, or per-edge.
