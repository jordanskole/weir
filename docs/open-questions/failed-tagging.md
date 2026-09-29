# Should `Failed<In>` be tagged like `oneOf`'s other branches?

Status: open.
Last grounded: 2026-09-29 — still a bare `{ input, reason }` object.

The membrane resolves a rejected assert or an uncaught `Fn` throw to
`Failed<In>` as a bare `{ input, reason? }` object unioned into the return type,
**not** wrapped in the `{edge, payload}` tag that `oneOf`/`allOf` branches carry.
§3's "every node's real output signature is `one of {successes, Failed}`" does not
specify the wire format precisely enough to settle it.

**Live consequence, not theoretical:** a caller cannot distinguish a genuine
`single`-output success payload that happens to have a field named `input` from a
real `Failed<In>` by shape alone. There is no discriminant.

Revisit when a real `.edge` collides on that field name, or when the runtime needs
to route a `Failed<In>` branch the same mechanical way a `oneOf` tag is routed.

**Now partly exercised:** `examples/flaky-source` routes `Failed_RateRequest`
into a recovery node, so the routing half has a first real user. It does not
force the tagging question, because the node declares the failure edge by name
rather than discriminating on shape.
