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
✗ parcelCentroid was not accepted
  vacuous   no generated case produced a real output, so every property passed on nothing
```

That verdict is about the declaration, not about your code. Declining input you
cannot parse is correct. **Do not invent a plausible value to get past it** — say so
instead. See docs/open-questions/the-gate-rewards-fabrication.md.

## The first 4 inputs, verbatim

```json
// case 1
provenance: "verified"
vintageAsOf: "LC1QlHrN2D"
vintageSourceType: "static"
vintageNote: ""
pin: "p3UtmFRM"
county: "aD0d"
townshipFromSource: ""
acres: 0
boundaryJson: "Lb"

// case 2
provenance: "inferred"
vintageAsOf: "dlXHbk1EYu"
vintageSourceType: "periodic"
vintageNote: "C"
pin: "cdJLpOntU"
county: "2Gmrs"
townshipFromSource: "e"
acres: 100000
boundaryJson: "PQR"

// case 3
provenance: "aggregator"
vintageAsOf: "f7B7igawEM"
vintageSourceType: "continuous"
vintageNote: "4eT6rSlGZh J5BKvLuTsC1R 4BIsgRtX5fDZi9lSSoAkPvnN3uXyi2xaUO35nMElcSSsrvbn K kkJsyBARzv4uFM… (501 chars)
pin: "0yLk9lQSJIN4Wadg5acHdUNaz0vmUPdNL1KALzL"
county: "miSUr67BLvP94Rv5G5o"
townshipFromSource: "ju9F9bPM p8o7tGyns7NtGwClJ4PI3L1BNCLPNzkaSyubhOrcCSiSnrNvwMDZfmv328DkPMV7zxk4Kkc2fHGL9HQH… (101 chars)
acres: 1
boundaryJson: "xvO23pLFGTKz nBcjdhvWHCx TBvVsKqh1xh7cVKeN3l1n9CAbydyEzb8WohlRX913pSGZna156oia8QNfNRXa1oH… (2000001 chars)

// case 4
provenance: "listing claim"
vintageAsOf: "YVphEQVfdR"
vintageSourceType: "manual-confirmation"
vintageNote: "WGLSJZ14jC3nIdjk1UCIHA6p nGoGimnkVbaA38xq75rXMNsnNpgfVV5KKz8Km KTtixnxahVtvVbGYqKhH  9nN0… (502 chars)
pin: "665HVU6qfHh2F5hALuLbflk8zTasQiqK76r7ZffX"
county: "TDVcusQox0PYppNXIaw5"
townshipFromSource: "Gsci9HZ erEH2IfkwU0mn7sOCiy7dVZnESDhJWzLDv8u2nbjKdHS h86UhlAoVUnrCfzvBAQu4x04nvU2OVX 7Bpl… (102 chars)
acres: 99999
boundaryJson: "qmoelvgn8vmrZmsF7xVSumVzzoL324Mcref2KpcGK1LlWNXB08EMcaabTm3n3cji4dg458hmEBvHvPzncDMp8SN1U… (2000002 chars)

```

Long values are truncated **for this report only** — the gate passes them in full.
Regenerate with `weir scaffold`; nothing here is hand-maintained.
