# Scaffold

Generated from weir declarations. One install, one test run, 4 node(s) to
implement.

```
npm install
npm test
```

## Layout

```
schemas/            8 edge schema(s) as zod, ONE module per edge
nodes/<node>/
  <node>.ts         YOURS. The stub throws; make it work.
  schema.ts         this node's input/output, importing from schemas/
  check.ts          the declared examples and properties, as source
  generated-inputs.md   what the acceptance gate will attack it with
  <node>.test.ts    runs check()
```

**Edit only `nodes/<node>/<node>.ts`.** Everything else is mechanical output and
re-running the scaffold overwrites it.

`schemas/` holds one module per edge rather than a copy per node on purpose. An
edge is weir's unit of shared vocabulary — the complete description of what crosses
a wire — and three nodes touching `NormalizedParcel` should see one schema, not
three that can drift.

## What to implement

| file | has |
|---|---|
| `nodes/normalizeParcel/normalizeParcel.ts` | 2 example(s), 1 property |
| `nodes/parcelCentroid/parcelCentroid.ts` | 1 example(s), 1 property |
| `nodes/resolveIdentity/resolveIdentity.ts` | 1 example(s), 1 property |
| `nodes/routeCounty/routeCounty.ts` | 2 example(s), 1 property |

## Reading a failure

`check()` reports which artifact is wrong, not just that something is:

- **input-schema** — the example's own `given` does not satisfy the input schema.
  A declaration bug; your code never ran.
- **output-schema** — your result is the wrong shape, including an out-of-range
  value, since the range is in the schema rather than in a type.
- **value** — right shape, wrong value.
- **threw** — your function declined.
- **property** — a declared invariant did not hold, or the property itself is
  broken (an unresolvable path is the contract's defect, not yours).

## Two things worth knowing

**Read a property's body, not its name.** A property's name is unchecked prose.
`check.ts` renders each expression as source so you can see what it actually
checks — and in this repository at least one property has been named for a check it
did not perform.

**Declining is sometimes correct and still fails the gate.** Read each node's
`generated-inputs.md`: where a field is an opaque string, the generator fills it
with random text and the only correct response is to throw, which the gate reports
as `vacuous`. Say so rather than returning a value you made up.
