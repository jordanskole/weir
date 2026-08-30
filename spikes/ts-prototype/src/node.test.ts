import { describe, expect, it } from "vitest";
import { allOf, defineEdge, defineField, defineNode, many, oneOf, single } from "./define.js";
import { Unit } from "./types.js";

const Person = defineEdge({
  name: "Person",
  label: "Person",
  description: "A person",
  fields: {
    age: defineField({ type: "uint8", label: "Age", description: "The person's age", nullable: false }),
  },
});

const Pass = defineEdge({
  name: "Pass",
  label: "Pass",
  description: "A passing test result",
  fields: {},
});
const Fail = defineEdge({
  name: "Fail",
  label: "Fail",
  description: "A failing test result",
  fields: {},
});

const Address = defineEdge({
  name: "Address",
  label: "Address",
  description: "A mailing address",
  fields: {
    street: defineField({
      type: "utf8",
      label: "Street",
      description: "Street address",
      nullable: false,
    }),
  },
});

const PersonWithAddress = defineEdge({
  name: "PersonWithAddress",
  label: "Person with address",
  description: "A person with a nested address edge",
  fields: {
    name: defineField({
      type: "utf8",
      label: "Name",
      description: "The person's name",
      nullable: false,
    }),
    address: Address,
  },
});

const Task = defineEdge({
  name: "Task",
  label: "Task",
  description: "A task",
  index: "id",
  fields: {
    id: defineField({ type: "utf8", label: "ID", description: "The task's id", nullable: false }),
    title: defineField({
      type: "utf8",
      label: "Title",
      description: "The task's title",
      nullable: false,
    }),
  },
});

const TaskWithDueDate = defineEdge({
  name: "TaskWithDueDate",
  label: "Task with due date",
  description: "A task that may or may not have a due date",
  fields: {
    title: defineField({
      type: "utf8",
      label: "Title",
      description: "The task's title",
      nullable: false,
    }),
    due_at: defineField({
      type: "datetime",
      label: "Due At",
      description: "When the task is due, if it has one",
      nullable: true,
    }),
  },
});

const TaskList = defineEdge({
  name: "TaskList",
  label: "Task list",
  description: "A list of tasks",
  fields: {
    title: defineField({
      type: "utf8",
      label: "Title",
      description: "The list's title",
      nullable: false,
    }),
    tasks: { many: Task },
  },
});

describe("defineNode", () => {
  it("returns the input reference unchanged", () => {
    const node = {
      name: "noop",
      input: single(Person),
      output: single(Person),
      fn: (person: { age: number }) => person,
      closure: { literal: { age: 42 } }
    };
    expect(defineNode(node)).toBe(node);
  });

  it("types a rhombus node and matches the step-zero netlist's birthday example", () => {
    // examples/person-birthday/netlist.json: Person { age: 41 } | birthday | expect Person { age: 42 }
    const birthday = defineNode({
      name: "birthday",
      input: single(Person),
      output: single(Person),
      fn: (person) => ({ age: person.age + 1 }),
      examples: [{ given: { age: 41 }, expect: { age: 42 } }],
    });

    for (const example of birthday.examples ?? []) {
      expect(birthday.fn(example.given)).toEqual(example.expect);
    }
  });

  it("types a oneOf node and matches the step-zero netlist's expect_Person_age_42", () => {
    const expectPersonAge42 = defineNode({
      name: "expect_Person_age_42",
      input: single(Person),
      output: oneOf(Pass, Fail),
      closure: { expected: { age: 42 } },
      fn: (person) =>
        person.age === 42 ? { edge: "Pass", payload: {} } : { edge: "Fail", payload: {} },
    });

    expect(expectPersonAge42.fn({ age: 42 })).toEqual({ edge: "Pass", payload: {} });
    expect(expectPersonAge42.fn({ age: 41 })).toEqual({ edge: "Fail", payload: {} });
  });

  it("types an origin node against Unit instead of null input", () => {
    // examples/person-birthday/netlist.json's origin_Person_literal, with input:null
    // resolved to input:Unit (docs/design.md §5: "the only special edge").
    const originPersonLiteral = defineNode({
      name: "origin_Person_literal",
      input: single(Unit),
      output: single(Person),
      closure: { literal: { age: 41 } },
      fn: () => ({ age: 41 }),      
    });

    expect(originPersonLiteral.fn({})).toEqual({ age: 41 });
  });

  it("types an allOf node — every branch fires (docs/design-history.md, place_order example)", () => {
    const OrderPlaced = defineEdge({
      name: "OrderPlaced",
      label: "Order placed",
      description: "An order was placed",
      fields: {},
    });
    const InvoiceRequested = defineEdge({
      name: "InvoiceRequested",
      label: "Invoice requested",
      description: "An invoice was requested",
      fields: {},
    });
    const InventoryReserved = defineEdge({
      name: "InventoryReserved",
      label: "Inventory reserved",
      description: "Inventory was reserved",
      fields: {},
    });

    const placeOrder = defineNode({
      name: "place_order",
      input: single(OrderPlaced),
      output: allOf(InvoiceRequested, InventoryReserved),
      fn: () => [
        { edge: "InvoiceRequested", payload: {} },
        { edge: "InventoryReserved", payload: {} },
      ] as const,
    });

    expect(placeOrder.fn({})).toEqual([
      { edge: "InvoiceRequested", payload: {} },
      { edge: "InventoryReserved", payload: {} },
    ]);
  });

  it("types a many node — a collection keyed by the referenced edge's index, not an array", () => {
    const relatedTasks = defineNode({
      name: "relatedTasks",
      input: single(Person),
      output: many(Task),
      fn: () => ({
        "task-1": { id: "task-1", title: "Groceries" },
        "task-2": { id: "task-2", title: "Laundry" },
      }),
    });

    expect(relatedTasks.fn({ age: 10 })).toEqual({
      "task-1": { id: "task-1", title: "Groceries" },
      "task-2": { id: "task-2", title: "Laundry" },
    });
  });

  it("types a node whose input edge has a nested compound (edge-valued) field", () => {
    const greet = defineNode({
      name: "greet",
      input: single(PersonWithAddress),
      output: single(PersonWithAddress),
      fn: (person) => ({
        ...person,
        name: `${person.name} of ${person.address.street}`,
      }),
    });

    expect(greet.fn({ name: "Ada", address: { street: "1 Infinite Loop" } })).toEqual({
      name: "Ada of 1 Infinite Loop",
      address: { street: "1 Infinite Loop" },
    });
  });

  it("types a node whose input edge has a many-of-compound-edge field", () => {
    const summarize = defineNode({
      name: "summarize",
      input: single(TaskList),
      output: single(TaskList),
      fn: (list) => ({
        ...list,
        title: `${list.title} (${Object.keys(list.tasks).length} tasks)`,
      }),
    });

    expect(
      summarize.fn({
        title: "Groceries",
        tasks: { "task-1": { id: "task-1", title: "Milk" }, "task-2": { id: "task-2", title: "Eggs" } },
      }),
    ).toEqual({
      title: "Groceries (2 tasks)",
      tasks: { "task-1": { id: "task-1", title: "Milk" }, "task-2": { id: "task-2", title: "Eggs" } },
    });
  });

  it("types a node whose input edge has a nullable field", () => {
    const describeDueDate = defineNode({
      name: "describe_due_date",
      input: single(TaskWithDueDate),
      output: single(TaskWithDueDate),
      fn: (task) => ({
        ...task,
        title:
          task.due_at === null ? `${task.title} (no due date)` : `${task.title} (due ${task.due_at})`,
      }),
    });

    expect(describeDueDate.fn({ title: "Ship it", due_at: null })).toEqual({
      title: "Ship it (no due date)",
      due_at: null,
    });
    expect(
      describeDueDate.fn({ title: "Ship it", due_at: "2026-09-01T00:00:00Z" }),
    ).toEqual({
      title: "Ship it (due 2026-09-01T00:00:00Z)",
      due_at: "2026-09-01T00:00:00Z",
    });
  });
});
