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

describe("gather … until — a barrier for a set discovered by running", () => {
  const f = (l: string) => defineField({ type: "utf8", label: l, description: "d", nullable: false });
  const Seed = defineEdge({ name: "Seed", label: "S", description: "d", fields: { cursor: f("C") } });
  const Req = defineEdge({ name: "Req", label: "R", description: "d", fields: { cursor: f("C") } });
  const Page = defineEdge({ name: "Page", label: "P", description: "d", index: "n", fields: { n: f("N") } });
  const Done = defineEdge({ name: "Done", label: "D", description: "d", fields: { cursor: f("C") } });
  const All = defineEdge({ name: "All", label: "A", description: "d", fields: { pages: f("P") } });

  /** A paging loop: fetch until the server stops handing back a cursor. */
  const pagingProgram = (lastPage: number) => {
    const start = defineNode({ name: "start", input: single(Seed), output: single(Req), fn: (s: any) => ({ cursor: s.cursor }) });
    const fetchPage = defineNode({
      name: "fetchPage",
      input: single(Req),
      output: oneOf(Page, Done),
      fn: (r: any) =>
        Number(r.cursor) < lastPage
          ? { edge: "Page", payload: { n: r.cursor } }
          : { edge: "Done", payload: { cursor: r.cursor } },
    });
    // The cycle: each page's request descends from the previous page, which is
    // the sequentiality the whole barrier rests on.
    const nextReq = defineNode({
      name: "nextReq",
      input: single(Page),
      output: single(Req),
      fn: (p: any) => ({ cursor: String(Number(p.n) + 1) }),
    });
    const collect = {
      name: "collect",
      input: { kind: "gather" as const, edge: Page, until: Done },
      output: single(All),
      fn: (c: Record<string, unknown>) => ({ pages: String(Object.keys(c).length) }),
    };
    return {
      fields: {},
      edges: { Seed, Req, Page, Done, All },
      nodes: { start, fetchPage, nextReq, collect },
      wiring: {
        origins: ["start"],
        feeds: { start: ["fetchPage"], fetchPage: ["nextReq", "collect"], nextReq: ["fetchPage"] },
      },
    } as never;
  };

  /**
   * **Spec Testing #1 — the motivating case.** An ETL that cannot rejoin its
   * pages has not done anything, and a cycle has no collection token and no
   * count to close a barrier with.
   *
   * Break-proof: routing a gather with `until:` through `gatherGroups` instead
   * of `gatherUntilGroups` collects nothing at all — there is no collection
   * token anywhere in a cycle, so no group ever forms.
   */
  it("gathers every page of a cycle once the terminator arrives", async () => {
    const log = new InMemoryLog();

    const result = await runNetlist(
      pagingProgram(4),
      { correlationId: "c", originPayloads: { start: { cursor: "0" } } },
      { log, maxPulses: 40 },
    );

    expect(log.instances("Page", "c")).toHaveLength(4);
    expect(log.instances("All", "c").map((i) => i.payload)).toEqual([{ pages: "4" }]);
    expect(result.stopped).toBe("quiescence");
    expect(result.residue).toEqual([]);
  });

  /**
   * **Spec Testing #2 — the assertion the whole barrier rests on.**
   *
   * Stopped part-way, with pages produced and no terminator, the gather must
   * not fire. A barrier that closes on "some elements exist" is not a barrier;
   * it is a race.
   *
   * Break-proof: making `gatherUntilGroups` return a group per *candidate*
   * rather than per terminator fires here with a partial collection, which is
   * the silent wrong answer — an ETL that quietly processed two pages of four.
   */
  it("does not fire while the cycle is still running", async () => {
    for (const [pulses, expectedPages] of [
      [4, 2],
      [6, 3],
    ] as const) {
      const log = new InMemoryLog();
      const result = await runNetlist(
        pagingProgram(4),
        { correlationId: `p${pulses}`, originPayloads: { start: { cursor: "0" } } },
        { log, maxPulses: pulses },
      );

      expect(result.stopped).toBe("budget");
      expect(log.instances("Page", `p${pulses}`)).toHaveLength(expectedPages);
      expect(log.instances("Done", `p${pulses}`)).toHaveLength(0);
      // Pages exist, no terminator: nothing collected.
      expect(log.instances("All", `p${pulses}`)).toHaveLength(0);
    }
  });

  /**
   * Spec Testing #3. A cycle that terminates immediately gathers the empty
   * collection — which falls out of "every instance among the terminator's
   * ancestors" rather than needing a case of its own, exactly as the empty
   * spread does out of the count.
   */
  it("gathers an empty collection when the cycle terminates immediately", async () => {
    const log = new InMemoryLog();

    await runNetlist(
      pagingProgram(0),
      { correlationId: "e", originPayloads: { start: { cursor: "0" } } },
      { log, maxPulses: 20 },
    );

    expect(log.instances("Page", "e")).toHaveLength(0);
    expect(log.instances("All", "e").map((i) => i.payload)).toEqual([{ pages: "0" }]);
  });

  /**
   * **Spec Testing #7 — the guard against this quietly replacing the other
   * rule.** There are two barriers because there are two shapes, and a gather
   * with no `until:` must still use the spread's count.
   *
   * Break-proof: making `gatherUntilGroups` the only path leaves an ordinary
   * spread-fed gather with no terminator to key on, so it never fires and every
   * existing gather test reddens.
   */
  it("leaves an ordinary spread-fed gather on the count-based barrier", async () => {
    const Item = defineEdge({ name: "Item", label: "I", description: "d", index: "id", fields: { id: f("ID") } });
    const Sum = defineEdge({ name: "Sum", label: "S", description: "d", fields: { pages: f("P") } });
    const spread = defineNode({
      name: "spread",
      input: single(Seed),
      output: many(Item),
      fn: () => ({ a: { id: "a" }, b: { id: "b" } }),
    });
    const sum = defineNode({
      name: "sum",
      input: gather(Item),
      output: single(Sum),
      fn: (c: Record<string, unknown>) => ({ pages: String(Object.keys(c).length) }),
    });
    const log = new InMemoryLog();

    await runNetlist(
      {
        fields: {},
        edges: { Seed, Item, Sum },
        nodes: { spread, sum },
        wiring: { origins: ["spread"], feeds: { spread: ["sum"] } },
      } as never,
      { correlationId: "s", originPayloads: { spread: { cursor: "0" } } },
      { log, maxPulses: 20 },
    );

    expect(log.instances("Sum", "s").map((i) => i.payload)).toEqual([{ pages: "2" }]);
  });

  /**
   * **The bug this test exists because I nearly shipped.** Every test above
   * builds its program directly, so none of them goes through `elaborate` — and
   * `assertWiringTypes`' Rule C requires a spread above *every* gather, which a
   * cycle-gather by construction does not have. Rule C would have rejected
   * every paging loop, and nothing in a hand-built fixture could have noticed.
   *
   * So this one elaborates real declarations, and asserts the counterpart rule:
   * a terminator nothing produces is refused for the same reason Rule C refuses
   * a gather with no spread — the barrier can never close, so the node would
   * never fire.
   */
  it("elaborates a cycle-gather, and refuses one whose terminator nothing produces", async () => {
    const { mkdtemp, mkdir, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { elaborate } = await import("./elaborate.js");

    const write = async (until: string) => {
      const dir = await mkdtemp(join(tmpdir(), "weir-until-"));
      const scalar = (name: string, field: string) =>
        `label: ${name}\ndescription: d\nfields:\n  ${field}: { type: utf8, label: X, description: d, nullable: false }\n`;
      const files: Record<string, string> = {
        "edges/Seed.edge": scalar("Seed", "cursor"),
        "edges/Req.edge": scalar("Req", "cursor"),
        "edges/Done.edge": scalar("Done", "cursor"),
        "edges/All.edge": scalar("All", "pages"),
        "edges/Page.edge": `label: Page\ndescription: d\nindex: n\nfields:\n  n: { type: utf8, label: N, description: d, nullable: false }\n`,
        "nodes/start.node": `label: Start\ndescription: d\ninput: Seed\noutput: Req\nexamples:\n  - given: { Seed: { cursor: "0" } }\n    expect: { Req: { cursor: "0" } }\n`,
        "nodes/fetchPage.node": `label: Fetch\ndescription: d\neffect: http\ninput: Req\noutput:\n  oneOf:\n    - Page\n    - Done\n`,
        "nodes/nextReq.node": `label: Next\ndescription: d\ninput: Page\noutput: Req\nexamples:\n  - given: { Page: { n: "0" } }\n    expect: { Req: { cursor: "1" } }\n`,
        "nodes/collect.node": `label: Collect\ndescription: d\ninput:\n  gather: Page\n  until: ${until}\noutput: All\nexamples:\n  - given:\n      Page:\n        "0": { n: "0" }\n    expect: { All: { pages: "1" } }\n`,
        "topology/main.topology": `input: Seed\noutput: All\nterminals:\n  - collect\nwiring:\n  start:\n    then:\n      fetchPage:\n        then:\n          nextReq:\n            then:\n              fetchPage: {}\n          collect: {}\n`,
      };
      for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content, "utf8");
      }
      return dir;
    };

    const good = await write("Done");
    try {
      const program = await elaborate(good);
      expect((program.nodes.collect!.input as { until?: { name: string } }).until?.name).toBe("Done");
    } finally {
      await rm(good, { recursive: true, force: true });
    }

    const bad = await write("Seed");
    try {
      await expect(elaborate(bad)).rejects.toThrow(/gathers until "Seed", but nothing upstream of it produces one/);
    } finally {
      await rm(bad, { recursive: true, force: true });
    }
  });
});

describe("gather … settled — partition, beside sequence", () => {
  const f = (l: string) => defineField({ type: "utf8", label: l, description: "d", nullable: false });
  const keyed = (name: string) =>
    defineEdge({ name, label: name, description: "d", index: "pin", fields: { pin: f("I") } });
  const Corridor = defineEdge({ name: "Corridor", label: "C", description: "d", fields: { v: f("V") } });
  const Parcel = keyed("Parcel");
  const Card = keyed("Card");
  /**
   * The **real** synthesized shape: `{ input: <edge>, reason }`, with no index
   * of its own. A first version of this fixture gave it `index: pin` and a
   * `pin` field, which keyed fine and then failed the membrane's assertion —
   * the group formed correctly and the firing died after, which is a confusing
   * place to debug from. `gatherKey` keys it by the failed element's index,
   * read through `input`.
   */
  const FailedParcel = defineEdge({
    name: "Failed_Parcel",
    label: "F",
    description: "d",
    fields: { input: Parcel, reason: f("R") },
  });
  const Sum = defineEdge({ name: "Sum", label: "S", description: "d", fields: { n: f("N") } });
  const Rep = defineEdge({ name: "Rep", label: "R", description: "d", fields: { n: f("N") } });

  /** Four parcels; `fails` names the ones whose assessment throws. */
  const corridorProgram = (fails: string[], settled: unknown[] | undefined, extra: Record<string, unknown> = {}) => {
    const spread = defineNode({
      name: "spreadParcels",
      input: single(Corridor),
      output: many(Parcel),
      fn: () => ({ a: { pin: "a" }, b: { pin: "b" }, c: { pin: "c" }, d: { pin: "d" } }),
    });
    const assess = defineNode({
      name: "assessParcel",
      input: single(Parcel),
      output: single(Card),
      fn: (p: { pin: string }) => {
        if (fails.includes(p.pin)) throw new Error("county server timed out");
        return { pin: p.pin };
      },
    });
    const summarize = {
      name: "summarizeCorridor",
      output: single(Sum),
      input: { kind: "gather" as const, edge: Card, ...(settled !== undefined && { settled }) },
      fn: (c: Record<string, unknown>) => ({ n: Object.keys(c).sort().join(",") }),
    };
    return {
      fields: {},
      // `Failed_Parcel` is declared because `elaborate` synthesizes one per
      // edge. Omitting it logs the failure with no envelope — and therefore no
      // lineage — so it descends from no collection and resolves nothing. That
      // is a hand-built-fixture artifact, not a behaviour, and it cost a
      // debugging round to find.
      edges: { Corridor, Parcel, Card, Failed_Parcel: FailedParcel, Sum, Rep },
      nodes: { spreadParcels: spread, assessParcel: assess, summarizeCorridor: summarize, ...extra },
      wiring: {
        origins: ["spreadParcels"],
        feeds: {
          spreadParcels: ["assessParcel", "summarizeCorridor", ...Object.keys(extra)],
          assessParcel: ["summarizeCorridor", ...Object.keys(extra)],
        },
      },
    } as never;
  };

  const run = async (program: never, id: string) => {
    const log = new InMemoryLog();
    const result = await runNetlist(program, { correlationId: id, originPayloads: { spreadParcels: { v: "c" } } }, { log, maxPulses: 24 });
    return { log, result };
  };

  /**
   * **Spec Testing #1 — the motivating case.** One failure in 3,265 currently
   * produces nothing at all, because the count never reaches N and the group is
   * marked dead. The corridor summary is the whole deliverable.
   *
   * Break-proof: dropping `settledInstances` from `gatherGroups`' completeness
   * sum leaves `resolved` at three of four and nothing fires — which is exactly
   * today's behaviour, and the bug.
   */
  it("fires with the successes when one element failed", async () => {
    const { log, result } = await run(corridorProgram(["c"], [FailedParcel]), "x");

    expect(log.instances("Card", "x").map((i) => (i.payload as { pin: string }).pin)).toEqual(["a", "b", "d"]);
    expect(log.instances("Failed_Parcel", "x")).toHaveLength(1);
    // The node received the three cards, and nothing else.
    expect(log.instances("Sum", "x").map((i) => i.payload)).toEqual([{ n: "a,b,d" }]);
    expect(log.instances("Failed_Many_Card", "x")).toHaveLength(0);
    expect(result.residue).toEqual([]);
  });

  /**
   * **Spec Testing #2 — today's rule is the degenerate case, not a casualty.**
   * With no `settled:` the declared set is `{Card}`, a `Failed_Parcel` falls
   * outside it, and the group dies exactly as it does now. The guard against
   * this feature quietly replacing all-or-nothing.
   */
  it("still dies with no `settled:` declared", async () => {
    const { log } = await run(corridorProgram(["c"], undefined), "y");

    expect(log.instances("Sum", "y")).toHaveLength(0);
    expect(log.instances("Failed_Many_Card", "y")).toHaveLength(1);
  });

  /**
   * **Spec Testing #3 — the correction that changed the design.** A first draft
   * handed the node a bag of successes *and* failures, which puts the branch
   * inside the node. `settled:` widens what closes the barrier, never what the
   * node receives.
   *
   * Break-proof: there is nothing to break here, which is the point — the
   * payload path was never touched, so this asserts an absence. Stated plainly
   * rather than dressed as proof.
   */
  it("hands the node a collection of its own edge, never a bag", async () => {
    const seen: unknown[] = [];
    const program = corridorProgram(["c"], [FailedParcel]) as unknown as {
      nodes: { summarizeCorridor: { fn: (c: unknown) => unknown } };
    };
    const original = program.nodes.summarizeCorridor.fn;
    program.nodes.summarizeCorridor.fn = (c: unknown) => {
      seen.push(c);
      return original(c);
    };

    await run(program as never, "z");

    expect(seen).toHaveLength(1);
    // Keyed by each card's own index — no `Card` / `Failed_Parcel` tier.
    expect(Object.keys(seen[0] as object).sort()).toEqual(["a", "b", "d"]);
  });

  /**
   * **Spec Testing #4.** Three of four resolved is not a barrier closing. A
   * barrier that fires on "some elements exist" is a race, not a barrier.
   */
  it("does not fire while an element is still unresolved", async () => {
    // Stopped by firing budget, not by pulses: a spread's elements are all
    // offered in the same pulse, so only a firing cap leaves some unassessed.
    const log = new InMemoryLog();
    const result = await runNetlist(
      corridorProgram([], [FailedParcel]),
      { correlationId: "w", originPayloads: { spreadParcels: { v: "c" } } },
      { log, budget: 3 },
    );

    expect(result.stopped).toBe("budget");
    // Some elements resolved, not all — so the barrier is still open.
    expect(log.instances("Card", "w").length).toBeGreaterThan(0);
    expect(log.instances("Card", "w").length).toBeLessThan(4);
    expect(log.instances("Sum", "w")).toHaveLength(0);
  });

  /**
   * **Spec Testing #5.** Every element failing now fires with an **empty**
   * collection rather than `Failed_Many_X`. The honest answer: nothing
   * succeeded, and the run says so instead of refusing to answer.
   */
  it("fires with an empty collection when every element failed", async () => {
    const { log } = await run(corridorProgram(["a", "b", "c", "d"], [FailedParcel]), "v");

    expect(log.instances("Card", "v")).toHaveLength(0);
    expect(log.instances("Sum", "v").map((i) => i.payload)).toEqual([{ n: "" }]);
    expect(log.instances("Failed_Many_Card", "v")).toHaveLength(0);
  });

  /**
   * **Spec Testing #11, and the assertion the corrected diagram rests on.**
   *
   * Two single-input gathers over the same spread, each receiving only its own
   * edge. This is the topology-level partition — and the first diagram of this
   * drew a box implying the pair was the unit, which it is not: the test below
   * shows one works alone.
   */
  it("lets two gathers over one spread each fire with their own edge", async () => {
    const reportFailures = {
      name: "reportFailures",
      output: single(Rep),
      input: { kind: "gather" as const, edge: FailedParcel, settled: [Card] },
      fn: (c: Record<string, unknown>) => ({ n: String(Object.keys(c).length) }),
    };
    const { log } = await run(corridorProgram(["c"], [FailedParcel], { reportFailures }), "u");

    expect(log.instances("Sum", "u").map((i) => i.payload)).toEqual([{ n: "a,b,d" }]);
    expect(log.instances("Rep", "u").map((i) => i.payload)).toEqual([{ n: "1" }]);
  });

  /**
   * **The claim the corrected diagram makes, and the reason the "shared
   * barrier" box was wrong.** Each gather evaluates its own barrier against the
   * same collection token — convergence, not coordination — so one works with
   * no sibling in the program at all.
   *
   * Break-proof: none available, because there is no coupling to remove. What
   * this guards is a future implementation that *introduces* coupling, which
   * would redden it.
   */
  it("works with no sibling gather in the program", async () => {
    const { log, result } = await run(corridorProgram(["c"], [FailedParcel]), "t");

    expect(Object.keys((await corridorProgram(["c"], [FailedParcel])) as object)).toContain("nodes");
    expect(log.instances("Sum", "t").map((i) => i.payload)).toEqual([{ n: "a,b,d" }]);
    expect(result.residue).toEqual([]);
  });

  /**
   * **A test that is deliberately absent, recorded so the gap is intentional.**
   *
   * `runtime.ts` excludes the *gathered* edge from the failure set as well as
   * `settled`, so a node gathering `Failed_Parcel` cannot be killed by the very
   * instances it exists to collect. Removing that exclusion reddens **nothing**,
   * and two fixtures were written trying to make it redden before concluding it
   * is unreachable: `isDead` is gated on `resolved < size`, a complete group is
   * never dead whatever failed inside it, and the pulse loop assesses every
   * element of a spread in one pulse — so by the time a gather is offered, each
   * element has either resolved or never will.
   *
   * The code is labelled as unreachable at the site. Noted here too because a
   * reader of these tests would otherwise reasonably assume the exclusion is
   * covered.
   */

  /** Spec Testing #9: two settled sets are two contracts. */
  it("fingerprints `settled`", async () => {
    const { hashNode } = await import("./hash.js");
    const base = { name: "g", output: single(Sum) };
    const plain = await hashNode({ ...base, input: { kind: "gather", edge: Card } } as never);
    const settled = await hashNode({ ...base, input: { kind: "gather", edge: Card, settled: [FailedParcel] } } as never);

    expect(plain.hash).not.toBe(settled.hash);
  });
});
