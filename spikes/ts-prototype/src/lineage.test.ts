import { describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, allOf, single } from "./define.js";
import { InMemoryLog } from "./membrane.js";
import { runNetlist } from "./runtime.js";
import { ancestorsOf, joinRows, selfAndAncestorIds } from "./lineage.js";
import type { Program } from "./implementation.js";
import type { NodeDef } from "./types.js";

/**
 * Same `programWith` idiom `runtime.test.ts` uses: a Program is more than
 * `nodes`/`wiring`, but nothing in this file's fixtures needs `fields` or
 * `edges` populated — success-path firing hashes each node's own declared
 * output edge, never `program.edges` (see `runtime.ts`'s `instanceEnvelope`
 * call sites, which only reach `program.edges` on a failure path none of
 * these fixtures exercise).
 */
function programWith(nodes: Record<string, NodeDef>, wiring: Program["wiring"]): Program {
  return { fields: {}, edges: {}, nodes, wiring };
}

// A straight three-node chain: origin -> doubled -> tripled. Exercises the
// simple case, a linear ancestor chain with no fan-in.
const Value = defineEdge({
  name: "Value",
  label: "Value",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Doubled = defineEdge({
  name: "Doubled",
  label: "Doubled",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Tripled = defineEdge({
  name: "Tripled",
  label: "Tripled",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const chainOrigin = defineNode({
  name: "chainOrigin",
  input: single(Value),
  output: single(Value),
  fn: (v) => v,
});
const doubled = defineNode({
  name: "doubled",
  input: single(Value),
  output: single(Doubled),
  fn: (v) => ({ value: `${v.value}${v.value}` }),
});
const tripled = defineNode({
  name: "tripled",
  input: single(Doubled),
  output: single(Tripled),
  fn: (d) => ({ value: `${d.value}${d.value}${d.value}` }),
});
const chainProgram = programWith(
  { chainOrigin, doubled, tripled },
  { origins: ["chainOrigin"], feeds: { chainOrigin: ["doubled"], doubled: ["tripled"] } },
);

// A diamond: source feeds both left and right; join (allOf) consumes both.
// source is reachable from joined by two separate paths and must appear
// exactly once in joined's ancestors.
const Source = defineEdge({
  name: "Source",
  label: "Source",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Left = defineEdge({
  name: "Left",
  label: "Left",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Right = defineEdge({
  name: "Right",
  label: "Right",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Joined = defineEdge({
  name: "Joined",
  label: "Joined",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const diamondSource = defineNode({
  name: "diamondSource",
  input: single(Source),
  output: single(Source),
  fn: (s) => s,
});
const left = defineNode({
  name: "left",
  input: single(Source),
  output: single(Left),
  fn: (s) => ({ value: `left-${s.value}` }),
});
const right = defineNode({
  name: "right",
  input: single(Source),
  output: single(Right),
  fn: (s) => ({ value: `right-${s.value}` }),
});
const join = defineNode({
  name: "join",
  input: allOf(Left, Right),
  output: single(Joined),
  fn: ({ Left: l, Right: r }) => ({ value: `${l.value}+${r.value}` }),
});
const diamondProgram = programWith(
  { diamondSource, left, right, join },
  { origins: ["diamondSource"], feeds: { diamondSource: ["left", "right"], left: ["join"], right: ["join"] } },
);

// countToThree: the topology has a real cycle (countToThree wired back to
// itself), but each firing consumes a strictly earlier instance, so the
// *instance* graph is a DAG even though the *node* graph is not. Same
// fixture shape as runtime.test.ts's countToThreeProgram.
const Continue = defineEdge({
  name: "Continue",
  label: "Continue",
  description: "d",
  fields: { n: defineField({ type: "uint8", label: "n", description: "d", nullable: false }) },
});
const Done = defineEdge({
  name: "Done",
  label: "Done",
  description: "d",
  fields: { n: defineField({ type: "uint8", label: "n", description: "d", nullable: false }) },
});
const seed = defineNode({
  name: "seed",
  input: single(Continue),
  output: single(Continue),
  fn: (c) => c,
});
const countToThree = defineNode({
  name: "countToThree",
  input: single(Continue),
  output: { kind: "oneOf", edges: [Continue, Done] },
  fn: (c) =>
    c.n >= 3 ? { edge: "Done" as const, payload: c } : { edge: "Continue" as const, payload: { n: c.n + 1 } },
});
const countToThreeProgram = programWith(
  { seed, countToThree },
  { origins: ["seed"], feeds: { seed: ["countToThree"], countToThree: ["countToThree"] } },
);

describe("ancestorsOf", () => {
  it("returns an instance's transitive ancestors, oldest first", async () => {
    const log = new InMemoryLog();
    await runNetlist(chainProgram, { correlationId: "c1", originPayloads: { chainOrigin: { value: "a" } } }, { log, budget: 20 });
    const last = log.instances("Tripled", "c1")[0];

    expect(ancestorsOf(log, last.id).map((i) => i.payload)).toEqual([
      { value: "a" },
      { value: "aa" },
    ]);
  });

  it("returns a diamond's shared ancestor once, not twice", async () => {
    // left and right both descend from the same source; join consumes both.
    // A dedup keyed on the wrong thing returns the source twice.
    const log = new InMemoryLog();
    await runNetlist(diamondProgram, { correlationId: "c1", originPayloads: { diamondSource: { value: "a" } } }, { log, budget: 20 });
    const joined = log.instances("Joined", "c1")[0];

    const ids = ancestorsOf(log, joined.id).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Not just deduped but present: left, right, and the shared source —
    // three, not fewer. A dedup so aggressive it dropped a branch entirely
    // would still pass the Set-size check above without this.
    expect(ids.length).toBe(3);
  });

  it("terminates on a topology with a cycle, returning each ancestor once", async () => {
    const log = new InMemoryLog();
    await runNetlist(countToThreeProgram, { correlationId: "c1", originPayloads: { seed: { n: 0 } } }, { log, budget: 20 });
    const done = log.instances("Done", "c1")[0];

    const ids = ancestorsOf(log, done.id).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(1);
  });

  it("returns an empty array for an instance nothing caused", async () => {
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(ancestorsOf(log, id)).toEqual([]);
  });
});

describe("selfAndAncestorIds", () => {
  it("includes the instance itself", () => {
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(selfAndAncestorIds(log, id)).toEqual(new Set([id]));
  });

  it("includes every transitive ancestor as well as self", async () => {
    const log = new InMemoryLog();
    await runNetlist(
      chainProgram,
      { correlationId: "c1", originPayloads: { chainOrigin: { value: "a" } } },
      { log, budget: 20 },
    );
    const last = log.instances("Tripled", "c1")[0];
    const mid = log.instances("Doubled", "c1")[0];
    const first = log.instances("Value", "c1")[0];

    expect(selfAndAncestorIds(log, last.id)).toEqual(new Set([last.id, mid.id, first.id]));
  });

  it("returns a diamond's shared ancestor once", async () => {
    const log = new InMemoryLog();
    await runNetlist(
      diamondProgram,
      { correlationId: "c1", originPayloads: { diamondSource: { value: "a" } } },
      { log, budget: 20 },
    );
    const joined = log.instances("Joined", "c1")[0];

    const ids = selfAndAncestorIds(log, joined.id);
    // 1 joined + left + right + source = 4, with source reached by two paths.
    expect(ids.size).toBe(4);
  });

  it("returns just the instance for one with no envelope", () => {
    // A staged instance has no invocation behind it, so no lineage.
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(selfAndAncestorIds(log, id)).toEqual(new Set([id]));
  });

  it("returns just the id for an instance not in the log", () => {
    expect(selfAndAncestorIds(new InMemoryLog(), "nope")).toEqual(new Set(["nope"]));
  });
});

describe("Log.instanceById", () => {
  it("finds an instance by the id append returned", () => {
    const log = new InMemoryLog();
    const id = log.append("Value", "c1", { value: "a" });

    expect(log.instanceById(id)?.payload).toEqual({ value: "a" });
  });

  it("returns undefined for an unknown id rather than throwing", () => {
    expect(new InMemoryLog().instanceById("nope")).toBeUndefined();
  });
});

// Two entities, each fanning out to Left/Right context. `source` is the one
// origin (fires once); `branchA`/`branchB` are plain single-input
// passthroughs whose only job is to give `extractEntities` two independent
// unconsumed `FanSeed` instances to fire on, so the two entities are
// siblings under `source` rather than a chain where the second descends
// from the first — a chained design would make entity 2 a descendant of
// entity 1, and a *wrong* pairing (Left from entity 1, Right from entity 2)
// would still share entity 1 as a common ancestor.
//
// Siblings alone are not enough, though. `leftCtx` and `rightCtx` would
// both read the same `FanEntity` log in the same append order (entity A
// before entity B, since `branchA` fires before `branchB`), so a flat
// positional zip across *all* candidates — exactly what the ascending-seq
// bug produces once it lumps everything into the origin's group — would
// pair index 0 with index 0 and land on the *same* two rows a correct
// per-entity grouping would. The mispairing test would pass against the
// broken implementation for the wrong reason.
//
// `rightGate` breaks that coincidence on purpose: it stalls entity A two
// extra pulses (keyed off the "-A" suffix already in its payload) before
// forwarding it to `rightCtx`, while entity B passes straight through. So
// `Right` ends up logged as [entity B, entity A] — reversed from `Left`'s
// [entity A, entity B]. A correct nearest-ancestor grouping still pairs
// each entity with itself; a flat positional zip now pairs entity A's Left
// with entity B's Right instead, which is exactly the wrong pairing the
// per-row assertion below is positioned to catch.
const FanSeed = defineEdge({
  name: "FanSeed",
  label: "FanSeed",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const FanEntity = defineEdge({
  name: "FanEntity",
  label: "FanEntity",
  description: "d",
  fields: {
    value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }),
    spins: defineField({ type: "uint8", label: "spins", description: "d", nullable: false }),
  },
});
const RightEntity = defineEdge({
  name: "RightEntity",
  label: "RightEntity",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const FanLeft = defineEdge({
  name: "Left",
  label: "Left",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const FanRight = defineEdge({
  name: "Right",
  label: "Right",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const fanSource = defineNode({
  name: "source",
  input: single(FanSeed),
  output: single(FanSeed),
  fn: (s) => s,
});
const branchA = defineNode({
  name: "branchA",
  input: single(FanSeed),
  output: single(FanSeed),
  fn: (s) => ({ value: `${s.value}-A` }),
});
const branchB = defineNode({
  name: "branchB",
  input: single(FanSeed),
  output: single(FanSeed),
  fn: (s) => ({ value: `${s.value}-B` }),
});
const extractEntities = defineNode({
  name: "extractEntities",
  input: single(FanSeed),
  output: single(FanEntity),
  fn: (s) => ({ value: s.value, spins: 0 }),
});
const leftCtx = defineNode({
  name: "leftCtx",
  input: single(FanEntity),
  output: single(FanLeft),
  fn: (e) => ({ value: `left-${e.value}` }),
});
// Self-loops on FanEntity, stalling entity A ("-A" suffix) two extra pulses
// before handing off to RightEntity; entity B passes through with zero
// spins. See the block comment above for why this asymmetry matters.
const rightGate = defineNode({
  name: "rightGate",
  input: single(FanEntity),
  output: { kind: "oneOf", edges: [FanEntity, RightEntity] },
  fn: (e) => {
    const needsSpins = e.value.endsWith("-A") ? 2 : 0;
    if (e.spins < needsSpins) {
      return { edge: "FanEntity" as const, payload: { value: e.value, spins: e.spins + 1 } };
    }
    return { edge: "RightEntity" as const, payload: { value: e.value } };
  },
});
const rightCtx = defineNode({
  name: "rightCtx",
  input: single(RightEntity),
  output: single(FanRight),
  fn: (e) => ({ value: `right-${e.value}` }),
});
const twoEntityFanOutProgram = programWith(
  { source: fanSource, branchA, branchB, extractEntities, leftCtx, rightGate, rightCtx },
  {
    origins: ["source"],
    feeds: {
      source: ["branchA", "branchB"],
      branchA: ["extractEntities"],
      branchB: ["extractEntities"],
      extractEntities: ["leftCtx", "rightGate"],
      rightGate: ["rightGate", "rightCtx"],
    },
  },
);

// bake: Recipe comes straight off the origin (ancestors(Recipe) is empty),
// heat consumes Recipe and emits Oven. No allOf node needed — joinRows is
// called directly against the gathered candidates.
const Recipe = defineEdge({
  name: "Recipe",
  label: "Recipe",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Oven = defineEdge({
  name: "Oven",
  label: "Oven",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const bakeSource = defineNode({
  name: "source",
  input: single(Recipe),
  output: single(Recipe),
  fn: (r) => r,
});
const heat = defineNode({
  name: "heat",
  input: single(Recipe),
  output: single(Oven),
  fn: (r) => ({ value: `baked-${r.value}` }),
});
const originEdgeProgram = programWith(
  { source: bakeSource, heat },
  { origins: ["source"], feeds: { source: ["heat"] } },
);

// One entity; Left and Right each get two sibling producers (leftFirst/
// leftSecond, rightFirst/rightSecond) so the edge has two instances, and Mid
// gets one. All five descend directly from the same Entity instance, so
// they land in one lineage group; zip depth is min(2, 2, 1) = 1, and the
// second Left/Right go unconsumed.
const RaggedEntity = defineEdge({
  name: "RaggedEntity",
  label: "RaggedEntity",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const RaggedLeft = defineEdge({
  name: "Left",
  label: "Left",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const RaggedRight = defineEdge({
  name: "Right",
  label: "Right",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Mid = defineEdge({
  name: "Mid",
  label: "Mid",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const raggedSource = defineNode({
  name: "source",
  input: single(RaggedEntity),
  output: single(RaggedEntity),
  fn: (e) => e,
});
const leftFirst = defineNode({
  name: "leftFirst",
  input: single(RaggedEntity),
  output: single(RaggedLeft),
  fn: (e) => ({ value: `left1-${e.value}` }),
});
const leftSecond = defineNode({
  name: "leftSecond",
  input: single(RaggedEntity),
  output: single(RaggedLeft),
  fn: (e) => ({ value: `left2-${e.value}` }),
});
const rightFirst = defineNode({
  name: "rightFirst",
  input: single(RaggedEntity),
  output: single(RaggedRight),
  fn: (e) => ({ value: `right1-${e.value}` }),
});
const rightSecond = defineNode({
  name: "rightSecond",
  input: single(RaggedEntity),
  output: single(RaggedRight),
  fn: (e) => ({ value: `right2-${e.value}` }),
});
const mid = defineNode({
  name: "mid",
  input: single(RaggedEntity),
  output: single(Mid),
  fn: (e) => ({ value: `mid-${e.value}` }),
});
const raggedGroupProgram = programWith(
  { source: raggedSource, leftFirst, leftSecond, rightFirst, rightSecond, mid },
  {
    origins: ["source"],
    feeds: { source: ["leftFirst", "leftSecond", "rightFirst", "rightSecond", "mid"] },
  },
);

// The state the final review believed could not occur: a nearer ancestor that
// is *incomplete* not because its other arm has yet to run, but because the
// other edge's only candidate under it was already claimed by a nearer group.
// The review's reasoning was "if `R_A` exists then `E_A` is its nearest
// ancestor too, so nothing nearer could have claimed it". A ragged zip breaks
// that: a nearer group claims matched pairs and leaves the surplus behind, so
// one edge under the ancestor can be drained while the other still has a
// leftover.
//
// `stem` is the ancestor in question. Below it, `twig` produces one Left and
// one Right, which pair at `Twig` — the nearer group. `stemLeft` produces a
// second Left directly off `Stem`, which that group does not claim. So once
// the `Twig` row is taken, `Stem` reads as "a Left, no Right" — some declared
// edges but not all — exactly the incomplete-by-claiming state. The surviving
// Left's real partner is `seedRight`'s instance, whose nearest common ancestor
// with it is the seed, one step further out.
const ClaimSeed = defineEdge({
  name: "ClaimSeed",
  label: "ClaimSeed",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Stem = defineEdge({
  name: "Stem",
  label: "Stem",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Twig = defineEdge({
  name: "Twig",
  label: "Twig",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const ClaimLeft = defineEdge({
  name: "Left",
  label: "Left",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const ClaimRight = defineEdge({
  name: "Right",
  label: "Right",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const claimedAwayProgram = programWith(
  {
    source: defineNode({
      name: "source",
      input: single(ClaimSeed),
      output: single(ClaimSeed),
      fn: (s) => s,
    }),
    stem: defineNode({
      name: "stem",
      input: single(ClaimSeed),
      output: single(Stem),
      fn: () => ({ value: "stem" }),
    }),
    twig: defineNode({ name: "twig", input: single(Stem), output: single(Twig), fn: () => ({ value: "twig" }) }),
    twigLeft: defineNode({
      name: "twigLeft",
      input: single(Twig),
      output: single(ClaimLeft),
      fn: () => ({ value: "twig-left" }),
    }),
    twigRight: defineNode({
      name: "twigRight",
      input: single(Twig),
      output: single(ClaimRight),
      fn: () => ({ value: "twig-right" }),
    }),
    stemLeft: defineNode({
      name: "stemLeft",
      input: single(Stem),
      output: single(ClaimLeft),
      fn: () => ({ value: "stem-left" }),
    }),
    seedRight: defineNode({
      name: "seedRight",
      input: single(ClaimSeed),
      output: single(ClaimRight),
      fn: () => ({ value: "seed-right" }),
    }),
  },
  {
    origins: ["source"],
    feeds: {
      source: ["stem", "seedRight"],
      stem: ["twig", "stemLeft"],
      twig: ["twigLeft", "twigRight"],
    },
  },
);

describe("joinRows", () => {
  it("pairs instances by their nearest common ancestor, never across groups", async () => {
    // Two entities, each fanning out to two context edges. The WRONG
    // pairing must be available for this test to mean anything: all four
    // context instances share the origin, so a rule keyed on "shares an
    // ancestor" would happily pair left_1 with right_2.
    const log = new InMemoryLog();
    await runNetlist(
      twoEntityFanOutProgram,
      { correlationId: "c1", originPayloads: { source: { value: "seed" } } },
      { log, budget: 40 },
    );

    const lefts = log.instances("Left", "c1");
    const rights = log.instances("Right", "c1");
    expect(lefts).toHaveLength(2);
    expect(rights).toHaveLength(2);

    const rows = joinRows(log, new Map([["Left", lefts], ["Right", rights]]));

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      const left = row.get("Left")!;
      const right = row.get("Right")!;
      const shared = [...selfAndAncestorIds(log, left.id)].filter((id) =>
        selfAndAncestorIds(log, right.id).has(id),
      );
      const nearest = shared
        .map((id) => log.instanceById(id)!)
        .sort((a, b) => b.seq - a.seq)[0];
      // The nearest shared ancestor must be an Entity, not the origin.
      expect(nearest.envelope?.node).toBe("extractEntities");
    }
  });

  it("joins an instance with its own descendant — self counts as an ancestor", async () => {
    // bake: allOf[Recipe, Oven] where Recipe comes straight off the origin.
    // ancestors(Recipe) is empty, so a pure-ancestors rule never joins.
    const log = new InMemoryLog();
    await runNetlist(
      originEdgeProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 20 },
    );

    const recipes = log.instances("Recipe", "c1");
    const ovens = log.instances("Oven", "c1");

    const rows = joinRows(log, new Map([["Recipe", recipes], ["Oven", ovens]]));

    expect(rows).toHaveLength(1);
    expect(rows[0].get("Recipe")).toEqual(recipes[0]);
  });

  it("returns nothing when an edge has no candidate", () => {
    const log = new InMemoryLog();
    const a = log.instanceById(log.append("A", "c1", { v: 1 }))!;

    expect(joinRows(log, new Map([["A", [a]], ["B", []]]))).toEqual([]);
  });

  it("zips within a group, leaving ragged leftovers unconsumed", async () => {
    // One entity, two Lefts and two Rights and one Mid: zip depth is 1.
    const log = new InMemoryLog();
    await runNetlist(raggedGroupProgram, { correlationId: "c1", originPayloads: { source: { value: "a" } } }, { log, budget: 40 });

    const rows = joinRows(
      log,
      new Map([
        ["Left", log.instances("Left", "c1")],
        ["Right", log.instances("Right", "c1")],
        ["Mid", log.instances("Mid", "c1")],
      ]),
    );

    expect(rows).toHaveLength(1);
    // Oldest of each edge is taken first.
    expect(rows[0].get("Left")).toEqual(log.instances("Left", "c1")[0]);
  });

  it("still joins a candidate whose nearer ancestor was emptied by an earlier group's claim", async () => {
    // The edge case the review asked to be tested rather than assumed. It IS
    // constructible — see the fixture comment — and the answer is that the
    // stranded candidate still joins at its own nearest common ancestor: the
    // hold only applies when a *peer* instance of the incomplete ancestor's
    // node holds the missing edge, and `stem` fired once, so it has no peer.
    const log = new InMemoryLog();
    await runNetlist(
      claimedAwayProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 20 },
    );

    const lefts = log.instances("Left", "c1");
    const rights = log.instances("Right", "c1");
    const stem = log.instances("Stem", "c1")[0];
    const twigRight = rights.find((r) => (r.payload as { value: string }).value === "twig-right")!;
    // The precondition: the Right that the nearer group claims descends from
    // `Stem`, so claiming it is what leaves `Stem` looking incomplete.
    expect(selfAndAncestorIds(log, twigRight.id).has(stem.id)).toBe(true);

    const rows = joinRows(log, new Map([["Left", lefts], ["Right", rights]]));

    const paired = rows.map(
      (row) =>
        `${(row.get("Left")!.payload as { value: string }).value}+${
          (row.get("Right")!.payload as { value: string }).value
        }`,
    );
    // Nearest group first (Twig), then the leftover Left with the only Right
    // it shares an ancestor with — never held, never mispaired.
    expect(paired).toEqual(["twig-left+twig-right", "stem-left+seed-right"]);
  });

  it("falls back to latest-wins when no candidate has lineage", () => {
    // The no-lineage tier: instances staged into a real Log with no
    // invocation behind them. NOT "as invoke.ts builds" — invoke.ts stages
    // nothing since the membrane started taking the bag as an argument
    // (spec §5), so nothing in production reaches this tier at all.
    const log = new InMemoryLog();
    log.append("A", "c1", { v: 1 });
    const newerA = log.instanceById(log.append("A", "c1", { v: 2 }))!;
    const b = log.instanceById(log.append("B", "c1", { v: 3 }))!;

    const rows = joinRows(
      log,
      new Map([["A", log.instances("A", "c1")], ["B", [b]]]),
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].get("A")).toEqual(newerA);
  });
});
