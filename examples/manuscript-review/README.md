# manuscript-review

**What this example is for: a fan-in that fires once per lineage group.** Two independent checks run
on every revision of a manuscript, and the node that joins them must pair each revision's style
report with *that same revision's* fact report — never with another round's.

## The topology

```
submit (Draft -> Revision, origin)
   |
   v
Revision ----+-- revise (-> oneOf [Accepted, Revision]) --+   the loop: three rounds
   |         |                                            |
   |         +--------------------------------------------+
   |
   +-- checkStyle  (Revision -> StyleReport) ------------------+
   |                                                            v
   +-- checkFacts  (Revision -> FactFinding)              verdict (allOf [StyleReport, FactReport]
                        |                                        v          -> ReviewNote)
                        +-- confirmCitations (-> FactReport) ----+
```

```yaml
submit:
  then:
    revise:
      then:
        revise: {}
        checkStyle:
          then:
            verdict: {}
        checkFacts:
          then:
            confirmCitations:
              then:
                verdict: {}
    checkStyle: {}
    checkFacts: {}
```

`revise` cycles until the manuscript is accepted, producing three `Revision` instances. Every
revision gets both checks. `verdict` therefore has three legitimate firings to make, one per
revision — not one per run, and not nine.

## The arms are deliberately different lengths

This is the part that makes the example worth having rather than merely correct.

The style arm is one hop (`checkStyle`). The fact arm is two (`checkFacts` then
`confirmCitations`). So the two halves of each pair arrive in **different pulses**, and there is a
real moment in the run where `StyleReport` for round 2 and `FactReport` for round 1 are both sitting
unclaimed:

```
pulse 2   Revision#2      StyleReport#1   FactFinding#1
pulse 3   Revision#3      StyleReport#2   FactFinding#2   FactReport#1
                              ^                               ^
                              +---- latest-wins pairs these ---+     wrong
```

A join that resolved each declared edge to its latest instance would produce three `ReviewNote`s
with mismatched halves, and the count alone would not reveal it. Grouping by **nearest common
ancestor** pairs `StyleReport#1` with `FactReport#1` instead, because both descend from
`Revision#1` — the highest-`seq` member of the intersection of their lineages.

Symmetric arms would hide this: both halves would land in the same pulse, so latest-wins would be
accidentally right and the test would pass for the wrong reason. The asymmetry is the test.

## What a firing records

`verdict`'s envelope carries `causationIds` naming the two specific instances it consumed, one per
declared edge in declaration order. The pairing is therefore recoverable from the log afterwards —
you can ask which style report and which fact report went into a given note, and get instance ids
rather than edge types.

## What it deliberately does not show

Data-driven fan-out. The three revisions come from a **cycle**, one at a time, because a `many`
output is a single token carrying a keyed collection and nothing spreads it into N instances (see
`docs/open-questions.md`, "There is no fan-out primitive"). The shape this example cannot express is
one draft fanning out into N revisions reviewed in parallel.
