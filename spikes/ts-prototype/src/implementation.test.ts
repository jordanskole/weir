import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { hashNode } from "./hash.js";
import { resolveImplementation } from "./implementation.js";
import type { AnyEdgeDef, NodeDecl } from "./types.js";

const Person: AnyEdgeDef = {
  name: "Person",
  label: "Person",
  description: "A person",
  fields: { age: { type: "uint8", label: "Age", description: "d", nullable: false } },
};

const birthday: NodeDecl = {
  name: "birthday",
  description: "Increments a person's age by one year",
  input: { kind: "single", edge: Person },
  output: { kind: "single", edge: Person },
};

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("resolveImplementation", () => {
  it("reads {node-name}/<contract-hash>.ts, resolving to a real, callable NodeDef", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-implementation-"));
    const { short } = await hashNode(birthday);
    await mkdir(join(dir, "birthday"), { recursive: true });
    await writeFile(
      join(dir, "birthday", `${short}.ts`),
      `export default function birthday(payload) { return { age: payload.age + 1 }; }\n`,
      "utf8",
    );

    const node = await resolveImplementation(birthday, dir);

    expect(node.name).toBe("birthday");
    expect(node.input).toBe(birthday.input);
    expect(await node.fn({ age: 41 })).toEqual({ age: 42 });
  });

  it("throws a clear error when no implementation exists at the expected contract hash", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-implementation-"));

    await expect(resolveImplementation(birthday, dir)).rejects.toThrow(
      /No accepted implementation for "birthday"/,
    );
  });

  it("throws when the file doesn't default-export a function", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-implementation-"));
    const { short } = await hashNode(birthday);
    await mkdir(join(dir, "birthday"), { recursive: true });
    await writeFile(join(dir, "birthday", `${short}.ts`), `export const notDefault = 1;\n`, "utf8");

    await expect(resolveImplementation(birthday, dir)).rejects.toThrow(/must default-export/);
  });
});
