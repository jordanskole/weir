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
});
