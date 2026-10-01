# What the acceptance gate will generate

`weir accept` runs your `fn` against **100 generated inputs** at seed
42, on top of the declared examples. They are not shipped here as data —
see below — but they are deterministic, so the samples are the real head of the
real sequence.

## The first 4 inputs, verbatim

```json
// case 1
id: "L"
text: "C"

// case 2
id: "1Q"
text: "lH"

// case 3
id: "rN2Dp3UtmFRMaD0dLbqdlXHbk1EYuCcdJLpOntU2GmrsePQR6f7B7igawEM4eT6rSlGZh J5BKvLuTsC1R 4BIsgR… (101 chars)
text: "SoAkPvnN3uXyi2xaUO35nMElcSSsrvbn K kkJsyBARzv4uFMILousuQnkRthtcKnExS5ZBj2H04CjMYnyI E21Ud… (2001 chars)

// case 4
id: "5y84X8eEmYXs0sMwS61ORPmOR5gtRPyRXew thgR5HwKcQR294QiJYAgZxEqSfeRLzbYUPRupul0Gi9AbvfzjdAXf… (102 chars)
text: "TJ0xRt Q5N fbM8dMj8RAsQ2E7hzqYFVQgW1O5hjvOkEe9ITra2Hnce2PAAtAKlHihoslyWlxst gZmEprKAZL3dp… (2002 chars)

```

Long values are truncated **for this report only** — the gate passes them in full.
Regenerate with `weir scaffold`; nothing here is hand-maintained.
