# Where do client/server and PII obfuscation map onto nodes and edges?

Status: open.
Last grounded: 2026-09-29 — zones now exist, which changes what this can borrow.

Originally raised with no obvious node/edge mapping. A later pass split "client"
into three physically distinct targets that all execute the same compiled node
artifact: **in-browser** (JS/WASM), **locally installed** (a CLI or plugin), and
**deployed** (a sandbox or self-hosted).

## The correction that matters

An initial framing — that the locally-installed case "needs zero isolation,
since the user is running their own code" — was wrong and was corrected on the
spot. The user only authors the **declaration**; `Fn`'s body is a black box even
to the person installing it.

So the thing being defended against is the same in every zone — the black-box
`Fn` — and what differs per zone is only whose machine sits on the other side:
other tenants (deployed), the installing user's own machine (local), or the
user's machine plus other page scripts (browser).

That means local install does not get isolation *for free* the way npm-style
"trust what you installed" does — it gets it **cheaply**, because "effects are
data" already means a node needs no host capabilities to satisfy its contract,
so denying fs and network to a sandboxed `Fn` costs zero legitimate
functionality. Unlike a real npm postinstall script, where sandboxing routinely
breaks intended behaviour.

It also argues JS-level isolation is insufficient across all three zones: if
nodes compile to native binaries, a V8 isolate cannot sandbox that artifact at
all — only OS or VM-level isolation can. Browser stays the one genuine
exception, since there is no native-code path there.

## Not decided

Whether PII-obfuscation-at-the-client is specific to the **browser** zone — the
only one combining "code runs somewhere the platform doesn't control at all"
with "the user is a passive page visitor, not someone who chose to install
anything" — or applies uniformly. Still a candidate "upstream" node, still a
guess rather than a decision.

Now checkable against a real mechanism: [zones](zones.md) shipped, so the
question of whether a deployment target is just another zone has something
concrete to be tested against.
