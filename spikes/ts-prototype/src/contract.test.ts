import { describe, expect, it } from "vitest";
import { exportContract } from "./contract.js";
import type { NodeDecl } from "./types.js";

const Person = {
  name: "Person",
  label: "Person",
  description: "A person",
  fields: {
    age: { type: "uint8" as const, label: "Age", description: "The person's age", nullable: false as const },
  },
};

const Pass = { name: "Pass", label: "Pass", description: "A passing result", fields: {} };
const Fail = { name: "Fail", label: "Fail", description: "A failing result", fields: {} };

const TodoList = {
  name: "TodoList",
  label: "Todo List",
  description: "A list of todos",
  fields: {
    title: { type: "utf8" as const, label: "Title", description: "d", nullable: false as const },
  },
};

const Todo = {
  name: "Todo",
  label: "Todo",
  description: "A task",
  index: "id",
  fields: {
    id: { type: "utf8" as const, label: "ID", description: "d", nullable: false as const },
    is_complete: { literal: false as const },
  },
};

const Address = {
  name: "Address",
  label: "Address",
  description: "A postal address",
  fields: {
    street: { type: "utf8" as const, label: "Street", description: "d", nullable: false as const },
  },
};

const Resident = {
  name: "Resident",
  label: "Resident",
  description: "A person at an address",
  fields: {
    age: { type: "uint8" as const, label: "Age", description: "The person's age", nullable: false as const },
    address: Address,
  },
};

const TodoListWithTasks = {
  name: "TodoList",
  label: "Todo List",
  description: "A list of todos",
  fields: {
    title: { type: "utf8" as const, label: "Title", description: "d", nullable: false as const },
    tasks: { many: Todo },
  },
};

const addressShape = {
  name: "Address",
  label: "Address",
  description: "A postal address",
  fields: { street: { type: "utf8", label: "Street", description: "d", nullable: false } },
};

const todoShape = {
  name: "Todo",
  label: "Todo",
  description: "A task",
  index: "id",
  fields: {
    id: { type: "utf8", label: "ID", description: "d", nullable: false },
    is_complete: { literal: false },
  },
};

describe("exportContract", () => {
  it("exports a single-input, single-output node's full edge shapes, no description/examples/closure when absent", () => {
    const node: NodeDecl = {
      name: "birthday",
      input: { kind: "single", edge: Person },
      output: { kind: "single", edge: Person },
    };

    expect(exportContract(node)).toEqual({
      node: "birthday",
      input: {
        name: "Person",
        label: "Person",
        description: "A person",
        fields: { age: { type: "uint8", label: "Age", description: "The person's age", nullable: false } },
      },
      output: {
        name: "Person",
        label: "Person",
        description: "A person",
        fields: { age: { type: "uint8", label: "Age", description: "The person's age", nullable: false } },
      },
      failure: {
        input: {
          name: "Person",
          label: "Person",
          description: "A person",
          fields: { age: { type: "uint8", label: "Age", description: "The person's age", nullable: false } },
        },
      },
    });
  });

  it("includes description, examples, and closure only when present, and an edge's index when declared", () => {
    const node: NodeDecl = {
      name: "expect_Person_age_42",
      description: "Checks whether a person just turned 42",
      input: { kind: "single", edge: Person },
      output: { kind: "oneOf", edges: [Pass, Fail] },
      examples: [{ given: { age: 42 }, expect: { edge: "Pass", payload: {} } }],
      closure: { expected: { age: 42 } },
    };

    const contract = exportContract(node);

    expect(contract.description).toBe("Checks whether a person just turned 42");
    expect(contract.examples).toEqual([{ given: { age: 42 }, expect: { edge: "Pass", payload: {} } }]);
    expect(contract.closure).toEqual({ expected: { age: 42 } });
    expect(contract.output).toEqual({
      oneOf: [
        { name: "Pass", label: "Pass", description: "A passing result", fields: {} },
        { name: "Fail", label: "Fail", description: "A failing result", fields: {} },
      ],
    });
  });

  it("exports allOf-kind input as { allOf: [...] }, each edge in full", () => {
    const node: NodeDecl = {
      name: "AddTodoToList",
      input: { kind: "allOf", edges: [TodoList, Todo] },
      output: { kind: "single", edge: TodoList },
    };

    const contract = exportContract(node);

    expect(contract.input).toEqual({
      allOf: [
        {
          name: "TodoList",
          label: "Todo List",
          description: "A list of todos",
          fields: { title: { type: "utf8", label: "Title", description: "d", nullable: false } },
        },
        {
          name: "Todo",
          label: "Todo",
          description: "A task",
          index: "id",
          fields: {
            id: { type: "utf8", label: "ID", description: "d", nullable: false },
            is_complete: { literal: false },
          },
        },
      ],
    });
    expect(contract.failure).toEqual({
      input: {
        allOf: [
          {
            name: "TodoList",
            label: "Todo List",
            description: "A list of todos",
            fields: { title: { type: "utf8", label: "Title", description: "d", nullable: false } },
          },
          {
            name: "Todo",
            label: "Todo",
            description: "A task",
            index: "id",
            fields: {
              id: { type: "utf8", label: "ID", description: "d", nullable: false },
              is_complete: { literal: false },
            },
          },
        ],
      },
    });
  });

  it("exports many-kind output as { many: <edge shape> }", () => {
    const node: NodeDecl = {
      name: "spawnTodos",
      input: { kind: "single", edge: TodoList },
      output: { kind: "many", edge: Todo },
    };

    expect(exportContract(node).output).toEqual({
      many: {
        name: "Todo",
        label: "Todo",
        description: "A task",
        index: "id",
        fields: {
          id: { type: "utf8", label: "ID", description: "d", nullable: false },
          is_complete: { literal: false },
        },
      },
    });
  });

  it("exports allOf-kind output as { allOf: [...] }", () => {
    const node: NodeDecl = {
      name: "split",
      input: { kind: "single", edge: Person },
      output: { kind: "allOf", edges: [Pass, Fail] },
    };

    expect(exportContract(node).output).toEqual({
      allOf: [
        { name: "Pass", label: "Pass", description: "A passing result", fields: {} },
        { name: "Fail", label: "Fail", description: "A failing result", fields: {} },
      ],
    });
  });

  it("embeds a compound field's nested edge in full, not as a bare { edge: name } reference", () => {
    const node: NodeDecl = {
      name: "relocate",
      input: { kind: "single", edge: Resident },
      output: { kind: "single", edge: Resident },
    };

    const contract = exportContract(node);
    const expected = {
      name: "Resident",
      label: "Resident",
      description: "A person at an address",
      fields: {
        age: { type: "uint8", label: "Age", description: "The person's age", nullable: false },
        address: addressShape,
      },
    };

    expect(contract.input).toEqual(expected);
    expect(contract.output).toEqual(expected);
    expect(contract.failure.input).toEqual(expected);
  });

  it("embeds a many field's referenced edge in full, index included, so an agent can key the payload", () => {
    const node: NodeDecl = {
      name: "completeAll",
      input: { kind: "single", edge: TodoListWithTasks },
      output: { kind: "single", edge: TodoListWithTasks },
    };

    expect(exportContract(node).input).toEqual({
      name: "TodoList",
      label: "Todo List",
      description: "A list of todos",
      fields: {
        title: { type: "utf8", label: "Title", description: "d", nullable: false },
        tasks: { many: todoShape },
      },
    });
  });

  it("recurses to any depth — a many field nested inside a compound field", () => {
    const Household = {
      name: "Household",
      label: "Household",
      description: "A home and its chores",
      fields: { list: TodoListWithTasks },
    };
    const node: NodeDecl = {
      name: "chores",
      input: { kind: "single", edge: Household },
      output: { kind: "many", edge: Todo },
    };

    expect(exportContract(node).input).toEqual({
      name: "Household",
      label: "Household",
      description: "A home and its chores",
      fields: {
        list: {
          name: "TodoList",
          label: "Todo List",
          description: "A list of todos",
          fields: {
            title: { type: "utf8", label: "Title", description: "d", nullable: false },
            tasks: { many: todoShape },
          },
        },
      },
    });
  });

  it("round-trips a declared scope, and omits the key entirely when absent", () => {
    const scoped: NodeDecl = {
      name: "greetByName",
      input: { kind: "single", edge: Person },
      output: { kind: "single", edge: Person },
      scope: ["read:Identity:sub"],
    };
    const unscoped: NodeDecl = {
      name: "birthday",
      input: { kind: "single", edge: Person },
      output: { kind: "single", edge: Person },
    };

    expect(exportContract(scoped).scope).toEqual(["read:Identity:sub"]);
    expect(exportContract(unscoped)).not.toHaveProperty("scope");
  });
});

describe("exportContract — properties", () => {
  it("carries declared properties into the sealed contract", () => {
    const property = {
      name: "increments age by one",
      description: "A birthday advances the person's age by exactly one year.",
      expr: { eq: [{ get: "output.age" }, { add: [{ get: "input.age" }, { lit: 1 }] }] },
    } as const;

    const node: NodeDecl = {
      name: "birthday",
      input: { kind: "single", edge: Person },
      output: { kind: "single", edge: Person },
      properties: [property],
    };

    expect(exportContract(node).properties).toEqual([property]);
  });

  it("omits the key when no properties are declared", () => {
    const node: NodeDecl = {
      name: "birthday",
      input: { kind: "single", edge: Person },
      output: { kind: "single", edge: Person },
    };

    expect(exportContract(node)).not.toHaveProperty("properties");
  });
});
