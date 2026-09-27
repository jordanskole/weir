# Effects are data

Status: draft.

## Motivation

`design.md` §0 lists three rules that make Principle 0 hold. Two are built. The third is not:

> effects are data, performed by the runtime and recorded

§5 specifies the mechanism exactly: *"A node emits a description (`{fetch, url}`, `{sleep, duration}`); the runtime performs it and delivers the result as another edge. Replay feeds back the recorded result rather than re-performing, which is what makes determinism hold."*

None of it exists. The only occurrences of "effect" under `src/` are comments written while building `verify`.

**`weir verify` is what makes this urgent rather than merely incomplete.** It now detects a node that reads a clock or samples without declaring it — correctly — while the sanctioned alternative it implicitly points at is unbuilt. A node that genuinely needs the outside world has two options today: violate Principle 0, or do without. That is a check shipped without its counterpart.

It is also what the probabilistic analysis (open-questions.md, "The version pin pins the contract") already assumes throughout: sampling above temperature zero, a hosted model that moves, an unseeded fit are each *"emit a description, the runtime performs it, record the answer"*. Those conclusions rest on a mechanism that does not exist yet.

## 1. An effect is a node the runtime implements

The fork worth naming before resolving it: an effect could be a distinct *return shape* from an ordinary node — a sibling of `Failed<In>`, where `Fn` returns `{effect, …}` and the runtime intercepts it. That keeps effects invisible in the topology.

**Resolved: an effect is an ordinary node whose implementation is supplied by the host rather than drafted.**

```yaml
# declarations/fetchUser.node
label: Fetch User
description: Retrieves a user record over HTTP
effect: http
input: UserRequest
output: UserResponse
```

A `.node` declaring `effect:` resolves to a host-registered handler instead of to `{node}/{contractHash}.ts`. Everything else about it is unchanged: it is wired in a `.topology` like any node, its input is asserted at the membrane like any node, its output is logged as an edge instance with an envelope like any node, and lineage threads through it because the result cites the request.

Three reasons this beats the interception design:

- **The topology stays honest.** Where the outside world is touched is visible in the wiring, which is exactly the property Principle 0 is about. An intercepted return makes effects invisible at the only place someone reads the shape of a program.
- **Nothing new is needed downstream.** The effect's result is an edge instance, so arcs, `allOf` joins, lineage, spread and composites all apply without a second mechanism.
- **It reuses a category that exists.** `noop` and the run root are already framework-supplied rather than drafted (open-questions.md, "System nodes"). An effect is the same shape with the opposite property: a system node is one whose contract determines its behaviour, an effect is one whose contract determines *who performs* it. Both skip the acceptance gate because there is nothing to accept.

## 2. The handler

The host supplies handlers alongside the log and trace:

```ts
runNetlist(program, run, { log, trace, effects: { http: async (payload) => … } })
```

An effect node named in `effect:` resolves to `effects[name]`. Missing handler is a **hard failure at run start**, not at fire time: a program whose effects cannot be performed should not begin, and discovering it three pulses in leaves a half-written log. `elaborate` cannot check this — handlers are a runtime concern — so `runNetlist` checks the program's declared effects against the supplied map before pulse 1.

**The handler's result is asserted against the declared output edge**, exactly as a drafted implementation's is. A handler is host code and no more trusted than `Fn`; an effect that returns the wrong shape must produce `Failed<In>`, not a malformed instance in the log.

**Effect failure needs no new machinery.** A fetch that 404s is not an exception, it is an outcome: the handler returns a `oneOf[Response, HttpError]` and the topology routes both, which is §3's "failure is an edge" applied unchanged.

## 3. Replay feeds back, never re-performs

This is the property the whole feature exists for, and the one place the runtime must behave differently.

`replayInvocation` resolves an implementation and re-runs it. For an effect node there is no implementation to resolve and re-performing would defeat the point — a replay that re-fetches is not a replay. **Replay reads the recorded result from the trace entry and returns it**, performing nothing.

That makes an effect node's replay trivially equal to its record, which has a consequence for `verify` that must be handled rather than discovered.

## 4. `verify` must not check effect nodes — and must say so

Comparing an effect node's replay to its record is **vacuous by construction**: replay returns the record, so they always agree. Counting that as a passing check would be exactly the false-green pattern this repo has shipped five times, this time built into the feature.

**Effect nodes are reported as a third category** — not `checked`, not `skipped`, but *"nondeterminism enters here by declaration"*. That is the honest statement: the node is where the outside world gets in, it is supposed to be nondeterministic, and its determinism is not in question because it was never claimed.

A run consisting entirely of effect nodes must therefore report `0 checked`, not `✓ all passed`. `VerifyReport.checked` already exists as that guard and gains a sibling count.

## 5. What this buys, stated plainly

A node that needs a clock stops having to cheat. `now: TimeRequest → Timestamp` declared `effect: clock` is performed once, recorded, and fed back on every replay — so the node consuming the `Timestamp` is pure, verifiable, and replays identically forever. The nondeterminism has a boundary and a record, which is Principle 0's whole claim: *it records nondeterminism where it enters, and after that its reach is zero*.

## Testing

Break-proofs required for each. `tsconfig.json` excludes `src/**/*.test.ts`, so test files are never typechecked.

1. A `.node` declaring `effect:` elaborates, and resolution does **not** look for an implementation file.
2. `runNetlist` refuses to start when a declared effect has no handler, naming it — before any node fires and before anything is written.
3. An effect node fires, its handler's result is logged as an edge instance with an envelope, and a downstream node consumes it on a declared arc.
4. The result's `causationIds` name the request instance, so lineage threads through an effect rather than restarting at it.
5. A handler returning the wrong shape produces `Failed<In>`, not a malformed instance.
6. **Replay of an effect node returns the recorded result and does not call the handler.** Assert the handler was not invoked, not merely that the value matched — a handler that happens to return the same thing would pass otherwise.
7. `verify` reports an effect node as declared-nondeterministic, and a run of only effect nodes reports `0 checked` rather than a clean pass.
8. A node consuming an effect's result verifies as deterministic — the case the whole design is for.

## Explicitly out of scope

- **Retries, timeouts, backoff, cancellation.** All are policy over a mechanism that does not exist yet.
- **Concurrency.** Effects fire in the pulse loop like everything else, sequentially (`runtime.ts:539`). Parallelism is a separate change with a known hazard.
- **Sandboxing.** Preventing a node from reaching the world without declaring an effect is the membrane bounding *control* rather than *behaviour* — its own open question, and unchanged by this.
- **Effect results outliving a run.** A cached fetch shared across correlations is a different feature; nothing joins across correlations by design.
- **The version pin**, which remains contract-shaped and remains `verify`'s other confound.
