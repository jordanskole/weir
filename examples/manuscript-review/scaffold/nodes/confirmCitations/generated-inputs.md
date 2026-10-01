# What the acceptance gate will generate

`weir accept` runs your `fn` against **100 generated inputs** at seed
42, on top of the declared examples. They are not shipped here as data —
see below — but they are deterministic, so the samples are the real head of the
real sequence.

## The first 4 inputs, verbatim

```json
// case 1
revision_id: "L"
claim: "C"
round: 1

// case 2
revision_id: "1Q"
claim: "lH"
round: 10

// case 3
revision_id: "rN2Dp3UtmFRMaD0dLbqdlXHbk1EYuCcdJLpOntU2GmrsePQR6f7B7igawEM4eT6rSlGZh J5BKvLuTsC1R 4BIsgR… (101 chars)
claim: "SoAkPvnN3uXyi2xaUO35nMElcSSsrvbn K kkJsyBARzv4uFMILousuQnkRthtcKnExS5ZBj2H04CjMYnyI E21Ud… (501 chars)
round: 2

// case 4
revision_id: "iSUr67BLvP94Rv5G5oju9F9bPM p8o7tGyns7NtGwClJ4PI3L1BNCLPNzkaSyubhOrcCSiSnrNvwMDZfmv328DkPM… (102 chars)
claim: "HGL9HQH43fo5ySHBuxvO23pLFGTKz nBcjdhvWHCx TBvVsKqh1xh7cVKeN3l1n9CAbydyEzb8WohlRX913pSGZna… (502 chars)
round: 9

```

Long values are truncated **for this report only** — the gate passes them in full.
Regenerate with `weir scaffold`; nothing here is hand-maintained.
