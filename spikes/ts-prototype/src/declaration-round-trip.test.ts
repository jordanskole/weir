/**
 * Every key on a node's declaration can actually be declared.
 *
 * **Written after the third defect of one shape in two days.** `closure` was
 * parsed and fingerprinted and read by nothing. The drift spec's `undeclared`
 * values were recorded nowhere on the path that needed them. And `scope` was
 * typed, fingerprinted and documented in `design.md` §6 while `nodeSchema` had
 * no `scope` key at all, so writing one in a `.node` file produced *"has unknown
 * key"* — it was reachable only from a programmatically constructed `NodeDef`,
 * which in this repo meant tests.
 *
 * The common cause is structural rather than careless. A declaration key gets
 * added to the **type** and to the **hash** in one edit, because those are
 * adjacent concerns and both are obviously necessary. The **schema** and the
 * **parser** are a separate edit that nothing forces, and the gap is invisible
 * until some feature needs the key end to end — which for `scope` was three
 * months.
 *
 * So this reads `NodeDef`'s properties out of `types.ts` with the TypeScript
 * AST rather than listing them, because a hardcoded list is the same bug in a
 * new place: nobody updates it either.
 *
 * `tsconfig.json` excludes `src/**\/*.test.ts`, so nothing here is typechecked.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { elaborate } from "./elaborate.js";
import { fieldSchema, nodeSchema } from "./schema.js";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TYPES = fileURLToPath(new URL("./types.ts", import.meta.url));

/**
 * Keys that legitimately cannot appear in a `.node` file, each with the reason
 * it cannot.
 *
 * Deliberately a map rather than a list: an exclusion needs a stated reason, or
 * this test becomes a place to silence the check it exists to perform. Adding a
 * key here should feel like a decision.
 */
const NOT_AUTHORABLE: Record<string, string> = {
  name: "the filename is the name — `parseNodeFile` rejects `name:` explicitly",
  fn: "an implementation is resolved by contract hash, never inlined (design.md §10)",
  implementationHash: "set by `resolveImplementationAt`, describing the artifact rather than the contract",
};

/** Every property name a schema admits, unioned across `oneOf`/`allOf` branches. */
function schemaProperties(schema: Record<string, any>): Set<string> {
  const found = new Set<string>();
  const walk = (node: Record<string, any> | undefined): void => {
    if (node === undefined) return;
    for (const key of Object.keys(node.properties ?? {})) found.add(key);
    for (const branch of [...(node.oneOf ?? []), ...(node.allOf ?? []), ...(node.anyOf ?? [])]) walk(branch);
  };
  walk(schema);
  return found;
}

/** An interface's own property names, read from `types.ts` rather than listed. */
function interfaceProperties(name: string): string[] {
  const source = ts.createSourceFile(TYPES, readFileSync(TYPES, "utf8"), ts.ScriptTarget.Latest, true);
  let found: string[] | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isInterfaceDeclaration(node) && node.name.text === name) {
      found = node.members
        .filter(ts.isPropertySignature)
        .map((member) => member.name.getText())
        .sort();
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (found === undefined) throw new Error(`${name} not found in types.ts — this test's premise is gone.`);
  return found;
}

const nodeDefProperties = () => interfaceProperties("NodeDef");

describe("declarations — the type, the schema and the parser agree", () => {
  /**
   * **The check that would have caught `scope`.**
   *
   * Break-proof: removing `scope` from `nodeSchema`'s properties reddens this
   * naming `scope`, which is exactly the state the repo was in until
   * 2026-09-29.
   */
  it("every property of NodeDef is either declarable or excluded with a reason", () => {
    const declared = schemaProperties(nodeSchema());
    const properties = nodeDefProperties();

    // Guard against the check examining nothing if the interface is renamed or
    // restructured — the failure mode that makes a green here meaningless.
    expect(properties.length).toBeGreaterThan(6);

    const unreachable = properties.filter((key) => !declared.has(key) && !(key in NOT_AUTHORABLE));
    expect(unreachable).toEqual([]);
  });

  /**
   * The other direction, and it is not symmetric: a schema key naming nothing
   * on the type is a key the parser will accept and then drop on the floor.
   */
  it("every schema property exists on NodeDef", () => {
    const properties = new Set(nodeDefProperties());
    const orphaned = [...schemaProperties(nodeSchema())].filter((key) => !properties.has(key));

    expect(orphaned).toEqual([]);
  });

  /**
   * **The end-to-end half, because schema membership is not the same as
   * surviving the parser.** `contributes` could be in the schema and dropped by
   * `parseNodeDecl`, and nothing above would notice.
   *
   * Declares every authorable key in one `.node` file and asserts each reaches
   * the elaborated `NodeDecl`.
   *
   * Break-proof: deleting the `contributes` line from `parseNodeDecl`'s returned
   * object leaves it schema-valid and reddens this — which is the half of the
   * gap the structural check above cannot see.
   */
  it("a .node declaring every authorable key round-trips to the declaration", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-roundtrip-"));
    try {
      const files: Record<string, string> = {
        "edges/A.edge": `label: A\ndescription: d\nfields:\n  v: { type: utf8, label: V, description: d, nullable: false }\n`,
        "envelopes/Prov.envelope":
          `label: Prov\ndescription: d\nfields:\n` +
          `  pin: { type: utf8, label: P, description: d, nullable: false, combine: same }\n`,
        "nodes/everything.node": [
          `label: Everything`,
          `description: A node declaring every key an author may write.`,
          `input: A`,
          `output: A`,
          `scope:`,
          `  - read:Prov:pin`,
          `contributes:`,
          `  pin: "10-003"`,
          `closure:`,
          `  factor: 3`,
          `properties:`,
          `  - name: v is unchanged`,
          `    description: The value passes through untouched.`,
          `    expr:`,
          `      eq:`,
          `        - get: input.v`,
          `        - get: output.v`,
          `examples:`,
          `  - given: { A: { v: "x" } }`,
          `    expect: { A: { v: "x" } }`,
          ``,
        ].join("\n"),
        "topology/main.topology": `input: A\noutput: A\nterminals:\n  - everything\nwiring:\n  everything: {}\n`,
      };
      for (const [rel, content] of Object.entries(files)) {
        const full = join(dir, rel);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content, "utf8");
      }

      const node = (await elaborate(dir)).nodes.everything!;

      // Each key survived the parser, not merely the schema.
      expect(node.label).toBe("Everything");
      expect(node.description).toContain("every key an author may write");
      expect(node.input.edge.name).toBe("A");
      expect(node.output.edge.name).toBe("A");
      expect(node.scope).toEqual(["read:Prov:pin"]);
      expect(node.contributes).toEqual({ pin: "10-003" });
      expect(node.closure).toEqual({ factor: 3 });
      expect(node.properties).toHaveLength(1);
      expect(node.examples).toHaveLength(1);

      // `effect` is the one authorable key this fixture cannot also carry: an
      // effect node is performed by the host, so it has no drafted
      // implementation and declaring one beside `closure` would be incoherent.
      // Covered by `examples/flaky-source` instead.
      expect(Object.keys(nodeSchema().properties ?? {})).toContain("effect");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The same question for a **field**, because the three defects that prompted
   * this were all node keys and nothing said fields were safe.
   *
   * `FieldDef` is a conditional type over `FieldDefBase`, and `fieldSchema` is a
   * `oneOf` over literal and scalar branches, so both sides need unioning
   * rather than reading one object — which is exactly why a hand-kept list
   * would have drifted here first.
   */
  it("every property of FieldDefBase is declarable in a field", () => {
    const declared = schemaProperties(fieldSchema());
    const properties = interfaceProperties("FieldDefBase");

    expect(properties.length).toBeGreaterThan(8);
    expect(properties.filter((key) => !declared.has(key))).toEqual([]);
  });
});
