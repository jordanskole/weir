# A topology can be tested

Status: implemented.

## Motivation

`design.md` §6 orders verification risk, highest first:

> **Risk ordering, highest first: ontology, topology, examples, implementation.**

The second-riskiest artifact has the least checking of any of them.

A **node** declares examples, generated cases and properties, and an acceptance
gate runs all three before an implementation is allowed to persist. A
**composite topology** declares a contract in exactly the same vocabulary —
`input`, `output`, `terminals` — and the only thing that ever checks it is one
*static* rule: that its terminals could, in principle, produce the edges it
claims. Nothing ever runs it and compares.

So `examples/soc-triage`'s `investigate` says `Entity -> allOf[IdentityContext,
AssetContext]`, and that claim is checked by reading. Its inner nodes are each
verified to death; the composition of them is not verified at all.

This is also what is left of *a topology is a node*. The declarations are now the
same shape (2026-09-28-a-topology-declares-its-beginning.md). What a node still
has that a topology does not is a way to be **run against a stated expectation**.

## 1. This is testing, not acceptance

The obvious move — "put composites through `acceptImplementation`" — is wrong,
and the reason is worth stating because it shapes everything else.

The gate exists to decide whether a **drafted implementation** may persist. A
composite has no drafted implementation. Its body is its wiring, which is already
in the declaration a human wrote and reviewed. There is nothing to accept and
nothing to write to disk.

What a composite needs is the other half: *given implementations for its inner
nodes, does the composition do what the composite claims?* That is a check over
declarations plus already-accepted implementations — nearer `verify` than
`accept`, and it deserves its own name rather than being bent into either.

**Resolved: `weir test [dir] --impl <dir>`.** It runs every declared example in
the program: a node's through the membrane, a topology's through a run. Two paths
on purpose — a node is *invoked*, a topology is *run* — which is the one real
asymmetry left in "a topology is a node", made explicit rather than papered over.

It also gives the repo something it does not have at all: a command that runs the
examples. Today they are only reachable by accepting one candidate at a time.

## 2. A topology's example

```yaml
# declarations/investigate.topology
input: Entity
output:
  allOf:
    - IdentityContext
    - AssetContext
terminals:
  - investigateIdentity
  - investigateAsset
wiring:
  investigateIdentity: {}
  investigateAsset: {}
examples:
  - given:
      Entity: { id: "e-1", kind: "principal", value: "svc@corp" }
    expect:
      IdentityContext: { entityId: "e-1", summary: "identity:svc@corp" }
      AssetContext: { entityId: "e-1", summary: "asset:svc@corp" }
```

Tagged by edge name, and translated at elaboration into runtime shapes by
`untagExamples` — **unchanged**, because it already takes an `InputSpec` and an
`OutputSpec` and a topology now has both. That the translation needed no
extension is the first sign this is the right shape rather than a new mechanism.

## 3. Running one, and reading its answer

A composite plus the nodes it names **is** a program with one entry, which is
exactly what `entries` expresses. So running one needs no new machinery:

1. Build a `Program` from the composite's own wiring and the elaborated node
   map. Its inner nodes survive inlining under their unqualified names, so the
   wiring resolves as written.
2. `resolveTrigger` turns the example's `given` into origin payloads — the same
   function `weir run` uses.
3. `runNetlist` executes it.
4. Read the answer as **the instances of the declared output edges produced by
   declared terminals** — byte for byte the rule the end check already applies,
   because it is the same question ("did this topology produce what it claims")
   asked of one run rather than of a program.

Reusing (4) rather than reading the last instance of each edge is not tidiness:
it is what keeps a rhombus-shaped composite honest, for the reason
2026-09-28-a-root-topology-declares-its-end.md §1 gives at length.

**A failed run is a failed example, not an error.** Residue, an unmet end, or a
`Failed_*` all mean the composition did not do what it claimed — which is exactly
what a failing example reports, with the run's own diagnosis attached.

## 4. What is deliberately not in scope

**Generated cases over a topology.** A node's fuzz runs `Fn` a hundred times; a
topology's would run a hundred pulse loops, each with a log, a trace and a run
root. That is a different cost profile and a different question (what does a
*composition* do on arbitrary input, when its parts were each already fuzzed),
and bundling it here would decide it by accident.

**Properties over a topology.** Expressible with the existing grammar as long as
the input is not a collection, and genuinely valuable — *"the evidence names the
entity that went in"* is a claim about the composition, not about any one node.
Left out for the same reason: it is a decision, not a consequence.

**Accepting a composite.** There is nothing to persist (§1).

## 5. What it will find

Recorded in advance, and hedged by experience: the last time a spec here
predicted a fix would turn up wrong declarations, it turned up none, because the
examples had been maintained by hand against implementations living in test
files. That prior applies to *node* examples.

Topology examples are different in one way that matters: **none exist yet**.
Every one written for this will be new, so the first run tests the writer as much
as the wiring. The honest expectation is that failures found here are mistakes in
the new examples, and that any genuine composition bug would be a surprise worth
a design-history entry.

## Testing

Break-proofs required for each, recorded in the test's own comment with what the
break-proof showed — including breaks that do **not** redden.

1. A composite with a passing example passes. `investigate` is the case, with
   real implementations for its two inner nodes.
2. A composite whose example's `expect` disagrees with what the run produces
   **fails**, naming the edge that differed. The guard against a check that
   passes by not looking.
3. An `allOf`-output composite needs **every** declared edge to match, and a
   `oneOf`-output one is satisfied by the branch that fired — the same rules the
   end check applies, asserted here so the reuse is real rather than assumed.
4. The answer is read from **terminals**, not from the last instance of the edge:
   a composite with a rhombus-shaped inner node must not be satisfied by an
   intermediate. The rhombus case again, one level up.
5. A run that stalls or misses its end reports as a failing example with the
   run's own diagnosis, not as a thrown error.
6. `weir test` runs node examples *and* topology examples, reports both, and
   exits non-zero if any failed.
7. A node whose implementation is missing is reported as **skipped**, not passed
   — the `verify` rule, for the same reason: a check that quietly examines
   nothing is this repo's most frequent bug.

## What the build found

**`.topology` was the one declaration kind never validated against its own
schema.** `assertDeclaration` had been wired for `.field`, `.edge` and `.node`
when "make `weir check` actually check" closed that gap, and topologies were
missed — so `topologySchema()` had been editor tooling only, for as long as it
has existed. The hand-written parser catches an unrecognized *key*; only the
schema catches a malformed *value*, and `terminals: go` (a bare string where a
list belongs) elaborated cleanly until this. Now wired, which moved three tests'
error messages from the parser's to the schema's — each updated to assert **which
check fires**, rather than to whichever message happened to come out.

**Skips had to become louder than planned.** §1 said `weir test` reports what
ran; the build found that a tick over a partly-skipped run claims more than was
checked. `✓` now means *every* declared example ran and agreed, and a run with
skips exits non-zero saying "a skip is not a pass" — `verify`'s rule, applied
here. This is deliberately strict during development: an agent implementing one
node at a time reads the skip list either way, and gets a green tick exactly when
the program is finished.

**Missing implementations are tolerated per node, which §1 did not anticipate.**
`elaborateWithImplementations` throws on the first unresolvable node — right for
`run`, wrong for a command whose job includes reporting what is *not* built yet.
`weir test` resolves per node and keeps the declaration when resolution fails.
That made a `TestableProgram` type necessary: `Program.nodes` promises every node
has an `fn`, and saying otherwise in the type is what keeps the skip path from
being a cast. A topology whose wiring names an unimplemented node is skipped too,
naming which — rather than run into a confusing failure.

**The prediction in §5 held.** `investigate`'s example is the first one written,
it passed on the first run, and nothing about the composition was wrong. As
predicted, the interesting outcome would have been a surprise; there wasn't one.

## Explicitly out of scope

- **Generated cases and properties over a topology** (§4), each its own decision.
- **Accepting a composite** (§1) — nothing to persist.
- **Testing an entry topology.** `weir run` already executes one against a real
  payload; what an entry gains from an example is the same thing a composite
  gains, and nothing here prevents it, but the value is in the *reusable* unit
  and that is what this builds for.
