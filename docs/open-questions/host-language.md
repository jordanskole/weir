# Which host language elaborates

Status: resolved (2026-09-28 — TypeScript for v1).
Last grounded: 2026-09-29.

Named early alongside OCaml, a DSL and Rust macros, and left leaning toward
OCaml with no follow-up — while a TS "spike" (`spikes/ts-prototype/`) grew to
8.5k lines of implementation, 14.7k of tests, eight CLI commands and a suite
over every example.

**The decision was being made by default every day it continued.** It is now
made on purpose, and the cost of not deciding was that every feature quietly
raised the price of a rewrite nobody had committed to.

**OCaml comes after v1, not instead of it.** What that costs, recorded rather
than discovered later: the identity-function inference trick the declarations
rely on (`defineField`/`defineEdge`) is TS-specific and will not carry over, so
a second implementation re-derives that part rather than porting it. What it
buys is that the design will have been pressure-tested by a real v1 first.

Still genuinely open and load-bearing for a second implementation in a way the
host language no longer is: [the serialization format](serialization-format.md).
