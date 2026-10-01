# The acceptance gate rewards fabrication and rejects refusal

Status: open.
Last grounded: 2026-10-01 — reproduced on `parcelCentroid` with two
implementations differing by one line.

## The observation

Two candidates, identical but for how they answer an input they cannot parse:

```ts
  } catch (e) { lng = 0; lat = 0; }                             // ✓ accepted
  } catch (e) { throw new Error("unparseable boundaryJson"); }  // ✗ vacuous
```

Both reproduce every declared example. The gate accepts the first and rejects the
second with *"vacuous — no generated case produced a real output, so every
property passed on nothing"*.

The accepted implementation puts `{lng: 0, lat: 0}` in the durable log for every
parcel whose boundary fails to parse. The rejected one declines to invent a
location. The gate is selecting for willingness to fabricate.

## Why it happens

`vacuous` is an honest verdict about what it saw: nothing was exercised, so
nothing was proved, so a pass would be a false green. That reasoning is right and
should not be weakened.

The problem is that **no honest implementation can clear it** for this node.
`boundaryJson` is declared `utf8`, so `generateInputCases` produces character
noise, and declining is the only correct response to character noise. Refusal is
correct behaviour that the gate can only score as failure.

Three of the blue-ribbon slice's four pure nodes hit this
([what an isolated agent found](../superpowers/specs/2026-10-01-what-an-isolated-agent-found.md)), all for
the same reason: a field the generator cannot produce.

## What it is not

Not an argument for accepting vacuous runs. A gate that passed a candidate no
input ever reached would be the false green this project keeps finding.

Not an argument for a `try/catch` ban either — a node genuinely should decline
input it cannot handle, and `throw` is how weir says that.

## Candidate directions, none settled

- **Make the input generable**, so refusal stops being the only correct answer.
  This is the opaque-type question again, and it is the direction the measured
  evidence points: structure the geometry and the generator produces parseable
  geometry. It fixes the cause rather than the verdict.
- **Let a declaration seed the generator** for a field it cannot synthesize —
  draw from the node's own examples, or a declared sample set. Cheap, and it
  makes `vacuous` reachable-but-rare instead of structural.
- **Count a decline as an observation.** A candidate that declines *every*
  generated case is vacuous; one that declines the noise and handles a seeded
  case is not. Depends on the previous item to have anything to handle.
- **Declare the expected decline rate.** Probably wrong — it invites a number
  nobody can justify, and a candidate could satisfy it by declining
  arbitrarily.

## Why it is load-bearing

The gate is the mechanism weir uses to admit code written by an agent it does not
trust. If the gate's incentive is "return something plausible rather than
nothing", it selects for exactly the failure mode the whole acceptance design
exists to prevent — and it does so silently, because a fabricating candidate
produces a clean `✓`.

Related: [configuration versus ontology](configuration-versus-ontology.md) is the
same gap for a different kind of unconstrained value — see that question's
endpoint-URL instance.
