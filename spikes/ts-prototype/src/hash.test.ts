import { describe, expect, it } from "vitest";
import { assertEdgeHash, hashEdge, hashEdges, hashNode } from "./hash.js";
import type { AnyEdgeDef, EdgeDef, NodeDecl, PropertyDecl } from "./types.js";

const base: EdgeDef = {
  name: "example",
  label: "Example",
  description: "A test edge",
  fields: {
    id: { type: "uint32", label: "ID", description: "The record id", nullable: false },
    amount: {
      type: "f32",
      label: "Amount",
      description: "The transaction amount",
      nullable: false,
      measure: "quantitative",
      format: "count",
      enumValues: ["a", "b"],
      relation: { edge: "users", field: "id", cardinality: "many:1" },
    },
  },
};

describe("hashEdge", () => {
  it("returns a 64-char hex hash and an 8-char short hash", async () => {
    const { hash, short } = await hashEdge(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(short).toBe(hash.slice(0, 8));
  });

  it("is deterministic for the same input", async () => {
    expect((await hashEdge(base)).hash).toBe((await hashEdge(base)).hash);
  });

  it("is independent of field insertion order", async () => {
    const reordered: EdgeDef = {
      name: base.name,
      label: base.label,
      description: base.description,
      fields: {
        amount: base.fields.amount!,
        id: base.fields.id!,
      },
    };
    expect((await hashEdge(reordered)).hash).toBe((await hashEdge(base)).hash);
  });

  it("is independent of enumValues ordering", async () => {
    const flipped: EdgeDef = {
      ...base,
      fields: {
        ...base.fields,
        amount: { ...base.fields.amount!, enumValues: ["b", "a"] },
      },
    };
    expect((await hashEdge(flipped)).hash).toBe((await hashEdge(base)).hash);
  });

  it("changes when edge name changes", async () => {
    expect((await hashEdge({ ...base, name: "other" })).hash).not.toBe(
      (await hashEdge(base)).hash,
    );
  });

  it("changes when edge index is set vs absent", async () => {
    expect((await hashEdge({ ...base, index: "id" })).hash).not.toBe(
      (await hashEdge(base)).hash,
    );
  });

  it("changes when a field's type changes", async () => {
    const mutated: EdgeDef = {
      ...base,
      fields: {
        ...base.fields,
        id: { type: "utf8", label: "ID", description: "The record id", nullable: false },
      },
    };
    expect((await hashEdge(mutated)).hash).not.toBe((await hashEdge(base)).hash);
  });

  it("changes when a field's nullable changes", async () => {
    const mutated: EdgeDef = {
      ...base,
      fields: {
        ...base.fields,
        id: { type: "uint32", label: "ID", description: "The record id", nullable: true },
      },
    };
    expect((await hashEdge(mutated)).hash).not.toBe((await hashEdge(base)).hash);
  });

  it("changes when a field's measure changes", async () => {
    const mutated: EdgeDef = {
      ...base,
      fields: {
        ...base.fields,
        amount: { ...base.fields.amount!, measure: "nominal" },
      },
    };
    expect((await hashEdge(mutated)).hash).not.toBe((await hashEdge(base)).hash);
  });

  it("changes when a field's format changes", async () => {
    const mutated: EdgeDef = {
      ...base,
      fields: {
        ...base.fields,
        amount: { ...base.fields.amount!, format: "percentage" },
      },
    };
    expect((await hashEdge(mutated)).hash).not.toBe((await hashEdge(base)).hash);
  });

  it("changes when a field's enumValues content changes", async () => {
    const mutated: EdgeDef = {
      ...base,
      fields: {
        ...base.fields,
        amount: { ...base.fields.amount!, enumValues: ["a", "c"] },
      },
    };
    expect((await hashEdge(mutated)).hash).not.toBe((await hashEdge(base)).hash);
  });

  it("changes when a field's relation changes", async () => {
    const mutated: EdgeDef = {
      ...base,
      fields: {
        ...base.fields,
        amount: {
          ...base.fields.amount!,
          relation: { edge: "other", field: "id", cardinality: "many:1" },
        },
      },
    };
    expect((await hashEdge(mutated)).hash).not.toBe((await hashEdge(base)).hash);
  });

  it("does not change when description changes", async () => {
    const mutated: EdgeDef = {
      ...base,
      description: "new",
      fields: {
        ...base.fields,
        id: { ...base.fields.id!, description: "ignored" },
      },
    };
    expect((await hashEdge(mutated)).hash).toBe((await hashEdge(base)).hash);
  });

  it("does not change when the edge's own label changes", async () => {
    const mutated: EdgeDef = { ...base, label: "A totally different label" };
    expect((await hashEdge(mutated)).hash).toBe((await hashEdge(base)).hash);
  });

  it("does not change when unit, label, or sourceKey change", async () => {
    const mutated: EdgeDef = {
      ...base,
      fields: {
        ...base.fields,
        id: {
          ...base.fields.id!,
          unit: "rows",
          label: "Identifier",
          sourceKey: "ID",
        },
      },
    };
    expect((await hashEdge(mutated)).hash).toBe((await hashEdge(base)).hash);
  });

  it("changes when a field's min/max changes", async () => {
    const mutated: EdgeDef = {
      ...base,
      fields: {
        ...base.fields,
        id: {
          type: "uint32",
          label: "ID",
          description: "The record id",
          nullable: false,
          validations: { min: 0, max: 10 },
        },
      },
    };
    expect((await hashEdge(mutated)).hash).not.toBe((await hashEdge(base)).hash);
  });

  it("changes when a field's minLength/maxLength/pattern changes", async () => {
    const withStringConstraints: EdgeDef = {
      name: "example2",
      label: "Example 2",
      description: "A test edge",
      fields: {
        name: {
          type: "utf8",
          label: "Name",
          description: "A name",
          nullable: false,
          validations: { minLength: 1, maxLength: 20, pattern: "^[a-z]+$" },
        },
      },
    };
    const withoutStringConstraints: EdgeDef = {
      name: "example2",
      label: "Example 2",
      description: "A test edge",
      fields: {
        name: { type: "utf8", label: "Name", description: "A name", nullable: false },
      },
    };
    expect((await hashEdge(withStringConstraints)).hash).not.toBe(
      (await hashEdge(withoutStringConstraints)).hash,
    );
  });

  it("changes when a compound (nested-edge) field's own shape changes", async () => {
    const withUtf8Street: AnyEdgeDef = {
      name: "PersonWithAddress",
      label: "Person with address",
      description: "A test edge",
      fields: {
        address: {
          name: "Address",
          label: "Address",
          description: "A mailing address",
          fields: {
            street: { type: "utf8", label: "Street", description: "d", nullable: false },
          },
        },
      },
    };
    const withUint8Street: AnyEdgeDef = {
      name: "PersonWithAddress",
      label: "Person with address",
      description: "A test edge",
      fields: {
        address: {
          name: "Address",
          label: "Address",
          description: "A mailing address",
          fields: {
            street: { type: "uint8", label: "Street", description: "d", nullable: false },
          },
        },
      },
    };
    expect((await hashEdge(withUtf8Street)).hash).not.toBe((await hashEdge(withUint8Street)).hash);
  });

  it("changes when a many-of-compound-edge field's own shape changes", async () => {
    const Task = {
      name: "Task",
      label: "Task",
      description: "A task",
      fields: {
        title: { type: "utf8" as const, label: "Title", description: "d", nullable: false as const },
      },
    };
    const withUtf8Title: AnyEdgeDef = {
      name: "TaskList",
      label: "Task list",
      description: "A test edge",
      fields: { tasks: { many: Task } },
    };
    const withUint8Title: AnyEdgeDef = {
      name: "TaskList",
      label: "Task list",
      description: "A test edge",
      fields: {
        tasks: {
          many: {
            ...Task,
            fields: {
              title: { type: "uint8", label: "Title", description: "d", nullable: false },
            },
          },
        },
      },
    };
    expect((await hashEdge(withUtf8Title)).hash).not.toBe((await hashEdge(withUint8Title)).hash);
  });

  it("produces distinct hashes for a field without optional fingerprint keys vs with them", async () => {
    const bare: EdgeDef = {
      name: base.name,
      label: base.label,
      description: "A test edge",
      fields: {
        id: { type: "uint32", label: "ID", description: "The record id", nullable: false },
      },
    };
    expect((await hashEdge(bare)).hash).not.toBe((await hashEdge(base)).hash);
  });

  it("fingerprints a literal field as { literal }, not a scalar type", async () => {
    const edgeWithLiteral: AnyEdgeDef = {
      name: "CompletedTodo",
      label: "CompletedTodo",
      description: "d",
      fields: { is_complete: { literal: true } },
    };
    const { hash } = await hashEdge(edgeWithLiteral);
    expect(hash).toBeTruthy();
    const edgeWithDifferentLiteral: AnyEdgeDef = {
      ...edgeWithLiteral,
      fields: { is_complete: { literal: false } },
    };
    expect((await hashEdge(edgeWithDifferentLiteral)).hash).not.toBe(hash);
  });
});

describe("hashEdges", () => {
  it("returns a record keyed by edge name", async () => {
    const other: EdgeDef = {
      name: "other",
      label: "Other",
      description: "A test edge",
      fields: {
        id: { type: "uint32", label: "ID", description: "The record id", nullable: false },
      },
    };
    const result = await hashEdges([base, other]);
    expect(Object.keys(result)).toEqual(["example", "other"]);
    expect(result.example!.hash).toBe((await hashEdge(base)).hash);
  });

  it("returns an empty object for an empty input", async () => {
    expect(await hashEdges([])).toEqual({});
  });
});

describe("hashNode", () => {
  const Person: AnyEdgeDef = {
    name: "Person",
    label: "Person",
    description: "A person",
    fields: { age: { type: "uint8", label: "Age", description: "d", nullable: false } },
  };
  const Todo: AnyEdgeDef = {
    name: "Todo",
    label: "Todo",
    description: "A task",
    fields: { title: { type: "utf8", label: "Title", description: "d", nullable: false } },
  };
  const TodoList: AnyEdgeDef = {
    name: "TodoList",
    label: "Todo List",
    description: "A list of tasks",
    fields: { title: { type: "utf8", label: "Title", description: "d", nullable: false } },
  };

  const birthday: NodeDecl = {
    name: "birthday",
    description: "Increments a person's age by one year",
    input: { kind: "single", edge: Person },
    output: { kind: "single", edge: Person },
  };

  it("returns a 64-char hex hash and an 8-char short hash", async () => {
    const { hash, short } = await hashNode(birthday);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(short).toBe(hash.slice(0, 8));
  });

  it("is deterministic for the same input", async () => {
    expect((await hashNode(birthday)).hash).toBe((await hashNode(birthday)).hash);
  });

  it("changes when the node name changes", async () => {
    expect((await hashNode({ ...birthday, name: "other" })).hash).not.toBe(
      (await hashNode(birthday)).hash,
    );
  });

  it("changes when an input edge's shape changes", async () => {
    const mutated: NodeDecl = {
      ...birthday,
      input: { kind: "single", edge: { ...Person, fields: { age: { type: "uint16", label: "Age", description: "d", nullable: false } } } },
    };
    expect((await hashNode(mutated)).hash).not.toBe((await hashNode(birthday)).hash);
  });

  it("does not change when label or description changes", async () => {
    const mutated: NodeDecl = { ...birthday, label: "Birthday!", description: "different" };
    expect((await hashNode(mutated)).hash).toBe((await hashNode(birthday)).hash);
  });

  it("changes when closure differs", async () => {
    const expectNode: NodeDecl = {
      name: "expect_Person_age_42",
      description: "d",
      input: { kind: "single", edge: Person },
      output: { kind: "oneOf", edges: [{ name: "Pass", description: "d", fields: {} }, { name: "Fail", description: "d", fields: {} }] },
      closure: { expected: { age: 42 } },
    };
    const differentClosure: NodeDecl = { ...expectNode, closure: { expected: { age: 43 } } };
    expect((await hashNode(differentClosure)).hash).not.toBe((await hashNode(expectNode)).hash);
  });

  it("is independent of allOf: edge declaration order", async () => {
    const addTodo: NodeDecl = {
      name: "AddTodoToList",
      description: "d",
      input: { kind: "allOf", edges: [TodoList, Todo] },
      output: { kind: "single", edge: TodoList },
    };
    const reordered: NodeDecl = { ...addTodo, input: { kind: "allOf", edges: [Todo, TodoList] } };
    expect((await hashNode(reordered)).hash).toBe((await hashNode(addTodo)).hash);
  });
});

describe("hashNode — properties", () => {
  const node: NodeDecl = {
    name: "birthday",
    input: { kind: "single", edge: base },
    output: { kind: "single", edge: base },
  };

  const increments: PropertyDecl = {
    name: "increments age by one",
    description: "A birthday advances the person's age by exactly one year.",
    expr: { eq: [{ get: "output.age" }, { add: [{ get: "input.age" }, { lit: 1 }] }] },
  };

  const preservesName: PropertyDecl = {
    name: "preserves name",
    description: "A birthday never changes the person's name.",
    expr: { eq: [{ get: "output.name" }, { get: "input.name" }] },
  };

  it("changes the hash when a property is added", async () => {
    const before = await hashNode(node);
    const after = await hashNode({ ...node, properties: [increments] });
    expect(after.hash).not.toBe(before.hash);
  });

  it("changes the hash when a property's expression changes", async () => {
    const a = await hashNode({ ...node, properties: [increments] });
    const b = await hashNode({
      ...node,
      properties: [{ ...increments, expr: { eq: [{ get: "output.age" }, { get: "input.age" }] } }],
    });
    expect(a.hash).not.toBe(b.hash);
  });

  it("is stable across a reordering that doesn't change meaning", async () => {
    const a = await hashNode({ ...node, properties: [increments, preservesName] });
    const b = await hashNode({ ...node, properties: [preservesName, increments] });
    expect(a.hash).toBe(b.hash);
  });

  it("ignores a property's description, which is cosmetic", async () => {
    const a = await hashNode({ ...node, properties: [increments] });
    const b = await hashNode({ ...node, properties: [{ ...increments, description: "reworded entirely" }] });
    expect(a.hash).toBe(b.hash);
  });

  it("treats an empty properties array as no properties at all", async () => {
    const a = await hashNode(node);
    const b = await hashNode({ ...node, properties: [] });
    expect(a.hash).toBe(b.hash);
  });

  it("throws on duplicate property names, which would make the sort ambiguous and the report unreadable", async () => {
    await expect(
      hashNode({ ...node, properties: [increments, { ...preservesName, name: increments.name }] }),
    ).rejects.toThrow(/duplicate property name/i);
  });
});

describe("assertEdgeHash", () => {
  it("passes when the short hash matches", async () => {
    const { short } = await hashEdge(base);
    await expect(assertEdgeHash(base, short)).resolves.not.toThrow();
  });

  it("throws a descriptive Error when the short hash mismatches", async () => {
    await expect(assertEdgeHash(base, "00000000")).rejects.toThrow(
      /Schema drift detected for edge "example"/,
    );
  });
});

describe("hashNode — scope", () => {
  const node: NodeDecl = {
    name: "birthday",
    input: { kind: "single", edge: base },
    output: { kind: "single", edge: base },
  };

  it("changes the hash when a scope is added", async () => {
    const before = await hashNode(node);
    const after = await hashNode({ ...node, scope: ["read:Identity:sub"] });
    expect(after.hash).not.toBe(before.hash);
  });

  it("changes the hash when a declared scope changes", async () => {
    // The case this exists for: `scope` feeds narrowIdentity, so changing it
    // changes what data Fn actually receives. Left unhashed, the previously
    // accepted implementation would resolve unchanged and read the old field
    // as undefined — silently, with acceptImplementation declining to
    // re-check because the hash said nothing changed.
    const a = await hashNode({ ...node, scope: ["read:Identity:sub"] });
    const b = await hashNode({ ...node, scope: ["read:Identity:iss"] });
    expect(a.hash).not.toBe(b.hash);
  });

  it("is stable across a reordering that doesn't change meaning", async () => {
    const a = await hashNode({ ...node, scope: ["read:Identity:sub", "read:Identity:iss"] });
    const b = await hashNode({ ...node, scope: ["read:Identity:iss", "read:Identity:sub"] });
    expect(a.hash).toBe(b.hash);
  });

  it("treats an empty scope array as no scope at all", async () => {
    const a = await hashNode(node);
    const b = await hashNode({ ...node, scope: [] });
    expect(a.hash).toBe(b.hash);
  });

  it("treats a repeated scope as the single scope it narrows to", async () => {
    // Unlike a duplicate property name, a repeated scope is merely redundant
    // rather than ambiguous — narrowing to the same field twice is the same
    // narrowing — so it de-duplicates instead of throwing.
    const a = await hashNode({ ...node, scope: ["read:Identity:sub"] });
    const b = await hashNode({ ...node, scope: ["read:Identity:sub", "read:Identity:sub"] });
    expect(a.hash).toBe(b.hash);
  });
});
