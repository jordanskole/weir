import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elaborate } from "./elaborate.js";
import { hashNode } from "./hash.js";
import { elaborateWithImplementations, resolveImplementation } from "./implementation.js";
import type { AnyEdgeDef, NodeDecl } from "./types.js";

const PERSON_BIRTHDAY_SRC = fileURLToPath(
  new URL("../../../examples/person-birthday/src", import.meta.url),
);

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

describe("elaborateWithImplementations", () => {
  it("loads declarations and pairs each with its accepted implementation", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-elaborate-with-impl-"));
    const declRoot = join(dir, "declarations");
    const implRoot = join(dir, "implementations");
    await mkdir(join(declRoot, "edges"), { recursive: true });
    await mkdir(join(declRoot, "nodes"), { recursive: true });
    await writeFile(
      join(declRoot, "edges", "Person.edge"),
      `description: A person\nfields:\n  age:\n    type: uint8\n    label: Age\n    description: d\n    nullable: false\n`,
      "utf8",
    );
    await writeFile(
      join(declRoot, "nodes", "birthday.node"),
      `description: Increments a person's age by one year\ninput: Person\noutput: Person\nexamples:\n  - given:\n      Person:\n        age: 41\n    expect:\n      Person:\n        age: 42\n`,
      "utf8",
    );

    const declared = await elaborate(declRoot);
    const { short } = await hashNode(declared.nodes.birthday!);
    await mkdir(join(implRoot, "birthday"), { recursive: true });
    await writeFile(
      join(implRoot, "birthday", `${short}.ts`),
      `export default function birthday(payload) { return { age: payload.age + 1 }; }\n`,
      "utf8",
    );

    const program = await elaborateWithImplementations(declRoot, implRoot);

    expect(Object.keys(program.nodes)).toEqual(["birthday"]);
    expect(await program.nodes.birthday!.fn({ age: 41 })).toEqual({ age: 42 });
  });

  it("goes from the real hand-authored person-birthday declarations to a callable NodeDef", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-elaborate-with-impl-"));
    const declared = await elaborate(PERSON_BIRTHDAY_SRC);

    const birthdayHash = (await hashNode(declared.nodes.birthday!)).short;
    await mkdir(join(dir, "birthday"), { recursive: true });
    await writeFile(
      join(dir, "birthday", `${birthdayHash}.ts`),
      `export default function birthday(payload) { return { age: payload.age + 1 }; }\n`,
      "utf8",
    );

    const expectHash = (await hashNode(declared.nodes.expect_Person_age_42!)).short;
    await mkdir(join(dir, "expect_Person_age_42"), { recursive: true });
    await writeFile(
      join(dir, "expect_Person_age_42", `${expectHash}.ts`),
      `export default function expect_Person_age_42(payload) {
  return payload.age === 42 ? { edge: "Pass", payload: {} } : { edge: "Fail", payload: {} };
}
`,
      "utf8",
    );

    const program = await elaborateWithImplementations(PERSON_BIRTHDAY_SRC, dir);

    expect(await program.nodes.birthday!.fn({ age: 41 })).toEqual({ age: 42 });
    expect(await program.nodes.expect_Person_age_42!.fn({ age: 42 })).toEqual({
      edge: "Pass",
      payload: {},
    });
    expect(await program.nodes.expect_Person_age_42!.fn({ age: 41 })).toEqual({
      edge: "Fail",
      payload: {},
    });
  });
});
