# What the acceptance gate will generate

`weir accept` runs your `fn` against **100 generated inputs** at seed
42, on top of the declared examples. They are not shipped here as data —
see below — but they are deterministic, so the samples are the real head of the
real sequence.

## The first 4 inputs, verbatim

```json
// case 1
StyleReport: {"revision_id":"L","note":"C"}
FactReport: {"revision_id":"1","note":"Q"}

// case 2
StyleReport: {"revision_id":"lH","note":"rN"}
FactReport: {"revision_id":"2D","note":"p3"}

// case 3
StyleReport: {"revision_id":"UtmFRMaD0dLbqdlXHbk1EYuCcdJLpOntU2GmrsePQR6f7B7igawEM4eT6rSlGZh J5BKvLuTsC… (626 chars)
FactReport: {"revision_id":"BLvP94Rv5G5oju9F9bPM p8o7tGyns7NtGwClJ4PI3L1BNCLPNzkaSyubhOrcCSiSnrNvwMDZf… (626 chars)

// case 4
StyleReport: {"revision_id":"PCfJhl0oJzWKFZNypR66WYOllh5SEIsM3tA 3UaH5ogdAr01Md6vMuEYU1tlgFnWIL6NUskdbW… (628 chars)
FactReport: {"revision_id":"xllmVs lB0QNA4bOMR 44o9vrof9EiRCm0MlZ3EJBjjCfLJbRth6ioiqWbO68JnNoIapzV8dNj… (628 chars)

```

Long values are truncated **for this report only** — the gate passes them in full.
Regenerate with `weir scaffold`; nothing here is hand-maintained.
