/**
 * The `sys` queries
 * (docs/superpowers/specs/2026-09-28-the-sys-queries.md, design.md §8).
 *
 * The readme promises five queries over the topology and ontology and until now
 * shipped none. These are the static ones — everything answerable from the
 * declarations, with no implementations and no run.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elaborate } from "./elaborate.js";
import { analyze, mediation, orphans, refinements } from "./sys.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples", import.meta.url));
const example = (name: string) => elaborate(join(EXAMPLES, name, "src"));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fixture(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-sys-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

const EDGE = (name: string) =>
  `label: ${name}\ndescription: d\nfields:\n  v:\n    type: utf8\n    label: V\n    description: d\n    nullable: false\n`;
const NODE = (input: string, output: string) =>
  `label: N\ndescription: d\ninput: ${input}\noutput: ${output}\nexamples:\n  - given:\n      ${input}:\n        v: "x"\n    expect:\n      ${output}:\n        v: "x"\n`;

describe("sys — refines", () => {
  /**
   * Spec Testing #1. `design.md` §2's canonical shape: a node that makes a
   * branching decision emits distinct edges, and those edges refine its input.
   */
  it("reports a oneOf output's branches as refinements of the node's input", async () => {
    const found = refinements(await example("person-birthday"));

    expect(found).toEqual([
      { edge: "Fail", refines: "Person", by: "expect_Person_age_42" },
      { edge: "Pass", refines: "Person", by: "expect_Person_age_42" },
    ]);
  });

  /**
   * Spec Testing #1, the exclusion the narrow definition exists for. `many` is
   * **cardinality**: an `Entity` is not a refinement of an `Alert`, and a
   * relation that said so would put a wrong edge in the ontology.
   *
   * Break-proof: widening `refinements` to treat a `many` output as refinement
   * reports `Entity refines Alert`, which reddens this.
   */
  it("reports nothing for a many output — cardinality is not a decision", async () => {
    const found = refinements(await example("soc-triage"));

    expect(found.map((r) => r.edge)).not.toContain("Entity");
    expect(found).toEqual([]);
  });

  /** Spec Testing #2. `allOf` output is fission — every branch fires, so nothing was decided. */
  it("reports nothing for an allOf output", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/L.edge": EDGE("L"),
      "edges/R.edge": EDGE("R"),
      "nodes/split.node":
        `label: S\ndescription: d\ninput: A\noutput:\n  allOf:\n    - L\n    - R\n` +
        `examples:\n  - given:\n      A:\n        v: "x"\n    expect:\n      L:\n        v: "x"\n      R:\n        v: "x"\n`,
      "topology/main.topology": `input: A\noutput:\n  allOf:\n    - L\n    - R\nterminals:\n  - split\nwiring:\n  split: {}\n`,
    });

    expect(refinements(await elaborate(root))).toEqual([]);
  });
});

describe("sys — orphans", () => {
  /**
   * Spec Testing #3, and a real finding: `PersonWithAddress` is declared in
   * `examples/person-birthday` and nothing produces, consumes or embeds it.
   */
  it("reports an edge nothing produces, consumes or embeds", async () => {
    const found = orphans(await example("person-birthday"));

    expect(found).toEqual([{ edge: "PersonWithAddress", kind: "orphaned", producedBy: [] }]);
  });

  /**
   * **The false positive this query shipped with for about ten minutes.** The
   * first version reported `Address` too — but `PersonWithAddress` embeds it as
   * a compound field, so it is part of the ontology without ever crossing a
   * wire.
   *
   * And the over-correction was worse: counting *every* edge's nested references
   * includes synthesized `Failed_X`, which embeds `X` by construction — so
   * nothing was ever orphaned and the findings list went empty, which reads
   * exactly like a clean program.
   *
   * Break-proof, both directions: dropping the nested-reference check reports
   * `Address`; dropping the `Failed_*` skip inside it reports nothing at all.
   * This test fails on both.
   */
  it("does not report an edge embedded in another edge, and is not disabled by synthesized failure edges", async () => {
    const found = orphans(await example("person-birthday"));

    expect(found.map((o) => o.edge)).not.toContain("Address");
    expect(found).toHaveLength(1);
  });

  /**
   * **The second false positive, found on the first real program pointed at
   * `weir sys`.** A `"...Name":` spread *copies* the source's fields rather than
   * embedding the source, so after elaboration the source is a declared edge
   * that nothing produces, consumes or nests — indistinguishable from dead
   * weight, and duly reported as orphaned. It exists precisely to be spread.
   *
   * Break-proof, both directions, which is the lesson the `Address`
   * over-correction above taught: dropping the `spreadSources` check reports
   * `Meta`, and the second assertion is what stops the fix from being another
   * blanket disable — `Dead` is spread from nothing and must still be found.
   */
  it("does not report an edge another edge spreads its fields from, and still finds a real orphan", async () => {
    const root = await fixture({
      "edges/Meta.edge": EDGE("Meta"),
      "edges/Dead.edge": EDGE("Dead"),
      "edges/A.edge": EDGE("A"),
      "edges/Answer.edge":
        `label: Answer\ndescription: d\nfields:\n  "...Meta":\n`,
      "nodes/go.node": NODE("A", "Answer"),
      "topology/main.topology": `input: A\noutput: Answer\nterminals:\n  - go\nwiring:\n  go: {}\n`,
    });

    const found = orphans(await elaborate(root)).map((o) => o.edge);

    expect(found).not.toContain("Meta");
    expect(found).toContain("Dead");
  });

  /**
   * Spec Testing #4 — the query that was impossible before topologies declared
   * their terminals. A produced-and-unconsumed edge is either the answer or a
   * drop, and nothing could tell them apart.
   *
   * Break-proof: removing the `answers` check reports `Cookies` as dropped,
   * which would make the query fire on every healthy program.
   */
  it("distinguishes a dropped output from the declared terminal one", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/Answer.edge": EDGE("Answer"),
      "edges/Litter.edge": EDGE("Litter"),
      "nodes/go.node": NODE("A", "Answer"),
      "nodes/aside.node": NODE("A", "Litter"),
      "topology/main.topology":
        `input: A\noutput: Answer\nterminals:\n  - go\nwiring:\n  go: {}\n  aside: {}\n`,
    });

    const found = orphans(await elaborate(root));

    // `Answer` is unconsumed and *is* the declared end, so it is not a finding.
    expect(found).toEqual([{ edge: "Litter", kind: "dropped", producedBy: ["aside"] }]);
  });

  /**
   * Spec Testing #5. Every node can emit a `Failed_*`, so unrouted ones are the
   * norm — in `soc-triage` they are nine of sixteen edges, and listing them
   * would bury the seven the program is about.
   */
  it("does not report unrouted Failed_* edges, and counts them instead", async () => {
    const report = analyze(await example("soc-triage"));

    expect(report.orphans).toEqual([]);
    expect(report.unroutedFailureEdges).toBeGreaterThan(5);
    expect(report.edges.map((e) => e.edge)).not.toContain("Failed_Alert");
  });

  /**
   * Not in the spec — found running the query. A composite's inner nodes survive
   * inlining under *both* the qualified key that is wired and the original that
   * is not, so counting both reported two producers for every edge a composite
   * touches, one of which is not in the program.
   *
   * Break-proof: using `program.nodes` instead of `wiredNodes` reports
   * `investigateAsset` alongside `investigate/investigateAsset`.
   */
  it("attributes an edge only to the node actually wired, not to an inlined composite's leftover", async () => {
    const report = analyze(await example("soc-triage"));
    const asset = report.edges.find((e) => e.edge === "AssetContext")!;

    expect(asset.producedBy).toEqual(["investigate/investigateAsset"]);
    // And the leftover is not reported as declared-but-unwired either: it is the
    // same node under a qualified key, so saying so would be noise with a
    // plausible-looking cause.
    expect(report.unwiredNodes).toEqual([]);
  });
});

describe("sys — mediation", () => {
  /**
   * Spec Testing #6. `assembleEvidence` sits on the only route from the origin
   * to the terminal, which is the shape `design.md` §7's type-gate argument
   * assumes — *"only `authorize` mints an `AuthorizedPayment`"* — now answerable
   * rather than checked by reading.
   */
  it("finds a node every route crosses, and reports no bypass", async () => {
    const result = mediation(await example("soc-triage"), "assembleEvidence");

    expect(result.mediates).toEqual([{ origin: "extractEntities", terminal: "summarizeAlert" }]);
    expect(result.bypasses).toEqual([]);
  });

  /**
   * Spec Testing #7. `examples/recipe` has two origins and a diamond, so `mix`
   * mediates its own route and `preheatOven` reaches the terminal without it.
   *
   * Break-proof: dropping the `without` argument from `reachableFrom` makes
   * every pair a bypass and `mediates` empty.
   */
  it("finds a bypass where another arm reaches the terminal without the node", async () => {
    const result = mediation(await example("recipe"), "mix");

    expect(result.mediates).toEqual([{ origin: "mix", terminal: "cool" }]);
    expect(result.bypasses).toEqual([{ origin: "preheatOven", terminal: "cool" }]);
  });
});

describe("sys — the whole corpus", () => {
  /**
   * Spec Testing #8. The guard against an analysis that only works on the shape
   * it was written against — every example answers every query without throwing,
   * across spread, gather, cycles, composites and two origins.
   */
  it("answers every query for every example", async () => {
    for (const name of ["recipe", "escalation", "manuscript-review", "soc-triage", "todo-list", "person-birthday"]) {
      const program = await example(name);
      const report = analyze(program);
      expect(report.edges.length).toBeGreaterThan(0);
      for (const node of Object.keys(program.nodes)) {
        expect(() => mediation(program, node)).not.toThrow();
      }
    }
  });
});

/**
 * `decorativeIndexes` — an `index` nothing keys a collection on.
 *
 * `index` does work in exactly three places: a `many` field, a `gather` input and a
 * `many` output. Declared anywhere else it is documentation, and a
 * declared-but-unused key reads as *the* identity — which is what invited packing a
 * composite into `manuscript-review`'s `Revision.id`, putting the round in a `utf8`
 * suffix beside the `uint8` field that already held it
 * (docs/open-questions/index-names-one-field.md).
 */
describe("sys — an index that is never a collection key", () => {
  /**
   * BREAK-PROOF: dropping the `gather` branch from `collectionKeyed` reddens the
   * soc-triage case; dropping the `many`-field walk reddens recipe and todo-list;
   * dropping the `many`-output branch reddens blue-ribbon-soil.
   */
  it("reports an index on an edge no collection keys on, and nothing else", async () => {
    const elaborated = await elaborate(join(EXAMPLES, "escalation"));
    const report = analyze(elaborated);
    expect(report.uncheckedIndexes).toEqual([{ edge: "Ticket", index: "id" }]);
  });

  /**
   * The guard that makes the above mean something: an edge that IS a collection
   * element must not be reported, however it is collected. Without this, a function
   * that reported every `index` would pass the test above.
   */
  it("stays silent for every edge that is genuinely a collection key", async () => {
    for (const app of [
      join(EXAMPLES, "recipe"),
      join(EXAMPLES, "soc-triage"),
      join(EXAMPLES, "flaky-source"),
      join(EXAMPLES, "person-birthday"),
    ]) {
      const elaborated = await elaborate(app);
      const report = analyze(elaborated);
      expect(report.uncheckedIndexes, app).toEqual([]);
    }
  });

  /**
   * blue-ribbon-soil is the case that corrected the framing. `SoilPolygonShape`
   * declares `index: polygonId`, and `parseSoilPolygon` outputs it singly while
   * `measureSoilPolygon` consumes it singly — so nothing keys on it, and it is
   * reported. But its instances multiply (one per spread element), so the index is a
   * real natural key and declaring it is right. That is why this is information
   * rather than a finding of waste.
   */
  it("reports a natural key on a spread element too, which is why it is not called waste", async () => {
    const elaborated = await elaborate(join(EXAMPLES, "..", "spikes", "blue-ribbon-soil"));
    expect(analyze(elaborated).uncheckedIndexes).toEqual([
      { edge: "SoilPolygonShape", index: "polygonId" },
    ]);
  });

  it("finds the Revision.id case that prompted it", async () => {
    const elaborated = await elaborate(join(EXAMPLES, "manuscript-review"));
    expect(analyze(elaborated).uncheckedIndexes).toEqual([{ edge: "Revision", index: "id" }]);
  });

  /**
   * A finding, not an error. `weir check` must stay green on both apps that have
   * one — declaring an index you do not key on is untidy and not wrong, and failing
   * elaboration over it would break working programs.
   */
  it("does not make the program fail to elaborate", async () => {
    for (const app of [join(EXAMPLES, "escalation"), join(EXAMPLES, "manuscript-review")]) {
      await expect(elaborate(app)).resolves.toBeDefined();
    }
  });
});
