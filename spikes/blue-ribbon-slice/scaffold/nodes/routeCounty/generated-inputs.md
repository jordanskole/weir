# What the acceptance gate will generate

`weir accept` runs your `fn` against **100 generated inputs** at seed
42, on top of the declared examples. They are not shipped here as data —
see below — but they are deterministic, so the samples are the real head of the
real sequence.

## The first 4 inputs, verbatim

```json
// case 1
pin: "LC1QlHrN"
county: "Osceola"

// case 2
pin: "2Dp3UtmFR"
county: "Manistee"

// case 3
pin: "MaD0dLbqdlXHbk1EYuCcdJLpOntU2GmrsePQR6f"
county: "Roscommon"

// case 4
pin: "7B7igawEM4eT6rSlGZh J5BKvLuTsC1R 4BIsgRt"
county: "Iosco"

```

Long values are truncated **for this report only** — the gate passes them in full.
Regenerate with `weir scaffold`; nothing here is hand-maintained.
