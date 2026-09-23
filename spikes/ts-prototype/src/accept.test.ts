import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acceptImplementation } from "./accept.js";
import { defineEdge, defineField } from "./define.js";
import { hashNode } from "./hash.js";
import { resolveImplementation } from "./implementation.js";
import type { NodeDecl } from "./types.js";

const Person = defineEdge({
  name: "Person",
  label: "Person",
  description: "A person",
  fields: { age: defineField({ type: "uint8", label: "Age", description: "Age in years", nullable: false }) },
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

/** Wrong shape for every input — fails the example and fuzzing together. */
const ALWAYS_WRONG = `export default function birthday() {
  return { nope: true };
}
`;

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function draftDirCount(): Promise<number> {
  const entries = await readdir(tmpdir());
  return entries.filter((e) => e.startsWith("weir-accept-")).length;
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
    const before = await draftDirCount();

    await acceptImplementation(birthday, CORRECT, dir, { count: 5 });
    await acceptImplementation(birthday, ALWAYS_WRONG, join(dir, "other"), { count: 5 });
    await acceptImplementation(birthday, `export default function (`, join(dir, "third"), { count: 5 });

    expect(await draftDirCount()).toBe(before);
  });
});
