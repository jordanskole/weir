# Serialization format for the netlist and log

Status: open. **Load-bearing for a second implementation.**
Last grounded: 2026-09-29 — the log and trace are `.jsonl`; nothing chose it.

JSON was used for illustration throughout and never chosen deliberately.

It matters more than it looks: whatever format is picked has to carry schema
hashes, envelope fields, and a strict boundary where **no type variable ever
appears in an emitted netlist**.

This is now the *only* thing in this directory that a second implementation
genuinely needs settled — [the host language](host-language.md) resolved to
TypeScript for v1, so the portability question narrowed to exactly this.

It has also grown a constraint since it was raised: the log is durable and
append-only, and [fork](../superpowers/specs/2026-09-29-drift-and-fork.md) adds
a cross-run reference (`forkedFrom`). A format has to express that a run
descends from another run, not only that a token descends from another token.
