# What the acceptance gate will generate

`weir accept` runs your `fn` against **100 generated inputs** at seed
42, on top of the declared examples. They are not shipped here as data —
see below — but they are deterministic, so the samples are the real head of the
real sequence.

## Read this first

This field is declared as a long `utf8` string:

- `RawParcelFeature.featureJson` (utf8, maxLength 2,000,000)

The generator fills it with **random text**, sampling the length
uniformly up to the declared maximum. Nothing makes the content well-formed, so if
your implementation parses that field, **every generated case will throw** and the
gate will report:

```
✗ normalizeParcel was not accepted
  vacuous   no generated case produced a real output, so every property passed on nothing
```

That verdict is about the declaration, not about your code. Declining input you
cannot parse is correct. **Do not invent a plausible value to get past it** — say so
instead. See docs/open-questions/the-gate-rewards-fabrication.md.

## The first 4 inputs, verbatim

```json
// case 1
county: "LC1Q"
sourceTrust: "verified"
featureJson: "lH"

// case 2
county: "rN2Dp"
sourceTrust: "aggregator"
featureJson: "3Ut"

// case 3
county: "mFRMaD0dLbqdlXHbk1E"
sourceTrust: "verified"
featureJson: "YuCcdJLpOntU2GmrsePQR6f7B7igawEM4eT6rSlGZh J5BKvLuTsC1R 4BIsgRtX5fDZi9lSSoAkPvnN3uXyi2xaU… (2000001 chars)

// case 4
county: "2qp2OSr30w3cnZZnnKs0"
sourceTrust: "aggregator"
featureJson: "ZdO9V5 UXBACOoA4AX3n2Vw kjov109SQeLq8dEb1yRtf29WxjxfA0KYoJUJrB1LBuWO 2U0VIeNKn4nqXW0f7w6R… (2000002 chars)

```

Long values are truncated **for this report only** — the gate passes them in full.
Regenerate with `weir scaffold`; nothing here is hand-maintained.
