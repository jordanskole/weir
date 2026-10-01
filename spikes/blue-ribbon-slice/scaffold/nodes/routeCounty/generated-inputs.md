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
pin: "2Dp3UtmFRMaD0dLbqdlXHbk1EYuCcdJLpOntU2Gm"
county: "Manistee"

// case 3
pin: "sePQR6f7B7igawEM4"
county: "Roscommon"

// case 4
pin: "T6rSlGZh J"
county: "Iosco"

```

Long values are truncated **for this report only** — the gate passes them in full.
Regenerate with `weir scaffold`; nothing here is hand-maintained.
