# Step zero: `Person { age: 41 } | birthday | expect Person { age: 42 }`

The hand-authored netlist [getting-started.md](../../docs/getting-started.md) asked for, for the
smallest program in the design docs. `schemaHash` values in `netlist.json` are real —
computed by `hashEdge()` (`spikes/ts-prototype/src/hash.ts`) against the edge definitions below,
not placeholders — that TS module is a spike for validating the hashing design, not a claim about
the eventual host language (see `spikes/ts-prototype/README.md`).

This is a first draft, not a ratified format. Per the getting-started plan, writing it down was
supposed to force implicit decisions into the open — here's what got decided, and where I picked
an answer without strong grounding in the docs and you should sanity-check it.

## Decisions this forced

**1. Netlist vs. trace are two different things, kept in one file for now.** `edges` + `nodes` +
`topology` is what elaboration would emit — pure structure, no data (`docs/design.md` §4). `trace`
is the log a single execution produces — envelope + payload per edge instance (§5). Real elaborator
output almost certainly shouldn't carry a trace; splitting these into separate files once there's
more than one example run is probably right.

**2. The origin's literal value is a node, not free-floating data.** `Person { age: 41 }` at the
start of the composition isn't part of any node's declared contract — it's baked into a concrete
`origin_Person_literal` node via the same monomorphization elaboration already does for generics
(`docs/design-history.md`, "Generics: elaboration monomorphizes"). Its `input` is `"Unit"`
(`docs/design.md` §5: "an origin is an ordinary node whose input is the unit edge — the only
special edge"). **Resolved** (step 2, node declarations): `Unit` is a real declared edge with no
fields, not `null` standing in for it — origins aren't a schema-level special case, every node's
input is a named edge. See `spikes/ts-prototype/src/types.ts`'s `Unit` export.

**3. `expect Person { age: 42 }` is a node closing over a literal, the same way.** `expect` isn't
generic machinery here — `expect_Person_age_42` is a concrete node, `Person -> one of {Pass, Fail}`,
with the expected value baked in via `closure`. This directly follows §6: "`expect` is an ordinary
node with `one of {Pass, Fail}`." **Not decided:** whether comparison is full-struct equality or
field-by-field over only the fields named in the literal (matters once edges have more than one
field — this example's `Person` only has `age`, so it doesn't bite yet).

**4. `closure` as the general mechanism for baked-in parameters.** Both the origin's literal and
`expect`'s expected value use the same `closure` key. Untested elsewhere — this is the one part of
the file that's more invention than transcription from the docs, since neither design.md nor
design-history.md name a serialization key for "a parameter fixed at elaboration time."

**5. Instance identity is `node-name#n`.** Per the log-replay problem in design-history.md's
"Nominal edges" section (repeated invocations of `birthday` are indistinguishable by name+payload
alone), instances need positional identity separate from the node declaration they came from. This
file uses `birthday#1` as a placeholder scheme — nothing in the docs commits to this exact format.

**6. Envelope ids are readable placeholders (`env-1`, `env-2`...), not real ids.** `docs/design.md`
§1 specifies UUIDv7/ULID. Swapped for legibility in this hand-written example; a real elaborator/
runtime should use the real scheme.

**7. `causationId` chains to the previous step's envelope id; `correlationId` is shared across the
whole run.** Matches the envelope fields in §1, but this file is the first place that actually
wires them together end to end — worth checking against how joins/fan-in are eventually meant to
use `causationId` (see "Join keying" in `docs/open-questions.md`, still unresolved).

**8. `Pass` and `Fail` are edges with no fields.** Reasonable given `expect` outputs `one of {Pass,
Fail}` and neither carries data in this example, but a real `Fail` almost certainly wants a reason/
diff field eventually — not modeled here.

**9. Wires reference instance ids, not node declaration names.** `{ "from": "origin#1", "to":
"birthday#1" }` — consistent with "topology is data, not derived from type identity"
(design-history.md, the nominal-edges reversal), but the exact wire shape
(`(from_node, output_port, to_node, input_port, schema_ref)` from the earliest "splitting edge into
schema vs. wiring" decision) isn't reproduced literally here — there's no `output_port`/`input_port`
distinction yet because every node in this example has exactly one input and one output.

## What this doesn't exercise yet

Fan-out (`one of`/`all of`/`many`), a composite node, a failure that actually terminates in a
dead-letter node, and a second edge instance of the same type at the same step (the thing that
forced positional identity in the first place, but this example only ever has one instance in
flight). Worth a second example once the netlist format settles.

## The `.field`/`.edge` authoring format (`src/fields/`, `src/edges/`)

Added once §10's "real YAML, no bespoke grammar" authoring format had something to hang it on —
`email.field`, `Person.edge`, `Address.edge`, `PersonWithAddress.edge`. These aren't illustrative
prose like `netlist.json` above — `spikes/ts-prototype/src/elaborate.ts`'s `elaborate()` actually
loads and validates this directory as part of the spike's test suite, so these files staying valid
is enforced, not just hoped for.

**10. A file's declared `name:` must match its filename.** `email.field` must declare `name:
email`; a mismatch is a load error, not a silent orphan — the filename is the only handle another
file has to reference it by.

**11. Cross-file references are a bare name string, resolved by extension.** `email: email` and
`address: Address` (in `PersonWithAddress.edge`) are both just the referenced thing's name; whether
`email` resolves against a `.field` or an `.edge` file is disambiguated by whichever extension
exists — the same "elaborator globs by extension, not folder convention" principle §10 already
established for `.node`.

**12. A field reference and a compound-edge reference use identical syntax on purpose.** Nothing in
`PersonWithAddress.edge` marks `address: Address` as different from `email: email` — the elaborator
resolves both the same way, and the difference (scalar field vs. nested edge) only shows up in what
comes back. See `docs/design-history.md`, "Compound fields embed literally — Mongo-like, not
SQL-like," for why that's the right shape rather than a foreign-key-style reference.
