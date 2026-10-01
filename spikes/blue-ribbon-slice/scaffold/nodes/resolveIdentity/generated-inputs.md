# What the acceptance gate will generate

`weir accept` runs your `fn` against **100 generated inputs** at seed
42, on top of the declared examples. They are not shipped here as data —
see below — but they are deterministic, so the samples are the real head of the
real sequence.

## Read this first

This field is declared as a long `utf8` string:

- `NormalizedParcel.boundaryJson` (utf8, maxLength 2,000,000)

The generator fills it with **random text**, sampling the length
uniformly up to the declared maximum. Nothing makes the content well-formed, so if
your implementation parses that field, **every generated case will throw** and the
gate will report:

```
✗ resolveIdentity was not accepted
  vacuous   no generated case produced a real output, so every property passed on nothing
```

That verdict is about the declaration, not about your code. Declining input you
cannot parse is correct. **Do not invent a plausible value to get past it** — say so
instead. See docs/open-questions/the-gate-rewards-fabrication.md.

## The first 4 inputs, verbatim

```json
// case 1
NormalizedParcel: {"provenance":"verified","vintageAsOf":"LC1QlHrN2D","vintageSourceType":"static","vintageN… (185 chars)
TownshipLookup: {"provenance":"verified","vintageAsOf":"qdlXHbk1EY","vintageSourceType":"static","vintageN… (131 chars)

// case 2
NormalizedParcel: {"provenance":"inferred","vintageAsOf":"2GmrsePQR6","vintageSourceType":"periodic","vintag… (197 chars)
TownshipLookup: {"provenance":"inferred","vintageAsOf":" J5BKvLuTs","vintageSourceType":"periodic","vintag… (136 chars)

// case 3
NormalizedParcel: {"provenance":"aggregator","vintageAsOf":"DZi9lSSoAk","vintageSourceType":"continuous","vi… (2000832 chars)
TownshipLookup: {"provenance":"aggregator","vintageAsOf":"baA38xq75r","vintageSourceType":"continuous","vi… (764 chars)

// case 4
NormalizedParcel: {"provenance":"listing claim","vintageAsOf":"VzzoL324Mc","vintageSourceType":"manual-confi… (2000853 chars)
TownshipLookup: {"provenance":"listing claim","vintageAsOf":"THizSTgIhw","vintageSourceType":"manual-confi… (779 chars)

```

Long values are truncated **for this report only** — the gate passes them in full.
Regenerate with `weir scaffold`; nothing here is hand-maintained.
