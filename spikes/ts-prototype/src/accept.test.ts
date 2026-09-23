import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acceptImplementation } from "./accept.js";
import { defineEdge, defineField } from "./define.js";
import { hashNode } from "./hash.js";
import { resolveImplementation } from "./implementation.js";
import * as metadataModule from "./metadata.js";
import type { NodeDecl } from "./types.js";

const Person = defineEdge({
  name: "Person",
  label: "Person",
  description: "A person",
  fields: { age: defineField({ type: "uint8", label: "Age", description: "Age in years", nullable: false }) },
});

const Pet = defineEdge({
  name: "Pet",
  label: "Pet",
  description: "A pet",
  fields: { species: defineField({ type: "utf8", label: "Species", description: "d", nullable: false }) },
});

const birthday: NodeDecl = {
  name: "birthday",
  description: "Increments a person's age by one year",
  input: { kind: "single", edge: Person },
  output: { kind: "single", edge: Person },
  examples: [{ given: { age: 41 }, expect: { age: 42 } }],
};

const CORRECT = `export default function birthday(payload) {
  return { age: payload.age + 1 };
}
`;

/** Right for the declared example, wrong for everything else — fails fuzzing only. */
const EXAMPLE_ONLY = `export default function birthday(payload) {
  if (payload.age === 41) return { age: 42 };
  return { nope: true };
}
`;

/**
 * Hardcodes the declared example, and is a valid Person everywhere else —
 * so it passes its examples and every structural check, and only the
 * property catches it. The case §6's "the implementing agent can see the
 * test" argument is actually about.
 */
const GAMES_THE_EXAMPLE = `export default function birthday(payload) {
  if (payload.age === 41) return { age: 42 };
  return { age: payload.age };
}
`;

/** Wrong shape for every input — fails the example and fuzzing together. */
const ALWAYS_WRONG = `export default function birthday() {
  return { nope: true };
}
`;

/**
 * Imports one of the spike's own real dependencies at module scope — the
 * probe for Finding 3: a draft checked from the OS temp dir can't resolve
 * this bare specifier back to the project's node_modules, while the
 * identical bytes resolve fine once persisted under implRoot (which lives
 * inside the project). Drafting under implRoot closes that gap. Requires
 * implRoot itself to live somewhere whose ancestry actually reaches this
 * project's node_modules — see SPIKE_ROOT below.
 */
const IMPORTS_A_DEPENDENCY = `import { parse } from "yaml";
export default function birthday(payload) {
  parse("age: 1");
  return { age: payload.age + 1 };
}
`;

/**
 * spikes/ts-prototype/ itself — the ancestor a bare `import "yaml"` can
 * actually resolve through (its node_modules). An implRoot under the OS
 * temp dir, as most of this file's other tests use for disposability,
 * would prove nothing for Finding 3's test: it's not on the resolution
 * path to this project's node_modules either way, before or after the fix.
 */
const SPIKE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
  vi.restoreAllMocks();
});

/**
 * Counts draft directories (the `.drafts-` prefix `acceptImplementation`
 * mkdtemps under implRoot — Finding 3) anywhere under `root`, recursively,
 * since a test may pass several distinct implRoots that nest inside one
 * scratch `dir`. Every caller asserts a before/after *delta*, not a bare
 * count, even though `root` itself is a fresh scratch directory each time
 * and the count is 0 before either snapshot: `root`'s own name (this file's
 * `weir-accept-test-` prefix) doesn't collide with `.drafts-` today, but
 * the delta form is what makes that fact not load-bearing — if `root`'s own
 * naming convention ever did collide, or a future caller reused a
 * non-empty `root`, both snapshots would include it identically and it
 * would cancel out either way, rather than this test silently measuring
 * something other than "how many draft directories did this call leave
 * behind."
 */
async function draftDirCount(root: string): Promise<number> {
  let count = 0;
  async function walk(path: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(path, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith(".drafts-")) count += 1;
      await walk(join(path, entry.name));
    }
  }
  await walk(root);
  return count;
}

describe("acceptImplementation", () => {
  it("accepts a candidate that passes its examples and generated cases, writing the impl and its metadata", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    const { short } = await hashNode(birthday);

    const result = await acceptImplementation(birthday, CORRECT, dir, { count: 20 });

    expect(result).toEqual({
      accepted: true,
      path: join(dir, "birthday", `${short}.ts`),
      metadataPath: join(dir, "birthday", `${short}.meta.json`),
    });
    expect(await readFile(join(dir, "birthday", `${short}.ts`), "utf8")).toBe(CORRECT);
    expect(JSON.parse(await readFile(join(dir, "birthday", `${short}.meta.json`), "utf8"))).toEqual({
      lines: 3,
      complexity: 1,
    });
  });

  it("the accepted file is readable back by resolveImplementation — the seam's two halves agree", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    await acceptImplementation(birthday, CORRECT, dir, { count: 20 });

    const node = await resolveImplementation(birthday, dir);

    expect(await node.fn({ age: 41 })).toEqual({ age: 42 });
  });

  it("rejects a candidate that fails a declared example, reporting given/expected/actual", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    const noIncrement = `export default function birthday(payload) {\n  return { age: payload.age };\n}\n`;

    const result = await acceptImplementation(birthday, noIncrement, dir, { count: 20 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    expect(result.reason).toBe("checks-failed");
    if (result.reason !== "checks-failed") throw new Error("unreachable");
    expect(result.exampleFailures).toEqual([{ given: { age: 41 }, expected: { age: 42 }, actual: { age: 41 } }]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects a candidate that passes its example but fails generated cases", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));

    const result = await acceptImplementation(birthday, EXAMPLE_ONLY, dir, { count: 20 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    if (result.reason !== "checks-failed") throw new Error("unreachable");
    expect(result.exampleFailures).toEqual([]);
    expect(result.fuzzReport.failures.length).toBeGreaterThan(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it("reports both example and generated-case failures together, never short-circuiting", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));

    const result = await acceptImplementation(birthday, ALWAYS_WRONG, dir, { count: 20 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    if (result.reason !== "checks-failed") throw new Error("unreachable");
    expect(result.exampleFailures.length).toBe(1);
    expect(result.fuzzReport.failures.length).toBeGreaterThan(0);
  });

  it("rejects a candidate that doesn't parse", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));

    const result = await acceptImplementation(birthday, `export default function (`, dir, { count: 5 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    expect(result.reason).toBe("load-failed");
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects a candidate that doesn't default-export a function", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));

    const result = await acceptImplementation(birthday, `export const notDefault = 1;\n`, dir, { count: 5 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    expect(result.reason).toBe("load-failed");
    if (result.reason !== "load-failed") throw new Error("unreachable");
    expect(result.error).toMatch(/default-export/);
  });

  it("throws rather than overwriting when this contract hash already has an accepted implementation", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    const { short } = await hashNode(birthday);
    await acceptImplementation(birthday, CORRECT, dir, { count: 20 });

    await expect(acceptImplementation(birthday, CORRECT, dir, { count: 20 })).rejects.toThrow(
      new RegExp(`birthday.*${short}`, "s"),
    );
  });

  it("leaves no draft directory behind, on acceptance or rejection", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    const before = await draftDirCount(dir);

    await acceptImplementation(birthday, CORRECT, dir, { count: 5 });
    await acceptImplementation(birthday, ALWAYS_WRONG, join(dir, "other"), { count: 5 });
    await acceptImplementation(birthday, `export default function (`, join(dir, "third"), { count: 5 });

    expect(await draftDirCount(dir)).toBe(before);
  });

  it("checks a candidate that imports one of the spike's own dependencies — same resolution context it will run in (Finding 3)", async () => {
    dir = join(SPIKE_ROOT, `.finding3-implroot-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    const result = await acceptImplementation(birthday, IMPORTS_A_DEPENDENCY, dir, { count: 5 });

    expect(result.accepted).toBe(true);
  });

  it("computes metadata before persisting, so a metadata failure leaves nothing written (Finding 4)", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    vi.spyOn(metadataModule, "computeImplementationMetadata").mockImplementationOnce(() => {
      throw new Error("metadata boom");
    });

    await expect(acceptImplementation(birthday, CORRECT, dir, { count: 5 })).rejects.toThrow("metadata boom");
    expect(await readdir(dir)).toEqual([]);
  });

  describe("declaring no examples (Finding 1)", () => {
    it("throws rather than accepting when a node declares no examples key at all", async () => {
      dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
      const { examples: _examples, ...withoutExamples } = birthday;
      const noExamples = withoutExamples as NodeDecl;

      await expect(acceptImplementation(noExamples, CORRECT, dir, { count: 5 })).rejects.toThrow(/example/i);
      expect(await readdir(dir)).toEqual([]);
    });

    it("throws rather than accepting when a node declares an empty examples array", async () => {
      dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
      const emptyExamples: NodeDecl = { ...birthday, examples: [] };

      await expect(acceptImplementation(emptyExamples, CORRECT, dir, { count: 5 })).rejects.toThrow(/example/i);
      expect(await readdir(dir)).toEqual([]);
    });

    it("would otherwise accept literally anything — a candidate that always throws — proving the defect this closes", async () => {
      dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
      const { examples: _examples, ...withoutExamples } = birthday;
      const noExamples = withoutExamples as NodeDecl;
      const alwaysThrows = `export default function () {\n  throw new Error("always broken");\n}\n`;

      // Before the fix this resolved `{ accepted: true, ... }`; now it must throw.
      await expect(acceptImplementation(noExamples, alwaysThrows, dir, { count: 10 })).rejects.toThrow();
    });
  });

  it("rejects a malformed allOf example (given: null) as an ExampleFailure rather than crashing (Finding 2)", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    const combine: NodeDecl = {
      name: "combine",
      description: "Combines a person and a pet",
      input: { kind: "allOf", edges: [Person, Pet] },
      output: { kind: "single", edge: Person },
      // A malformed example: `given` is null (what an author writing `given:`
      // with nothing after it in YAML actually parses to).
      examples: [{ given: null, expect: { age: 7 } }],
    };
    const combineImpl = `export default function combine() {\n  return { age: 7 };\n}\n`;

    const result = await acceptImplementation(combine, combineImpl, dir, { count: 5 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    expect(result.reason).toBe("checks-failed");
    if (result.reason !== "checks-failed") throw new Error("unreachable");
    expect(result.exampleFailures).toEqual([{ given: null, expected: { age: 7 }, actual: undefined }]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("propagates fuzzNode's own throw (a many output declaring no index) and still leaves implRoot empty (Finding 7)", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    const manyNoIndex: NodeDecl = {
      name: "manyNoIndex",
      description: "A many output whose edge declares no index — a declaration defect, not a candidate verdict",
      input: { kind: "single", edge: Person },
      output: { kind: "many", edge: Person },
      examples: [{ given: { age: 41 }, expect: { age: 42 } }],
    };

    await expect(acceptImplementation(manyNoIndex, CORRECT, dir, { count: 5 })).rejects.toThrow(/index/);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("acceptImplementation — properties", () => {
  const withProperty: NodeDecl = {
    ...birthday,
    properties: [
      {
        name: "increments age by one",
        description: "A birthday advances the person's age by exactly one year.",
        expr: { eq: [{ get: "output.age" }, { add: [{ get: "input.age" }, { lit: 1 }] }] },
      },
    ],
  };

  it("accepts a candidate that satisfies its property", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));

    const result = await acceptImplementation(withProperty, CORRECT, dir, { count: 20 });

    expect(result.accepted).toBe(true);
  });

  it("rejects a candidate that violates its property, persisting nothing", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    const noIncrement = `export default function birthday(payload) {\n  return { age: payload.age };\n}\n`;

    const result = await acceptImplementation(withProperty, noIncrement, dir, { count: 20 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    if (result.reason !== "checks-failed") throw new Error("unreachable");
    expect(result.fuzzReport.propertyFailures.length).toBeGreaterThan(0);
    expect(await readdir(dir)).toEqual([]);
  });

  it("rejects the candidate that games its example — the case properties exist for", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));

    // GAMES_THE_EXAMPLE hardcodes the declared example and is a valid
    // Person for every other input too — it passes its examples and every
    // structural check. Nothing but the property catches it: that's the
    // whole point of this test.
    const result = await acceptImplementation(withProperty, GAMES_THE_EXAMPLE, dir, { count: 20 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    if (result.reason !== "checks-failed") throw new Error("unreachable");
    expect(result.exampleFailures).toEqual([]);
    expect(result.fuzzReport.failures).toEqual([]);
    expect(result.fuzzReport.propertyFailures.length).toBeGreaterThan(0);
    expect(result.vacuous).toBe(false);
  });

  it("rejects as vacuous when a node declares properties but no case produced a real output", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    const alwaysThrows = `export default function birthday() {\n  throw new Error("always broken");\n}\n`;

    const result = await acceptImplementation(withProperty, alwaysThrows, dir, { count: 20 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    if (result.reason !== "checks-failed") throw new Error("unreachable");
    expect(result.vacuous).toBe(true);
    expect(result.fuzzReport.realOutputs).toBe(0);
    expect(result.fuzzReport.propertyFailures).toEqual([]);
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not apply the vacuity guard to a node that declares no properties", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-accept-test-"));
    const alwaysThrows = `export default function birthday() {\n  throw new Error("always broken");\n}\n`;

    // No properties declared, so there is nothing to be vacuous about —
    // this is rejected on its example, not on the guard.
    const result = await acceptImplementation(birthday, alwaysThrows, dir, { count: 20 });

    expect(result.accepted).toBe(false);
    if (result.accepted) throw new Error("unreachable");
    if (result.reason !== "checks-failed") throw new Error("unreachable");
    expect(result.vacuous).toBe(false);
    expect(result.exampleFailures.length).toBe(1);
  });
});
