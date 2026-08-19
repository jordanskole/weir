# Open questions

Things raised in the design conversation that were not resolved — as opposed to items in [getting-started.md](getting-started.md#deferred-on-purpose-dont-build-yet), which are resolved in design but deliberately postponed in implementation order.

- **Aggregators and accumulators.** A node like `count` or a running sum doesn't fit the pure `edge → edge` shape cleanly — it has to hold state across invocations, which is exactly what the envelope/log model was designed to avoid pushing into the node itself. Where does that state live: in the node (breaks purity), in the envelope (breaks context-free `Fn`s), or as a fold read from the log at call time (possibly expensive, but consistent with "state is a fold over the log")?

- **Sleep / wait.** Is a delay a property of an edge (e.g. a `DelayedOrder` that resolves later), a special node type, or a runtime concern outside the node model entirely? Ties into the "nothing polls, only origin nodes introduce nondeterminism" rule — a wait is a kind of origin.

- **Is a cron itself a node (`n0`)?** If origin nodes are the only entry point for nondeterminism, a cron scheduler is presumably one of them — but it's not clear whether it's a node with zero input edges, or something outside the node/edge vocabulary entirely that merely *triggers* origin nodes.

- **Prose blocks on node declarations.** Floated as a plain-language description alongside a node's typed contract — directly useful as the tool-calling "description" field once nodes are exposed as agent tools (see design-history.md's note that nodes-are-tools, edges-are-schemas mapping). Not decided: whether this is required, optional, machine-checked against behavior, or purely documentation.

- **Join keying.** Flagged early as answerable later "without breaking what exists" — how do two edges get correlated/joined at a node with multiple inputs? Not picked up again in the conversation.

- **Serialization format for the netlist/log.** JSON was used for illustration throughout, but never chosen deliberately. Matters more than it looks: whatever format is picked has to carry schema hashes, envelope fields, and (per design-history.md) a strict boundary where no type variable ever appears in an emitted netlist.

- **Which host language elaborates.** TypeScript, OCaml, a DSL, and Rust macros were all named as candidates early on (23:38) with no follow-up decision. The getting-started plan assumes *something* exists to write the elaborator in, but doesn't commit.

- **Where do client/server and PII-obfuscation-at-the-client map onto nodes and edges?** Raised directly as unresolved — existing prior art (an earlier project's design that labels fields as PII and obfuscates client-side) doesn't have an obvious node/edge mapping yet. Possibly resolves as an "upstream" node, but that was a guess, not a decision.
