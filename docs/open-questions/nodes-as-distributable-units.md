# Nodes as compiled, distributable units

Status: open — a bundle, flagged by the raiser as not fully thought through.
Last grounded: 2026-09-29.

Raised as "every node compiles to its own binary", motivated by portability and
distributed compute. Several distinct directions got bundled under one sentence
and deserve separating rather than designing together.

**Sandboxed eval of user-authored node source.** A different execution model
from ahead-of-time compilation — interpret at invoke time versus compile once —
with its own determinism and security tradeoffs. One real affinity: "effects are
data" already means a node body needs **no host capabilities**, which is exactly
what makes safe sandboxing tractable. Most code is hard to sandbox because it
needs a laundry list of permissions; weir nodes structurally do not. Checked
rather than speculated: Deno's actual sandbox product wraps each tenant in its
own Firecracker microVM rather than a bare V8 isolate — evidence that
isolate-only multi-tenancy was insufficient once running arbitrary code with
native bindings.

**RTOS and embedded targets.** Not merely a deployment detail: it presses on the
host-language question. A GC'd runtime is often a poor fit for a
memory-constrained target, suggesting implementation-per-target behind one
contract, which multiplies versioning by platform as well as by contract hash.

**Kubernetes and micro-VMs.** Tractable once nodes are independently invocable
at all — same content-addressed artifact, different place it runs. Collapses
into one mechanism with the sandboxing bullet rather than competing with it.

**A package system.** Largely free from content-addressed `<contract-hash>.ts`
artifacts plus a registry layer. Not a new mechanism.

**Monolith versus distributed as a deployment axis, not a design-time
commitment.** Because a node's contract is total, the same topology should run
in-process or distributed without the design picking one. **Zones may already be
the right mechanism** — "annotate where a node runs, topology unchanged,
cross-zone edges are the network hops" is already the shape of "which node runs
on which target". Extending zones' vocabulary (an `embedded` zone, a `cluster`
zone) rather than inventing a parallel deployment-target concept would keep one
mechanism doing both jobs. Zones are now built, so this is checkable.

**Composition syntax as a literal execution strategy.** `birthday | birthday`
reads like a Unix pipe, and a pipe is a decades-proven implementation of that
semantic. If primitives compile to binaries, a linear chain could literally be
one. It does not resolve fan-out/fan-in — plain pipes are one-in-one-out, and
`oneOf`/`allOf`/`many` need something closer to `tee` or named pipes. Multi-input
resolved how a node *reads* several logs at once; this bullet is about how a node
*emits* to several consumers, which is untouched.
