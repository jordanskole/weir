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
vintageNote: "CcdJLpOntU2GmrsePQR6f7B7igawEM4eT6rSlGZh J5BKvLuTsC1R 4BIsgRtX5fDZi9lSSoAkPvnN3uXyi2xaUO3… (502 chars)
pin: "pNxO9zXUbR3qL4Dy1NtDH kLeOYBL0yLk9lQSJIN"
county: "4Wadg5acHdUNaz0vmUPd"
townshipFromSource: "NL1KALzLmiSUr67BLvP94Rv5G5oju9F9bPM p8o7tGyns7NtGwClJ4PI3L1BNCLPNzkaSyubhOrcCSiSnrNvwMDZf… (102 chars)
acres: 100000
boundaryJson: "zxk4Kkc2fHGL9HQH43fo5ySHBuxvO23pLFGTKz nBcjdhvWHCx TBvVsKqh1xh7cVKeN3l1n9CAbydyEzb8WohlRX… (2000002 chars)

// case 3
provenance: "aggregator"
vintageAsOf: "tP4VvGh79m"
vintageSourceType: "continuous"
vintageNote: "TwrOBRagTCVzN1YVphEQVfdRWGLSJZ14jC3nIdjk1UCIHA6p nGoGimnkVbaA38xq75rXMNsnNpgfVV5KKz8Km KT… (311 chars)
pin: "2uufUWDzSGL2mu ch7BSAhPAL"
county: "VvLjbQhTuMrqLutStP"
townshipFromSource: "tcDOFSsUh789hXDmHJqRA938VDjHB7QwaxJsnPoCQuhJhUIhYsrOtjXr"
acres: 1
boundaryJson: "fk2YTNum4xB4Bjxc6tAaaL8joH6QlqLWjHhFqHmm TIa0oGK7HssoVOKuuQAeCgAPNPQKAldnOXDpN3i8 FPuPYGR… (1258935 chars)

// case 4
provenance: "listing claim"
vintageAsOf: "yT9EMRknv8"
vintageSourceType: "manual-confirmation"
vintageNote: "UUN3H9rPfNO8K31AGDm359eijpSFJJEshaIlbUH GoamkX1bWibZxLl1m1NS8sEq7lOwhkgk3kpqf6B7Dapgzv7Wm… (499 chars)
pin: "ojhQrRBOkQWniOfmrXzixpp"
county: "V9aiGninwyjTG05X"
townshipFromSource: "aa 7RwrtZwWLgA VB9maodXi5a6X7TbagQdzKJF"
acres: 99999
boundaryJson: "Oui9xLddH53VRPyWPYJE5RD4Pq9OQJUHaxHzPVlBFt5JnGQ rj5vRX6gQ2g6e0WEZk04yt94vkMo7lpzIxzdhTpUq… (928473 chars)

```

Long values are truncated **for this report only** — the gate passes them in full.
Regenerate with `weir scaffold`; nothing here is hand-maintained.
