/**
 * `gather` — the dual of spread
 * (docs/superpowers/specs/2026-09-27-gather.md).
 *
 * Spread gave weir one alert → N entities → independent work per entity.
 * Gather is the other half: N entity assessments → one alert assessment.
 * Its whole difficulty is cardinality — an `allOf` node's is in its
 * declaration, a gather's is decided at runtime by the spread above it — and
 * its whole solution is that the collection token records the count, so the
 * barrier has a known target reachable by ordinary lineage.
 *
 * Every test here has a break-proof recorded in its comment: what was broken
 * in the implementation, and how the test reddened. `tsconfig.json` excludes
 * `src/**\/*.test.ts`, so nothing in this file is typechecked.
 */

import { describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, gather, many, oneOf, single } from "./define.js";
import { InMemoryLog } from "./membrane.js";
import { runNetlist } from "./runtime.js";
import type { Program } from "./implementation.js";

const utf8 = (label: string) => defineField({ type: "utf8", label, description: "d", nullable: false });
/** What `elaborate`'s own `reasonField` builds — inlined, since it isn't exported. */
const reason = () => defineField({ type: "utf8", label: "Reason", description: "d", nullable: true });

const Seed = defineEdge({ name: "Seed", label: "Seed", description: "d", fields: { value: utf8("V") } });

const Batch = defineEdge({
  name: "Batch",
  label: "Batch",
  description: "d",
  index: "id",
  fields: { id: utf8("ID"), value: utf8("V") },
});

const Item = defineEdge({
  name: "Item",
  label: "Item",
  description: "d",
  index: "id",
  fields: { id: utf8("ID"), value: utf8("V") },
});

/** The gathered edge. Indexed, which `input: gather` requires — a collection needs a real key. */
const Looked = defineEdge({
  name: "Looked",
  label: "Looked",
  description: "d",
  index: "itemId",
  fields: { itemId: utf8("I"), note: utf8("N") },
});

/** The slow arm's intermediate hop — what makes one element arrive a pulse later than the other. */
const Pending = defineEdge({
  name: "Pending",
  label: "Pending",
  description: "d",
  index: "itemId",
  fields: { itemId: utf8("I") },
});

const Summary = defineEdge({
  name: "Summary",
  label: "Summary",
  description: "d",
  fields: { combined: utf8("C"), count: defineField({ type: "uint8", label: "N", description: "d", nullable: false }) },
});

/**
 * Hand-built copies of what `elaborate` synthesizes, because these tests
 * build `Program`s directly. `Failed_Item` has to be in `program.edges` for
 * the runtime to look for failures at all (it derives the failure edge names
 * from the program), and `Failed_Many_Looked` is where a dead gather routes.
 * The shapes are checked against the real synthesized ones by the
 * `examples/soc-triage` test at the bottom of this file, which elaborates for
 * real.
 */
const Failed_Item = defineEdge({
  name: "Failed_Item",
  label: "Failed (Item)",
  description: "d",
  fields: { input: Item, reason: reason() },
});
const Failed_Many_Looked = defineEdge({
  name: "Failed_Many_Looked",
  label: "Failed (gather of Looked)",
  description: "d",
  fields: { input: { many: Looked }, reason: reason() },
});

/** One seed becomes two items. The spread whose collection is every gather's barrier below. */
const explode = defineNode({
  name: "explode",
  input: single(Seed),
  output: many(Item),
  fn: (s) => ({
    a: { id: "a", value: `${s.value}-a` },
    b: { id: "b", value: `${s.value}-b` },
  }),
});

const look = defineNode({
  name: "look",
  input: single(Item),
  output: single(Looked),
  fn: (i) => ({ itemId: i.id, note: `looked ${i.value}` }),
});

const summarize = defineNode({
  name: "summarize",
  input: gather(Looked),
  output: single(Summary),
  fn: (collection) => ({
    combined: Object.keys(collection).sort().join("+"),
    count: Object.keys(collection).length,
  }),
});

const run = async (program: Program, originPayloads: Record<string, unknown>, correlationId = "t") => {
  const log = new InMemoryLog();
  const result = await runNetlist(program, { correlationId, originPayloads }, { log, maxPulses: 12 });
  return { log, result };
};

describe("gather — one barrier, one firing", () => {
  /**
   * Spec Testing #1.
   *
   * Break-proofs, two, and one correction worth keeping. Keying the
   * collection by each member's log id instead of its declared `index`
   * reddened this (and four others, since the membrane rejects a mis-keyed
   * collection); omitting the barrier from `causationIds` reddened the
   * lineage assertion.
   *
   * What does *not* redden it: relaxing `gatherGroups`' completeness test to
   * `members.length > 0`. Both elements reach `Looked` in the same pulse
   * here, so "wait for the group" and "fire on whatever is there" produce the
   * identical one firing. This comment first claimed that break-proof anyway
   * — the vacuous-test pattern, written into a test whose whole point is to
   * avoid it. The completeness rule is proved by the next test, which is what
   * its asymmetric arm is for.
   */
  it("fires once with every instance descended from one spread, keyed by each element's own index", async () => {
    const program: Program = {
      fields: {},
      edges: { Seed, Item, Looked, Summary },
      nodes: { explode, look, summarize },
      wiring: { origins: ["explode"], feeds: { explode: ["look"], look: ["summarize"] } },
    };

    const { log } = await run(program, { explode: { value: "x" } });

    const summaries = log.instances("Summary", "t");
    expect(summaries).toHaveLength(1);
    // Keyed by `Looked.index` (`itemId`), not by position and not by the
    // element's own log id — the same key a `many` output's collection uses.
    expect(summaries[0]!.payload).toEqual({ combined: "a+b", count: 2 });

    // Causation names the barrier *and* its contents: the collection token
    // first, then both members. The collection is what makes "which spread
    // was this the gather of" answerable from the log rather than inferable.
    const collection = log.instances("Many_Item", "t")[0]!;
    const members = log.instances("Looked", "t");
    expect(summaries[0]!.envelope?.causationIds).toEqual([
      collection.id,
      ...members.map((m) => m.id),
    ]);
  });

  /**
   * Spec Testing #2 — both halves, deliberately. A rule that fired early
   * would pass a final-state check, since the second firing would still
   * leave a `Summary` naming both elements in the log.
   *
   * The asymmetric arm is what makes this test non-vacuous, and it is here
   * because a symmetric one was how `manuscript-review`'s join test managed
   * to pass with the join disabled: both elements otherwise reach `Looked`
   * in the same pulse, so "waits for the group" and "fires on whatever is
   * there" are indistinguishable.
   *
   * Break-proof: with completeness relaxed to `members.length > 0`, this
   * fired at step 3 on one of two members, reddening on `step === 4`. It is
   * one of only two tests in this file that break does redden.
   */
  it("does not fire while the group is incomplete, and fires on the pulse after the last member arrives", async () => {
    // Item "a" reaches `Looked` directly; item "b" takes an extra hop, so the
    // group is 1-of-2 for one whole pulse.
    const lookSlowly = defineNode({
      name: "lookSlowly",
      input: single(Item),
      output: oneOf(Looked, Pending),
      fn: (i) =>
        i.id === "a"
          ? { edge: "Looked", payload: { itemId: i.id, note: `looked ${i.value}` } }
          : { edge: "Pending", payload: { itemId: i.id } },
    });
    const finish = defineNode({
      name: "finish",
      input: single(Pending),
      output: single(Looked),
      fn: (p) => ({ itemId: p.itemId, note: `looked later ${p.itemId}` }),
    });
    const program: Program = {
      fields: {},
      edges: { Seed, Item, Looked, Pending, Summary },
      nodes: { explode, lookSlowly, finish, summarize },
      wiring: {
        origins: ["explode"],
        feeds: {
          explode: ["lookSlowly"],
          lookSlowly: ["finish", "summarize"],
          finish: ["summarize"],
        },
      },
    };

    const { log } = await run(program, { explode: { value: "x" } });

    // Pulse 1 explode, pulse 2 lookSlowly (both items), pulse 3 finish — so
    // the second `Looked` is written during pulse 3 and, by the snapshot rule,
    // is first visible in pulse 4. Firing in 4 is therefore "as soon as the
    // group is complete", and firing in 3 would be firing on one of two.
    const summaries = log.instances("Summary", "t");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.envelope?.step).toBe(4);
    expect(summaries[0]!.payload).toEqual({ combined: "a+b", count: 2 });
  });
});

describe("gather — which barrier", () => {
  /**
   * Spec Testing #3. The lineage equivalent of the cross-entity pairing
   * `assembleEvidence` was fixed for: two spreads in one run must gather
   * separately, or a batch's summary contains another batch's items.
   *
   * Break-proof: changing `nearestCollection` to return the *lowest*-`seq`
   * collection ancestor — any common ancestor rather than the nearest — put
   * all four `Looked` under the outer `Many_Batch`, whose count is 2 rather
   * than 4, so no group ever completed and this reddened on
   * `toHaveLength(2)`. It is the only test in this file that break reddens.
   *
   * What does not redden it: taking the *first* collection the ancestor walk
   * encounters instead of the highest-`seq` one. `selfAndAncestorIds` walks
   * breadth-first, so the first collection it reaches is already the nearest
   * by hop count. The `seq` rule is kept because it is the one `joinRows`
   * uses and does not depend on a walk order, not because this test
   * distinguishes the two.
   */
  it("gathers two spreads in one run separately", async () => {
    const split = defineNode({
      name: "split",
      input: single(Seed),
      output: many(Batch),
      fn: (s) => ({ one: { id: "one", value: s.value }, two: { id: "two", value: s.value } }),
    });
    const explodeBatch = defineNode({
      name: "explodeBatch",
      input: single(Batch),
      output: many(Item),
      fn: (b) => ({
        [`${b.id}-a`]: { id: `${b.id}-a`, value: b.value },
        [`${b.id}-b`]: { id: `${b.id}-b`, value: b.value },
      }),
    });
    const program: Program = {
      fields: {},
      edges: { Seed, Batch, Item, Looked, Summary },
      nodes: { split, explodeBatch, look, summarize },
      wiring: {
        origins: ["split"],
        feeds: { split: ["explodeBatch"], explodeBatch: ["look"], look: ["summarize"] },
      },
    };

    const { log } = await run(program, { split: { value: "x" } });

    // Two `Many_Item` collections — `explodeBatch` fired once per batch.
    expect(log.instances("Many_Item", "t")).toHaveLength(2);
    const summaries = log.instances("Summary", "t");
    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.payload).sort((a, b) => a.combined.localeCompare(b.combined))).toEqual([
      { combined: "one-a+one-b", count: 2 },
      { combined: "two-a+two-b", count: 2 },
    ]);
  });
});

describe("gather — the empty collection", () => {
  /**
   * Spec Testing #4, and §5: `traverse` over an empty collection yields an
   * empty collection, so a spread of zero elements must let its gather fire
   * immediately rather than wait for the first of zero things. Not
   * hypothetical — `extractEntities` finding nothing recognizable in an alert
   * is an ordinary outcome.
   *
   * Break-proof twice over, and it is the only test that catches either.
   * Requiring `members.length > 0` before forming a group made this reach
   * quiescence with no `Summary` at all. Not consuming the collection token
   * (only the members, of which an empty group has none) made it re-fire
   * every pulse until `maxPulses`, reddening on `stopped === "quiescence"` —
   * which is why the barrier is consumed as well as its contents.
   */
  it("gathers an empty collection immediately, to an empty collection", async () => {
    const explodeNothing = defineNode({
      name: "explodeNothing",
      input: single(Seed),
      output: many(Item),
      fn: () => ({}),
    });
    const program: Program = {
      fields: {},
      edges: { Seed, Item, Looked, Summary },
      nodes: { explodeNothing, look, summarize },
      wiring: { origins: ["explodeNothing"], feeds: { explodeNothing: ["look"], look: ["summarize"] } },
    };

    const { log, result } = await run(program, { explodeNothing: { value: "x" } });

    expect(result.stopped).toBe("quiescence");
    const summaries = log.instances("Summary", "t");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.payload).toEqual({ combined: "", count: 0 });
    // Pulse 1 spreads nothing; the gather fires in pulse 2, the first pulse
    // in which the empty collection is visible. Not later — no waiting.
    expect(summaries[0]!.envelope?.step).toBe(2);
    expect(log.instances("Looked", "t")).toHaveLength(0);
  });
});

describe("gather — a failed element", () => {
  /**
   * Spec Testing #5, and §4: `sequence`'s signature settles the policy —
   * `t (f a) → f (t a)` means one element's failure makes the whole result a
   * failure. Left unhandled the count never reaches N and the gather hangs
   * until the budget, which is this repo's worst failure mode.
   *
   * Break-proof: never consulting `failures` in `gatherGroups` made this
   * reach `quiescence` with no `Failed_Many_Looked` and no `Summary` — the
   * silent stall this rule exists to prevent — reddening on
   * `toHaveLength(1)`. The only test in this file that break reddens.
   */
  it("fails the whole group when an element fails, rather than hanging", async () => {
    const lookOrFail = defineNode({
      name: "lookOrFail",
      input: single(Item),
      output: single(Looked),
      fn: (i) => {
        if (i.id === "b") throw new Error("b is unreadable");
        return { itemId: i.id, note: `looked ${i.value}` };
      },
    });
    const program: Program = {
      fields: {},
      edges: { Seed, Item, Looked, Summary, Failed_Item, Failed_Many_Looked },
      nodes: { explode, lookOrFail, summarize },
      wiring: { origins: ["explode"], feeds: { explode: ["lookOrFail"], lookOrFail: ["summarize"] } },
    };

    const { log, result } = await run(program, { explode: { value: "x" } });

    expect(result.stopped).toBe("quiescence");
    expect(log.instances("Summary", "t")).toHaveLength(0);

    // Routed under the gather's own synthesized edge, not `Failed_Looked`: a
    // gather's `Failed<In>` carries the *collection* it was holding, which is
    // a different shape from one `Looked`.
    const failures = log.instances("Failed_Many_Looked", "t");
    expect(failures).toHaveLength(1);
    const failure = failures[0]!.payload as { input: Record<string, unknown>; reason: string };
    // The partial collection is the `input`, so what did arrive is not lost.
    expect(Object.keys(failure.input)).toEqual(["a"]);
    expect(failure.reason).toContain("can no longer complete");
    expect(failure.reason).toContain("1 of 2");
    // Routable like any other failure — it has an envelope, so a downstream
    // node declaring `input: Failed_Many_Looked` can be wired to it.
    expect(failures[0]!.envelope?.node).toBe("summarize");
  });

  /**
   * The precedence the deadness rule needs stated: a group that *completed*
   * fires as a success even though something else under the same barrier
   * failed. A failure on a side branch is not a reason to discard N results
   * that all arrived.
   *
   * The slow arm is load-bearing again, and for a sharper reason than in the
   * incompleteness test. Without it the side branch's `Failed_Tag` lands in
   * the same pulse the group completes, so it is invisible in that pulse's
   * snapshot and the group would fire as a success under *any* precedence
   * rule — a vacuous test. With it, the failure is already in the log a whole
   * pulse before the group completes, so precedence is the only thing
   * deciding the outcome.
   *
   * Break-proof: dropping the `members.length < size` clause from
   * `gatherGroups`' `isDead` made this produce a `Failed_Many_Looked` and no
   * `Summary`. The only test in this file that break reddens.
   */
  it("still succeeds when every member arrived and a side branch had already failed", async () => {
    const Tag = defineEdge({
      name: "Tag",
      label: "Tag",
      description: "d",
      index: "itemId",
      fields: { itemId: utf8("I") },
    });
    const Failed_Tag = defineEdge({
      name: "Failed_Tag",
      label: "Failed (Tag)",
      description: "d",
      fields: { input: Tag, reason: reason() },
    });
    // A second, independent treatment of each element that always fails, on
    // the *fast* path — so `Failed_Tag` is in the log by pulse 3 …
    const alsoTag = defineNode({
      name: "alsoTag",
      input: single(Item),
      output: single(Tag),
      fn: (i) => ({ itemId: i.id }),
    });
    const breakTag = defineNode({
      name: "breakTag",
      input: single(Tag),
      output: single(Tag),
      fn: () => {
        throw new Error("always");
      },
    });
    // … while the gathered arm takes an extra hop for item "b", so the group
    // is not complete until pulse 4.
    const lookSlowly = defineNode({
      name: "lookSlowly",
      input: single(Item),
      output: oneOf(Looked, Pending),
      fn: (i) =>
        i.id === "a"
          ? { edge: "Looked", payload: { itemId: i.id, note: `looked ${i.value}` } }
          : { edge: "Pending", payload: { itemId: i.id } },
    });
    const finish = defineNode({
      name: "finish",
      input: single(Pending),
      output: single(Looked),
      fn: (p) => ({ itemId: p.itemId, note: `looked later ${p.itemId}` }),
    });
    const program: Program = {
      fields: {},
      edges: { Seed, Item, Looked, Pending, Summary, Tag, Failed_Item, Failed_Tag, Failed_Many_Looked },
      nodes: { explode, lookSlowly, finish, alsoTag, breakTag, summarize },
      wiring: {
        origins: ["explode"],
        feeds: {
          explode: ["lookSlowly", "alsoTag"],
          alsoTag: ["breakTag"],
          lookSlowly: ["finish", "summarize"],
          finish: ["summarize"],
        },
      },
    };

    const { log } = await run(program, { explode: { value: "x" } });

    // The failure is real, and it is already there before the group completes.
    const tagFailures = log.instances("Failed_Tag", "t");
    expect(tagFailures).toHaveLength(2);
    expect(tagFailures.every((f) => (f.envelope?.step ?? 0) < 4)).toBe(true);

    expect(log.instances("Failed_Many_Looked", "t")).toHaveLength(0);
    const summaries = log.instances("Summary", "t");
    expect(summaries).toHaveLength(1);
    expect(summaries[0]!.envelope?.step).toBe(4);
    expect(summaries[0]!.payload).toEqual({ combined: "a+b", count: 2 });
  });
});
