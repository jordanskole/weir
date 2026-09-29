import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elaborate } from "./elaborate.js";
import { hashNode } from "./hash.js";
import {
  elaborateWithImplementations,
  resolveImplementation,
  resolveImplementationAt,
} from "./implementation.js";
import type { AnyEdgeDef, NodeDecl } from "./types.js";

/** A one-field numeric edge, for the closure tests at the end of this file. */
const Num: AnyEdgeDef = {
  name: "Num",
  label: "Num",
  description: "d",
  fields: { n: { type: "uint8", label: "N", description: "d", nullable: false, validations: { min: 0, max: 255 } } },
};

/**
 * A root `.topology`: its contract plus its wiring, the shape required since
 * docs/superpowers/specs/2026-09-28-a-root-topology-declares-its-end.md.
 * `output`/`terminals` say what finishing looks like; the wiring is indented
 * under `wiring:` exactly as a composite's is.
 */
const rootTopology = (input: string, output: string, terminals: string[], wiring: string): string =>
  `input: ${input}\n` +
  `${output.includes("\n") ? `output:\n${output}` : `output: ${output}\n`}terminals:\n` +
  terminals.map((t) => `  - ${t}\n`).join("") +
  "wiring:\n" +
  wiring
    .split("\n")
    .map((line) => (line.trim() ? `  ${line}` : line))
    .join("\n");


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

describe("resolveImplementationAt", () => {
  it("resolves using a given hash, ignoring what the declaration currently hashes to", async () => {
    dir = await mkdtemp(join(tmpdir(), "weir-implementation-at-"));
    const { hash: hashA, short: shortA } = await hashNode(birthday);
    await mkdir(join(dir, "birthday"), { recursive: true });
    await writeFile(
      join(dir, "birthday", `${shortA}.ts`),
      `export default function birthday(payload) { return { age: payload.age + 1 }; }\n`,
      "utf8",
    );

    // Mutate the declaration (a wider Person edge) so it now hashes to a
    // different value than the file we just wrote for.
    const MutatedPerson: AnyEdgeDef = {
      name: "Person",
      label: "Person",
      description: "A person",
      fields: {
        age: { type: "uint8", label: "Age", description: "d", nullable: false },
        nickname: { type: "utf8", label: "Nickname", description: "d", nullable: true },
      },
    };
    const mutatedBirthday: NodeDecl = {
      ...birthday,
      input: { kind: "single", edge: MutatedPerson },
      output: { kind: "single", edge: MutatedPerson },
    };
    const hashB = (await hashNode(mutatedBirthday)).hash;
    expect(hashB).not.toBe(hashA);

    // resolveImplementationAt, given the OLD hash explicitly, still finds
    // the file — even though `mutatedBirthday` no longer hashes to it.
    const node = await resolveImplementationAt(mutatedBirthday, dir, hashA);
    expect(await node.fn({ age: 41 })).toEqual({ age: 42 });

    // resolveImplementation, which derives the hash from the declaration
    // it's given, fails for that same mutated declaration: no file exists
    // at hash B.
    await expect(resolveImplementation(mutatedBirthday, dir)).rejects.toThrow(
      /No accepted implementation for "birthday"/,
    );
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
      `label: E\ndescription: A person\nfields:\n  age:\n    type: uint8\n    label: Age\n    description: d\n    nullable: false\n`,
      "utf8",
    );
    await writeFile(
      join(declRoot, "nodes", "birthday.node"),
      `label: E\ndescription: Increments a person's age by one year\ninput: Person\noutput: Person\nexamples:\n  - given:\n      Person:\n        age: 41\n    expect:\n      Person:\n        age: 42\n`,
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
      // **Reads the closure rather than hardcoding 42**, which is the whole
      // point of `closure:` existing. Before instantiation shipped, this body
      // had `payload.age === 42` in it and the declared closure was read by
      // nothing — the parameter reached the sealed contract and never reached
      // the function, so the 42 in the declaration and the 42 in the body were
      // two independent facts that happened to agree.
      `export default (closure) => function expect_Person_age_42(payload) {
  return payload.age === closure.expected.Person.age
    ? { edge: "Pass", payload: {} }
    : { edge: "Fail", payload: {} };
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
    expect(program.wiring.origins).toEqual(["birthday"]);
    expect(program.wiring.feeds).toEqual({ birthday: ["expect_Person_age_42"] });
  });
});

describe("resolveImplementationAt — the missing-file guard", () => {
  /**
   * The guard is an explicit `existsSync`, not an inference from `import()`
   * throwing, and this test pins which of the two fired.
   *
   * `import()` caches by URL, so a file that was loaded and has since been
   * deleted still resolves — the second import never touches the filesystem.
   * That made `replay.test.ts`'s "no file on disk" case pass on Node 26 and
   * fail on Node 24 (CI's pinned version), since the two differ in when a
   * stripped-TypeScript module is re-read. A version-dependent test is not a
   * test.
   *
   * Asserting the message alone would not distinguish the two paths, because
   * the old code produced the same message from its import-catch. The
   * discriminator is `cause`: the guard throws without one, because it never
   * attempted the import. That holds on every Node version, whether or not
   * the module happens to still be cached.
   */
  it("throws before importing, so a deleted-but-cached module cannot resolve", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-impl-guard-"));
    try {
      const node: NodeDecl = {
        name: "passthrough",
        label: "P",
        description: "d",
        input: { kind: "single", edge: Person },
        output: { kind: "single", edge: Person },
      };
      const { short, hash } = await hashNode(node);
      await mkdir(join(dir, "passthrough"), { recursive: true });
      const path = join(dir, "passthrough", `${short}.ts`);
      await writeFile(path, `export default function passthrough(p) { return p; }\n`, "utf8");

      // Load it, so the module is in the ESM cache.
      const loaded = await resolveImplementationAt(node, dir, hash);
      expect(typeof loaded.fn).toBe("function");

      await rm(path);

      let thrown: Error | undefined;
      try {
        await resolveImplementationAt(node, dir, hash);
      } catch (error) {
        thrown = error as Error;
      }

      expect(thrown).toBeDefined();
      expect(thrown!.message).toContain(`No accepted implementation for "passthrough"`);
      // No cause: the guard fired, rather than an import failing. This is
      // the assertion that survives a Node upgrade.
      expect((thrown as Error & { cause?: unknown }).cause).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("resolveImplementation — a closure is closed over", () => {
  /**
   * `closure` is "parameters baked in at elaboration time", and before
   * instantiation shipped it was parsed, fingerprinted and exported in the
   * sealed contract while being read by **nothing** — it appeared in no runtime
   * module at all. The parameter reached the drafting agent and never reached
   * the function (2026-09-29-instantiation.md §1).
   *
   * Break-proof: dropping the `node.closure !== undefined` branch in
   * `resolveImplementationAt` makes `fn` the *un-applied* function, so calling
   * it returns another function rather than a payload and the first assertion
   * reddens with a function where an object was expected.
   */
  it("applies the closure at resolution, so the runtime holds an ordinary Fn", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-closure-"));
    try {
      const node = {
        name: "scale",
        input: { kind: "single" as const, edge: Num },
        output: { kind: "single" as const, edge: Num },
        closure: { factor: 3 },
        examples: [{ given: { n: 2 }, expect: { n: 6 } }],
      };
      const short = (await hashNode(node as never)).short;
      await mkdir(join(dir, "scale"), { recursive: true });
      await writeFile(
        join(dir, "scale", `${short}.ts`),
        `export default (closure) => (payload) => ({ n: payload.n * closure.factor });\n`,
        "utf8",
      );

      const resolved = await resolveImplementation(node as never, dir);

      expect(await resolved.fn({ n: 2 } as never)).toEqual({ n: 6 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The failure mode a reader will actually hit: exporting the plain `Fn` for a
   * node that declares a closure. Worth a named error rather than a confusing
   * downstream one, because the un-applied function is *callable* — it would
   * otherwise fail later, inside the membrane, as a payload that is somehow a
   * function.
   *
   * Break-proof: removing the `typeof applied !== "function"` check lets this
   * resolve, and the error surfaces much later as an output-assertion failure
   * naming the wrong thing entirely.
   */
  it("says so when a closured node exports a plain Fn instead of a function of the closure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-closure-"));
    try {
      const node = {
        name: "scale",
        input: { kind: "single" as const, edge: Num },
        output: { kind: "single" as const, edge: Num },
        closure: { factor: 3 },
        examples: [{ given: { n: 2 }, expect: { n: 6 } }],
      };
      const short = (await hashNode(node as never)).short;
      await mkdir(join(dir, "scale"), { recursive: true });
      await writeFile(
        join(dir, "scale", `${short}.ts`),
        `export default (payload) => ({ n: payload.n * 3 });\n`,
        "utf8",
      );

      await expect(resolveImplementation(node as never, dir)).rejects.toThrow(/function OF the closure/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The closure is already fingerprinted — this is not new behaviour, it is the
   * property the whole `for:` table rests on, pinned here because instantiation
   * would be unsound without it. Two parameterizations must be two contracts,
   * or one accepted implementation would serve both and the gate would have
   * checked only one.
   */
  it("gives two parameterizations two different contract hashes", async () => {
    const base = {
      name: "scale",
      input: { kind: "single" as const, edge: Num },
      output: { kind: "single" as const, edge: Num },
    };
    const three = await hashNode({ ...base, closure: { factor: 3 } } as never);
    const four = await hashNode({ ...base, closure: { factor: 4 } } as never);

    expect(three.hash).not.toBe(four.hash);
  });
});
