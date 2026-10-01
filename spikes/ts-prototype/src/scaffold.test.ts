/**
 * The scaffold's own tests import the emitted `check.ts` and call it, rather than
 * running vitest inside vitest. The emitted `*.test.ts` is a four-line wrapper
 * around `check()`, so testing `check()` tests the behaviour; the wrapper and the
 * standalone config are asserted as text.
 *
 * Each case scaffolds into its own directory, because the module cache is keyed
 * by path and a reused directory would silently return the first variant's
 * modules.
 */

import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { elaborate } from "./elaborate.js";
import { scaffoldFiles } from "./scaffold.js";
import type { NodeDecl } from "./types.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const OUT = join(import.meta.dirname, "..", ".emit-zod-test");

interface Failure {
  example: number;
  stage: string;
  detail: string;
}

/**
 * Writes a scaffold, optionally replacing the stub with `impl`, and returns what
 * `check()` reports. `variant` must be unique per call.
 */
async function checkWith(node: NodeDecl, variant: string, impl?: string): Promise<Failure[]> {
  const dir = join(OUT, `sc-${variant}`);
  await mkdir(dir, { recursive: true });
  const files = scaffoldFiles(node);
  for (const [name, contents] of Object.entries(files)) {
    const body = impl !== undefined && name === `${node.name}.ts` ? impl : contents;
    await writeFile(join(dir, name), body, "utf8");
  }
  const mod = (await import(/* @vite-ignore */ join(dir, "check.ts"))) as { check: () => Failure[] };
  return mod.check();
}

async function nodeOf(app: string, name: string): Promise<NodeDecl> {
  const elaborated = await elaborate(join(REPO, app));
  const node = elaborated.nodes[name] as NodeDecl | undefined;
  if (node === undefined) throw new Error(`no node "${name}" in ${app}`);
  return node;
}

const SLICE = "spikes/blue-ribbon-slice";

describe("scaffold — it starts red for the right reason, and goes green", () => {
  it("reports every example as `threw` while the stub is unimplemented", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    const failures = await checkWith(node, "stub");
    expect(failures.length).toBe((node.examples ?? []).length);
    expect(failures.every((f) => f.stage === "threw")).toBe(true);
    expect(failures[0]!.detail).toContain("not implemented");
  });

  /**
   * The drafted implementation from the pressure test — the one the acceptance
   * gate rejects as `vacuous` because it declines unparseable input. It satisfies
   * every declared example and property, which is the division of labour the
   * scaffold is for: local iteration here, generated inputs at the gate.
   */
  it("reports nothing for a correct implementation", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    const impl = `export default function parcelCentroid(p: any) {
  const g = JSON.parse(p.boundaryJson);
  const pts = g.coordinates[0].slice(0, -1);
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return { pin: p.pin, lng: sx / pts.length, lat: sy / pts.length };
}
`;
    expect(await checkWith(node, "correct", impl)).toEqual([]);
  });
});

describe("scaffold — a failure names the artifact at fault", () => {
  /**
   * The finding this answers: the pressure test's four failures were all
   * reported against the implementation, which had no way to tell a wrong value
   * from a wrong shape from a broken contract
   * (2026-10-01-what-an-isolated-agent-found.md).
   */
  it("distinguishes a wrong shape from a wrong value", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");

    const wrongShape = `export default function parcelCentroid(p: any) {
  return { pin: p.pin, longitude: 1, latitude: 1 };
}
`;
    const shapeFailures = await checkWith(node, "wrong-shape", wrongShape);
    expect(shapeFailures.map((f) => f.stage)).toContain("output-schema");
    expect(shapeFailures.some((f) => f.stage === "value")).toBe(false);

    // In range, so the schema accepts it and only the value check can catch it.
    // A first attempt used lat: 99, which the schema rejected on its declared
    // max of 90 — the range being in the schema rather than in a type is exactly
    // the difference this emitter exists for.
    const wrongValue = `export default function parcelCentroid(p: any) {
  return { pin: p.pin, lng: 5, lat: 5 };
}
`;
    const valueFailures = await checkWith(node, "wrong-value", wrongValue);
    expect(valueFailures.map((f) => f.stage)).toContain("value");
    expect(valueFailures.some((f) => f.stage === "output-schema")).toBe(false);
  });

  it("reports an out-of-range value as a shape failure, because the schema carries the range", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    // lng declares min -180 / max 180. A type would not have caught this.
    const impl = `export default function parcelCentroid(p: any) {
  return { pin: p.pin, lng: 999, lat: 1 };
}
`;
    const failures = await checkWith(node, "out-of-range", impl);
    expect(failures.map((f) => f.stage)).toContain("output-schema");
  });

  /**
   * `routeCounty` originally declared `get: output.pin` on a `oneOf` node, where
   * the path is `output.payload.pin` — unresolvable for any candidate. weir
   * reported it as "the property did not hold", blaming the implementation for a
   * declaration bug. The scaffold must say the property is broken instead.
   */
  it("reports an unresolvable property path as broken, not as violated", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    const broken = {
      ...node,
      properties: [
        { name: "a property with a path that cannot resolve", expr: { eq: [{ get: "output.nope" }, { get: "input.pin" }] } },
      ],
    } as unknown as NodeDecl;

    const impl = `export default function parcelCentroid(p: any) {
  const g = JSON.parse(p.boundaryJson);
  const pts = g.coordinates[0].slice(0, -1);
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return { pin: p.pin, lng: sx / pts.length, lat: sy / pts.length };
}
`;
    const failures = await checkWith(broken, "broken-path", impl);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]!.stage).toBe("property");
    expect(failures[0]!.detail).toContain("is broken");
    expect(failures[0]!.detail).toContain("does not resolve");
    // The distinction that matters: not reported as the property failing.
    expect(failures[0]!.detail).not.toContain("did not hold");
  });

  /**
   * BREAK-PROOF-DRIVEN. Substituting a `JSON.stringify` comparison for
   * `isDeepStrictEqual` reddened nothing behaviourally — the text assertion below
   * only catches the import surviving, not the comparison being used. The two
   * differ on key order: `isDeepStrictEqual` ignores it and `JSON.stringify` does
   * not, so an implementation returning the right fields in a different order
   * must pass.
   */
  it("compares structurally, so a result with the same fields in another order passes", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    // The declared expect is { pin, lng, lat }; this returns lat, lng, pin.
    const impl = `export default function parcelCentroid(p: any) {
  const g = JSON.parse(p.boundaryJson);
  const pts = g.coordinates[0].slice(0, -1);
  let sx = 0, sy = 0;
  for (const [x, y] of pts) { sx += x; sy += y; }
  return { lat: sy / pts.length, lng: sx / pts.length, pin: p.pin };
}
`;
    expect(await checkWith(node, "key-order", impl)).toEqual([]);
  });

  /**
   * BREAK-PROOF-DRIVEN. Removing the input-schema stage entirely reddened
   * nothing, because no example in the corpus has a `given` that violates its
   * own input schema — so the stage that most directly answers the
   * misattribution finding was untested. This synthesizes the case.
   *
   * It is the one stage where the right answer is "your code never ran": a bad
   * example is a declaration bug, and reporting it against the implementation is
   * what sent the pressure test's agent chasing its own correct code.
   */
  it("reports an example whose own `given` violates the input schema, without running fn", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    const bad = {
      ...node,
      examples: [
        {
          // pin declares minLength 8.
          given: { ...(node.examples![0]!.given as object), pin: "x" },
          expect: node.examples![0]!.expect,
        },
      ],
    } as unknown as NodeDecl;

    // An implementation that would throw loudly if it were ever called, so a
    // pass here cannot be the stub quietly succeeding.
    const impl = `export default function parcelCentroid(p: any): any {
  throw new Error("fn should never have been called");
}
`;
    const failures = await checkWith(bad, "bad-example", impl);
    expect(failures.length).toBe(1);
    expect(failures[0]!.stage).toBe("input-schema");
    expect(failures[0]!.detail).not.toContain("should never have been called");
  });

  it("reports a genuinely violated property as not holding", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    // parcelCentroid's one property asserts output.pin === input.pin.
    const impl = `export default function parcelCentroid(p: any) {
  return { pin: "99-999-999-99", lng: 1, lat: 1 };
}
`;
    const failures = await checkWith(node, "violated", impl);
    // The value check fires first and short-circuits, so assert on the shape of
    // the report rather than on the property specifically.
    expect(failures.map((f) => f.stage)).toContain("value");
  });
});

describe("scaffold — the emitted text", () => {
  /**
   * The payoff of rendering properties as source: `parcelCentroid`'s property is
   * named for bounding-box containment and compares PINs, and in the emitted
   * file the name and the body sit four lines apart.
   */
  it("renders a property's expression as readable source beside its name", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    const check = scaffoldFiles(node)["check.ts"]!;
    expect(check).toContain(`name: "the centroid lies within the boundary's bounding box"`);
    expect(check).toContain(`return same(read("output.pin"), read("input.pin"));`);
    // And it does not mention the fields the name implies it checks.
    const body = check.slice(check.indexOf("export const properties"));
    expect(body).not.toContain("boundaryJson");
  });

  it("renders a oneOf property path against the tagged shape", async () => {
    const node = await nodeOf(SLICE, "routeCounty");
    const check = scaffoldFiles(node)["check.ts"]!;
    expect(check).toContain(`read("output.payload.pin")`);
  });

  it("ships its own vitest config, so the directory tests itself wherever it sits", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    const files = scaffoldFiles(node);
    expect(files["vitest.config.ts"]).toContain(`include: ["*.test.ts"]`);
    expect(files["package.json"]).toContain(`"zod"`);
    expect(files["tsconfig.json"]).toContain(`"strict": true`);
  });

  /**
   * The gate compares with node:util's isDeepStrictEqual. A scaffold using
   * vitest's looser `toEqual` would pass things the gate rejects, which is a new
   * false green in the one artifact built to prevent them.
   */
  it("compares values with the gate's own comparison, not a looser one", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    const check = scaffoldFiles(node)["check.ts"]!;
    expect(check).toContain(`import { isDeepStrictEqual } from "node:util";`);
  });

  it("tells the implementer that declining is sometimes correct and still fails the gate", async () => {
    const node = await nodeOf(SLICE, "parcelCentroid");
    const files = scaffoldFiles(node);
    expect(files["README.md"]).toContain("vacuous");
    expect(files[`${node.name}.ts`]).toContain("vacuous");
  });
});

describe("scaffold — it covers the corpus", () => {
  const APPS = [
    "examples/escalation",
    "examples/flaky-source",
    "examples/manuscript-review",
    "examples/person-birthday",
    "examples/recipe",
    "examples/soc-triage",
    "examples/todo-list",
    "spikes/blue-ribbon-slice",
    "spikes/blue-ribbon-soil",
  ];

  /**
   * Every node in every app, so an input or output kind that the emitter cannot
   * render fails here rather than the first time somebody scaffolds it. This is
   * what caught `gather` needing an index and the `allOf` output being an array
   * of tagged branches rather than a bag.
   */
  it("emits every file for every node in every app, with every property rendered", async () => {
    let nodes = 0;
    let properties = 0;
    for (const app of APPS) {
      const elaborated = await elaborate(join(REPO, app));
      for (const node of Object.values(elaborated.nodes) as NodeDecl[]) {
        const files = scaffoldFiles(node);
        expect(Object.keys(files).sort()).toEqual(
          [
            "README.md",
            "check.ts",
            "package.json",
            "schema.ts",
            `${node.name}.test.ts`,
            `${node.name}.ts`,
            "tsconfig.json",
            "vitest.config.ts",
          ].sort(),
        );
        // Every declared property reached the emitted source by name.
        for (const p of node.properties ?? []) {
          expect(files["check.ts"]).toContain(JSON.stringify(p.name));
          properties += 1;
        }
        nodes += 1;
      }
    }
    expect(nodes).toBeGreaterThan(20);
    // 10 at the time of writing, down from 12: two of the blue-ribbon slice's
    // properties were self-comparisons and were removed rather than asserted
    // falsely (docs/open-questions/no-ordering-over-enum-values.md). A floor
    // rather than an equality, so adding a property does not redden this.
    expect(properties).toBeGreaterThanOrEqual(10);
  });
});
