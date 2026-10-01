# routeCounty

A scaffold generated from weir declarations. **Edit `routeCounty.ts` and nothing
else** — every other file is mechanical output of the declarations, and re-running
the scaffold overwrites it.

```
npm install
npm test
```

| file | what it is |
|---|---|
| `routeCounty.ts` | **yours.** The stub throws; make it work. |
| `schema.ts` | the input and output edges as zod. Validations included. |
| `check.ts` | the 2 declared example(s) and 1 declared property, as source. |
| `routeCounty.test.ts` | runs `check()`. |
| `vitest.config.ts` | so this directory tests itself, wherever it sits. |

## Reading a failure

`check()` reports which artifact is wrong, not just that something is:

- **input-schema** — the example's own `given` does not satisfy the input schema.
  A declaration bug; your code never ran.
- **output-schema** — your result is the wrong shape.
- **value** — right shape, wrong value.
- **threw** — your function declined.
- **property** — a declared invariant did not hold, or the property itself is
  broken (an unresolvable path is the contract's defect, not yours).

## Two things worth knowing

**Read a property's body, not its name.** A property's name is unchecked prose.
`check.ts` renders each expression as source so you can see what it actually
checks.

**Declining is sometimes correct and still fails the gate.** If a field arrives as
an opaque string the generator fills with noise, the only correct response is to
throw — and the gate reports that as `vacuous`. Say so rather than returning a
plausible value you made up.
