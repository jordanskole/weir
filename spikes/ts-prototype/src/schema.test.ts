import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { edgeSchema, fieldSchema, nodeSchema, topologySchema } from "./schema.js";

const ajv = new Ajv2020({ strict: false });

function validatorFor(schema: object) {
  return ajv.compile(schema);
}

describe("fieldSchema", () => {
  it("accepts a valid utf8 field with a pattern validation", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "utf8",
      label: "Email",
      description: "An email address",
      nullable: false,
      validations: { pattern: "^[a-z]+$" },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a field carrying a name — the filename (or map key) is the name", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      name: "email",
      type: "utf8",
      label: "Email",
      description: "d",
    });
    expect(valid).toBe(false);
  });

  it("rejects a field missing required properties", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ type: "utf8" });
    expect(valid).toBe(false);
  });

  it("rejects an unknown scalar type", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "int64",
      label: "X",
      description: "d",
    });
    expect(valid).toBe(false);
  });

  it("rejects minLength/maxLength on a numeric field", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "uint8",
      label: "Age",
      description: "d",
      validations: { minLength: 1 },
    });
    expect(valid).toBe(false);
  });

  it("rejects pattern on a bool field", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "bool",
      label: "Active",
      description: "d",
      validations: { pattern: "true" },
    });
    expect(valid).toBe(false);
  });

  it("rejects a uint8 min above its representable range", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "uint8",
      label: "Age",
      description: "d",
      validations: { max: 999 },
    });
    expect(valid).toBe(false);
  });

  it("rejects a negative min on an unsigned type", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "uint8",
      label: "Age",
      description: "d",
      validations: { min: -5 },
    });
    expect(valid).toBe(false);
  });

  it("accepts a non-integer min/max on a float type", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "f32",
      label: "Amount",
      description: "d",
      nullable: false,
      validations: { min: 1.5, max: 99.99 },
    });
    expect(valid).toBe(true);
  });

  it("accepts a datetime field with a pattern validation", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "datetime",
      label: "Created At",
      description: "d",
      nullable: false,
      validations: { pattern: "^\\d{4}-\\d{2}-\\d{2}T" },
    });
    expect(valid).toBe(true);
  });

  it("rejects min/max on a datetime field", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "datetime",
      label: "Created At",
      description: "d",
      validations: { min: 0 },
    });
    expect(valid).toBe(false);
  });

  it("accepts nullable: true on any scalar type", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "datetime",
      label: "Due At",
      description: "d",
      nullable: true,
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a non-boolean nullable", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "utf8",
      label: "X",
      description: "d",
      nullable: "true",
    });
    expect(valid).toBe(false);
  });

  it("rejects a non-bool field missing nullable", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ type: "utf8", label: "X", description: "d" });
    expect(valid).toBe(false);
  });

  it("rejects a bool field that declares nullable", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      type: "bool",
      label: "X",
      description: "d",
      nullable: false,
    });
    expect(valid).toBe(false);
  });

  it("accepts a bool field with no nullable key", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ type: "bool", label: "X", description: "d" });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts a literal field with a label and description", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({
      literal: true,
      label: "Is Complete",
      description: "Always true on a CompletedTodo",
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts a bare literal field with no label or description", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ literal: false });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a literal field carrying nullable", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ literal: true, nullable: false });
    expect(valid).toBe(false);
  });

  it("rejects a literal field carrying validations", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ literal: true, validations: {} });
    expect(valid).toBe(false);
  });

  it("rejects a non-boolean literal value", () => {
    const validate = validatorFor(fieldSchema());
    const valid = validate({ literal: "done" });
    expect(valid).toBe(false);
  });
});

describe("edgeSchema", () => {
  it("accepts a valid edge with a label and an inline scalar field", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Address",
      description: "A mailing address",
      fields: {
        street: {
          type: "utf8",
          label: "Street",
          description: "Street address",
          nullable: false,
        },
      },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects an edge missing a label", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({ description: "d", fields: {} });
    expect(valid).toBe(false);
  });

  it("rejects an edge carrying a name — the filename is the name", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      name: "Address",
      label: "Address",
      description: "d",
      fields: {},
    });
    expect(valid).toBe(false);
  });

  it("accepts a bare-string field value (a reference to a .field/.edge file)", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Person with address",
      description: "d",
      fields: {
        email: "email",
        address: "Address",
      },
    });
    expect(valid).toBe(true);
  });

  it("accepts a many: field value referencing an edge by bare name", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Task list",
      description: "d",
      fields: { tasks: { many: "Task" } },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a many: field value that isn't a bare name", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Task list",
      description: "d",
      fields: { tasks: { many: { type: "utf8", label: "bad", description: "bad" } } },
    });
    expect(valid).toBe(false);
  });

  it("accepts a bare boolean field value as literal sugar", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "CompletedTodo",
      description: "d",
      fields: { is_complete: true },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts an explicit literal field value with a label and description", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "CompletedTodo",
      description: "d",
      fields: {
        is_complete: { literal: true, label: "Is Complete", description: "Always true" },
      },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects an inline literal field value carrying nullable", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "CompletedTodo",
      description: "d",
      fields: { is_complete: { literal: true, nullable: false } },
    });
    expect(valid).toBe(false);
  });

  it("accepts a spread key with a null value", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Baked Cookies",
      description: "d",
      fields: {
        "...Dough": null,
        done: { type: "bool", label: "Done", description: "d" },
      },
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a spread key with a non-null value", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Baked Cookies",
      description: "d",
      fields: { "...Dough": "Dough" },
    });
    expect(valid).toBe(false);
  });

  it("rejects a bare ... spread key naming no source", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Baked Cookies",
      description: "d",
      fields: { "...": null },
    });
    expect(valid).toBe(false);
  });

  it("rejects an edge missing required top-level properties", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({ fields: {} });
    expect(valid).toBe(false);
  });

  it("rejects an inline field with an unknown scalar type", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Address",
      description: "d",
      fields: {
        street: { type: "int64", label: "Street", description: "d" },
      },
    });
    expect(valid).toBe(false);
  });

  it("rejects an inline field carrying a redundant name — the map key is the name", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Address",
      description: "d",
      fields: {
        street: { name: "street", type: "utf8", label: "Street", description: "d" },
      },
    });
    expect(valid).toBe(false);
  });

  it("rejects the same type-appropriateness violations fieldSchema does, inline", () => {
    const validate = validatorFor(edgeSchema());
    const valid = validate({
      label: "Person",
      description: "d",
      fields: {
        age: {
          type: "uint8",
          label: "Age",
          description: "d",
          validations: { pattern: "^[0-9]+$" },
        },
      },
    });
    expect(valid).toBe(false);
  });
});

describe("nodeSchema", () => {
  it("accepts a minimal node with single-edge sugar for output and a tagged example", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 42 } } }],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts an optional label", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      label: "Birthday",
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 42 } } }],
    });
    expect(valid).toBe(true);
  });

  it("rejects a node carrying a name — the filename is the name", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      name: "birthday",
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 42 } } }],
    });
    expect(valid).toBe(false);
  });

  it("rejects a node missing required top-level properties", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({ description: "d" });
    expect(valid).toBe(false);
  });

  it("rejects a node missing examples", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({ description: "d", input: "Person", output: "Person" });
    expect(valid).toBe(false);
  });

  it("rejects a node with an empty examples list", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [],
    });
    expect(valid).toBe(false);
  });

  it("rejects a node carrying an fn key — contract only, no implementation", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 42 } } }],
      fn: "() => {}",
    });
    expect(valid).toBe(false);
  });

  it("rejects a given/expect with more than one tag", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [
        { given: { Person: { age: 41 }, Other: {} }, expect: { Person: { age: 42 } } },
      ],
    });
    expect(valid).toBe(false);
  });

  it("accepts an allOf input with a multi-tag given", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { allOf: ["TodoList", "Todo"] },
      output: "TodoList",
      examples: [
        {
          given: { TodoList: { title: "Groceries", tasks: [] }, Todo: { title: "Buy milk" } },
          expect: { TodoList: { title: "Groceries", tasks: [{ title: "Buy milk" }] } },
        },
      ],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects an allOf input whose given has no tags", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { allOf: ["TodoList", "Todo"] },
      output: "TodoList",
      examples: [{ given: {}, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(valid).toBe(false);
  });

  it("accepts an anyOf input with a single-tag given", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { anyOf: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [{ given: { Todo: { title: "Buy milk" } }, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects an anyOf input whose given has no tags", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { anyOf: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [{ given: {}, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(valid).toBe(false);
  });

  it("rejects an anyOf input whose given has more than one tag", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { anyOf: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [
        {
          given: { Todo: { title: "Buy milk" }, TodoList: { title: "Groceries", tasks: [] } },
          expect: { TodoList: { title: "Groceries", tasks: [] } },
        },
      ],
    });
    expect(valid).toBe(false);
  });

  /**
   * `gather` in input position (docs/superpowers/specs/2026-09-27-gather.md).
   * Its `given` is a keyed collection under one tag — the mirror image of
   * `many`'s `expect` on the output side, because the two are duals.
   */
  it("accepts a gather input whose given is a keyed collection", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { gather: "Todo" },
      output: "TodoList",
      examples: [
        {
          given: { Todo: { "1": { title: "Buy milk" }, "2": { title: "Buy eggs" } } },
          expect: { TodoList: { title: "Groceries", tasks: [] } },
        },
      ],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts a gather input whose given is an empty collection", () => {
    // The case §5 exists for: a spread of zero elements gathers immediately to
    // an empty collection, so `given: { Todo: {} }` is a real example, not a
    // malformed one. `taggedOne` requires one *tag*, not one entry.
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { gather: "Todo" },
      output: "TodoList",
      examples: [{ given: { Todo: {} }, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a gather input naming a list of edges — a gather is N of *one* edge", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { gather: ["Todo", "TodoList"] },
      output: "TodoList",
      examples: [{ given: { Todo: {} }, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(valid).toBe(false);
  });

  it("rejects a gather input whose given entries are not objects", () => {
    // A collection of scalars: the shape a hand-written example most plausibly
    // gets wrong, since `many`'s collection was once documented as an array.
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: { gather: "Todo" },
      output: "TodoList",
      examples: [{ given: { Todo: { "1": "Buy milk" } }, expect: { TodoList: { title: "Groceries", tasks: [] } } }],
    });
    expect(valid).toBe(false);
  });

  it("accepts a oneOf output with a single-tag expect", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: { oneOf: ["Pass", "Fail"] },
      examples: [{ given: { Person: { age: 42 } }, expect: { Pass: {} } }],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects an allOf output whose expect has no tags", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "OrderPlaced",
      output: { allOf: ["InvoiceRequested", "InventoryReserved"] },
      examples: [{ given: { OrderPlaced: {} }, expect: {} }],
    });
    expect(valid).toBe(false);
  });

  it("accepts an allOf output with multiple tags in expect", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "OrderPlaced",
      output: { allOf: ["InvoiceRequested", "InventoryReserved"] },
      examples: [
        {
          given: { OrderPlaced: {} },
          expect: { InvoiceRequested: {}, InventoryReserved: {} },
        },
      ],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts a many output whose single tag holds a keyed collection", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: { many: "Person" },
      examples: [
        // Keyed by the referenced edge's own `index`, not an array — this
        // schema said `array` until 2026-09-27, contradicting
        // design-history.md's "`many` is a collection, keyed by index, not
        // an array" and `fuzz.ts`'s `assertManyOutput`. Nothing noticed
        // because nothing validated a declaration against this schema.
        { given: { Person: { age: 10 } }, expect: { Person: { "8": { age: 8 }, "12": { age: 12 } } } },
      ],
    });
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("rejects a many output whose tag holds an array instead of a keyed collection", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: { many: "Person" },
      // An array, which a keyed collection is not.
      examples: [{ given: { Person: { age: 10 } }, expect: { Person: [{ age: 8 }] } }],
    });
    expect(valid).toBe(false);
  });

  it("rejects an output with more than one shape key at once", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: { oneOf: ["Pass"], allOf: ["Fail"] },
      examples: [{ given: { Person: {} }, expect: { Pass: {} } }],
    });
    expect(valid).toBe(false);
  });

  it("accepts a closure with a tagged expected", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: { oneOf: ["Pass", "Fail"] },
      examples: [{ given: { Person: { age: 42 } }, expect: { Pass: {} } }],
      closure: { expected: { Person: { age: 42 } } },
    });
    expect(valid).toBe(true);
  });

  it("accepts a closure with a tagged literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Unit",
      output: "Person",
      examples: [{ given: { Unit: {} }, expect: { Person: { age: 41 } } }],
      closure: { literal: { Person: { age: 41 } } },
    });
    expect(valid).toBe(true);
  });

  it("rejects a closure with both expected and literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 41 } } }],
      closure: { expected: { Person: { age: 41 } }, literal: { Person: { age: 41 } } },
    });
    expect(valid).toBe(false);
  });

  it("rejects a closure with neither expected nor literal", () => {
    const validate = validatorFor(nodeSchema());
    const valid = validate({
      description: "d",
      input: "Person",
      output: "Person",
      examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 41 } } }],
      closure: {},
    });
    expect(valid).toBe(false);
  });
});

describe("topologySchema", () => {
  /**
   * Every `.topology` declares a contract now
   * (2026-09-28-a-root-topology-declares-its-end.md), so the wiring these
   * cases are actually about lives under `wiring:`. Wrapped by a helper so a
   * wiring-shape assertion still reads as one, and so a contract typo cannot
   * make a wiring case pass or fail for the wrong reason.
   */
  const withWiring = (wiring: unknown) => ({ output: "Out", terminals: ["A"], wiring });

  it("accepts a single sequential chain", () => {
    const validate = validatorFor(topologySchema());
    expect(validate(withWiring({ A: { then: { B: {} } } }))).toBe(true);
  });

  it("accepts a leaf node declared as null", () => {
    const validate = validatorFor(topologySchema());
    expect(validate(withWiring({ A: null }))).toBe(true);
  });

  it("accepts fan-out — one node feeding several next nodes", () => {
    const validate = validatorFor(topologySchema());
    expect(validate(withWiring({ A: { then: { B: {}, C: {} } } }))).toBe(true);
  });

  it("accepts a node fed by two parents, nested arbitrarily deep", () => {
    const validate = validatorFor(topologySchema());
    const valid = validate(withWiring({ A: { then: { B: { then: { C: {} } }, C: {} } } }));
    expect(validate.errors).toBeNull();
    expect(valid).toBe(true);
  });

  it("accepts several independent top-level origins", () => {
    const validate = validatorFor(topologySchema());
    expect(validate(withWiring({ A: {}, B: null }))).toBe(true);
  });

  it("rejects a then value that isn't an object", () => {
    const validate = validatorFor(topologySchema());
    expect(validate(withWiring({ A: { then: "oops" } }))).toBe(false);
  });

  it("rejects a key other than then, at any depth", () => {
    const validate = validatorFor(topologySchema());
    expect(validate(withWiring({ A: { bogus: {} } }))).toBe(false);
    expect(validate(withWiring({ A: { then: { B: { bogus: {} } } } }))).toBe(false);
  });

  it("rejects a wiring value that's neither null nor an object", () => {
    const validate = validatorFor(topologySchema());
    expect(validate(withWiring({ A: "oops" }))).toBe(false);
  });

  /** The contract half, which is what this schema gained. */
  it("rejects a topology declaring no output or terminals — the bare-wiring form is gone", () => {
    const validate = validatorFor(topologySchema());
    // Exactly what every root `.topology` in this repo looked like until now.
    expect(validate({ A: { then: { B: {} } } })).toBe(false);
    expect(validate({ wiring: { A: {} }, terminals: ["A"] })).toBe(false);
    expect(validate({ wiring: { A: {} }, output: "Out" })).toBe(false);
  });

  it("rejects an empty terminals list", () => {
    const validate = validatorFor(topologySchema());
    expect(validate({ output: "Out", terminals: [], wiring: { A: {} } })).toBe(false);
  });

  it("accepts every output mode, since all three are used by the examples", () => {
    const validate = validatorFor(topologySchema());
    for (const output of [
      "Cookies",
      { oneOf: ["Pass", "Fail"] },
      { allOf: ["TodoList", "Todo"] },
    ]) {
      expect(validate({ output, terminals: ["A"], wiring: { A: {} } })).toBe(true);
    }
  });

  it("accepts a composite's extra `input`, and nothing else", () => {
    const validate = validatorFor(topologySchema());
    expect(validate({ input: "Entity", output: "Out", terminals: ["A"], wiring: { A: {} } })).toBe(true);
    expect(validate({ output: "Out", terminals: ["A"], wiring: { A: {} }, bogus: 1 })).toBe(false);
  });
});

describe("nodeSchema — properties", () => {
  const validate = validatorFor(nodeSchema());
  const validNode = (properties: unknown) => ({
    input: "Person",
    output: "Person",
    examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 42 } } }],
    properties,
  });

  const increments = {
    name: "increments age by one",
    description: "A birthday advances the person's age by exactly one year.",
    expr: { eq: [{ get: "output.age" }, { add: [{ get: "input.age" }, { lit: 1 }] }] },
  };

  it("accepts a nested property expression", () => {
    expect(validate(validNode([increments]))).toBe(true);
  });

  it("accepts a node with no properties key at all", () => {
    expect(
      validate({
        input: "Person",
        output: "Person",
        examples: [{ given: { Person: { age: 41 } }, expect: { Person: { age: 42 } } }],
      }),
    ).toBe(true);
  });

  it("rejects a property missing its description", () => {
    expect(validate(validNode([{ name: "x", expr: { lit: true } }]))).toBe(false);
  });

  it("rejects an unknown operator", () => {
    expect(validate(validNode([{ ...increments, expr: { frobnicate: [{ lit: 1 }, { lit: 2 }] } }]))).toBe(false);
  });

  it("rejects a binary operator with the wrong arity", () => {
    expect(validate(validNode([{ ...increments, expr: { eq: [{ lit: 1 }] } }]))).toBe(false);
    expect(validate(validNode([{ ...increments, expr: { eq: [{ lit: 1 }, { lit: 2 }, { lit: 3 }] } }]))).toBe(false);
  });

  it("rejects an expression object carrying two operators at once", () => {
    expect(validate(validNode([{ ...increments, expr: { lit: 1, get: "input.age" } }]))).toBe(false);
  });
});

describe("generated schema artifacts stay in sync", () => {
  // schemas/*.json (repo root) are *generated* files — the ones
  // .vscode/settings.json actually points VS Code's YAML validator at.
  // Each can drift from its generator silently, because nothing else in
  // the suite reads the committed files; the editor is the only consumer,
  // so staleness shows up as a false red squiggle rather than a test
  // failure. That has now happened twice (docs/design-history.md), both
  // times to node.schema.json.
  //
  // One case per artifact, driven off the same list scripts/generate-schemas.ts
  // writes — so adding a fifth schema there without a matching entry here
  // is the only way to reintroduce the gap, rather than it being the
  // default for three of the four.
  const artifacts: [name: string, generator: () => object][] = [
    ["field", fieldSchema],
    ["edge", edgeSchema],
    ["node", nodeSchema],
    ["topology", topologySchema],
  ];

  for (const [name, generator] of artifacts) {
    it(`schemas/${name}.schema.json matches its generator's current output`, () => {
      const committed = JSON.parse(
        readFileSync(new URL(`../../../schemas/${name}.schema.json`, import.meta.url), "utf8"),
      );
      expect(committed).toEqual(generator());
    });
  }
});
