/**
 * Zones (docs/superpowers/specs/2026-09-28-zones-are-a-line-in-the-topology.md,
 * design.md §7).
 *
 * §7 says zones annotate where a *node* runs, which reads as a field on every
 * `.node`. A zone is a line in the **topology** instead: the unit that already
 * declares where it begins, ends and what it contains also declares where it
 * runs.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elaborate } from "./elaborate.js";
import { crossings, zoneOf } from "./zones.js";
import { plan } from "./plan.js";

const EXAMPLES = fileURLToPath(new URL("../../../examples", import.meta.url));

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function fixture(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-zones-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, content, "utf8");
  }
  return dir;
}

const EDGE = (n: string) =>
  `label: ${n}\ndescription: d\nfields:\n  v:\n    type: utf8\n    label: V\n    description: d\n    nullable: false\n`;
const NODE = (i: string, o: string) =>
  `label: N\ndescription: d\ninput: ${i}\noutput: ${o}\nexamples:\n  - given:\n      ${i}:\n        v: "x"\n    expect:\n      ${o}:\n        v: "x"\n`;

describe("zones — a line in the topology", () => {
  /** Spec Testing #1. */
  it("gives every node in a zoned topology that zone", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "nodes/go.node": NODE("A", "B"),
      "topology/main.topology": `zone: server\ninput: A\noutput: B\nterminals:\n  - go\nwiring:\n  go: {}\n`,
    });

    expect(zoneOf(await elaborate(root))).toEqual({ go: "server" });
  });

  /**
   * Spec Testing #2, and the distinction the whole boundary rule rests on.
   * Unzoned is **not** a zone — a default would manufacture crossings nobody
   * declared.
   *
   * Break-proof: defaulting an absent `zone` to `"default"` in `zoneOf` makes
   * this return `{ go: "default" }`, and then test #7 starts reporting a
   * crossing between two nodes where only one placement was ever stated.
   */
  it("leaves a topology that declares no zone unzoned, not defaulted", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "nodes/go.node": NODE("A", "B"),
      "topology/main.topology": `input: A\noutput: B\nterminals:\n  - go\nwiring:\n  go: {}\n`,
    });

    expect(zoneOf(await elaborate(root))).toEqual({});
  });

  /**
   * Spec Testing #3 — the case the per-topology design rests on. An inlined
   * composite's nodes take the *composite's* zone, not the entry's, which is
   * what makes "this subgraph runs over there" expressible at all.
   */
  it("gives an inlined composite's nodes the composite's zone, not the entry's", async () => {
    const src = join(EXAMPLES, "soc-triage/src");
    const zones = zoneOf(await elaborate(src));

    expect(zones["extractEntities"]).toBe("server");
    expect(zones["investigate/investigateIdentity"]).toBe("third-party");
    expect(zones["investigate/investigateAsset"]).toBe("third-party");
  });

  /**
   * Spec Testing #5 and #6 together, on the real example: `Entity` leaves the
   * server for the third party and the two contexts come back, and nothing
   * inside either zone is a crossing.
   *
   * Break-proof: dropping the `toZone === fromZone` check reports every wired
   * edge as a crossing, including `assembleEvidence -> assess` which is
   * server-to-server.
   */
  it("reports the edges that cross a boundary, and only those", async () => {
    const hops = crossings(await elaborate(join(EXAMPLES, "soc-triage/src")));

    expect(hops.map((h) => `${h.edge} ${h.fromZone}->${h.toZone}`).sort()).toEqual([
      "AssetContext third-party->server",
      "Entity server->third-party",
      "Entity server->third-party",
      "IdentityContext third-party->server",
    ]);
    // Same-zone edges are not hops.
    expect(hops.some((h) => h.from === "assembleEvidence")).toBe(false);
  });

  /**
   * Spec Testing #7. A zoned node feeding an unzoned one is an *undeclared
   * placement*, not a declared boundary — so it is not a crossing. This is the
   * consequence of #2 that would be easy to get wrong in the other direction.
   */
  it("does not report a crossing between a zoned node and an unzoned one", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "edges/C.edge": EDGE("C"),
      "nodes/inner.node": NODE("A", "B"),
      "nodes/after.node": NODE("B", "C"),
      // `inner` is zoned via the composite; `after` sits in an unzoned entry.
      "topology/placed.topology": `zone: client\ninput: A\noutput: B\nterminals:\n  - inner\nwiring:\n  inner: {}\n`,
      "topology/main.topology":
        `input: A\noutput: C\nterminals:\n  - after\nwiring:\n  placed:\n    then:\n      after: {}\n`,
    });
    const program = await elaborate(root);

    expect(zoneOf(program)["placed/inner"]).toBe("client");
    expect(zoneOf(program)["after"]).toBeUndefined();
    expect(crossings(program)).toEqual([]);
  });

  /**
   * The symmetric case, and the one the fixtures did not cover until a
   * break-proof came back green: an **unzoned** node feeding a **zoned** one.
   * Test #7 only exercised zoned→unzoned, so the guard on the producer's side
   * was unreachable and looked load-bearing anyway.
   *
   * Break-proof: dropping `if (fromZone === undefined) continue` reports a
   * crossing here with no `fromZone` — a boundary invented from one declaration.
   */
  it("does not report a crossing between an unzoned node and a zoned one", async () => {
    const root = await fixture({
      "edges/A.edge": EDGE("A"),
      "edges/B.edge": EDGE("B"),
      "edges/C.edge": EDGE("C"),
      "nodes/first.node": NODE("A", "B"),
      "nodes/inner.node": NODE("B", "C"),
      // `first` sits in the unzoned entry and feeds into the zoned composite.
      "topology/placed.topology": `zone: client
input: B
output: C
terminals:
  - inner
wiring:
  inner: {}
`,
      "topology/main.topology":
        `input: A
output: C
terminals:
  - placed
wiring:
  first:
    then:
      placed: {}
`,
    });
    const program = await elaborate(root);

    expect(zoneOf(program)["first"]).toBeUndefined();
    expect(zoneOf(program)["placed/inner"]).toBe("client");
    expect(crossings(program)).toEqual([]);
  });

  /** Spec Testing #8 — §8's last buildable annotation, completing the planner's list. */
  it("annotates a planned route with the crossings it would create", async () => {
    const program = await elaborate(join(EXAMPLES, "soc-triage/src"));

    const routes = plan(program, "Alert", "AlertAssessment");

    expect(routes[0]!.crossings.length).toBeGreaterThan(0);
    expect(routes[0]!.crossings.every((c) => c.fromZone !== c.toZone)).toBe(true);
  });

  it("reports no crossings for a route in an unzoned program", async () => {
    const program = await elaborate(join(EXAMPLES, "recipe/src"));

    expect(plan(program, "Recipe", "Cookies")[0]!.crossings).toEqual([]);
  });

  /** Spec Testing #9 — the guard against an optional key becoming accidentally required. */
  it("still elaborates every example, five of which declare no zone", async () => {
    for (const name of ["recipe", "escalation", "manuscript-review", "soc-triage", "todo-list", "person-birthday"]) {
      await expect(elaborate(join(EXAMPLES, name, "src"))).resolves.toBeDefined();
    }
  });
});
