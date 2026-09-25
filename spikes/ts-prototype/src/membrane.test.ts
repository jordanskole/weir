import { describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, allOf, single } from "./define.js";
import { InMemoryLog, assertPayload, membrane } from "./membrane.js";
import { hashNode } from "./hash.js";

const Person = defineEdge({
  name: "Person",
  label: "Person",
  description: "A person",
  fields: {
    age: defineField({ type: "uint8", label: "Age", description: "The person's age", nullable: false }),
    nickname: defineField({ type: "utf8", label: "Nickname", description: "A nickname", nullable: true }),
  },
});

const birthday = defineNode({
  name: "birthday",
  input: single(Person),
  output: single(Person),
  fn: (person) => ({ ...person, age: person.age + 1 }),
});

describe("membrane", () => {
  it("calls fn with a payload that matches the node's declared input edge", async () => {
    const invocation = await membrane(birthday, { age: 41, nickname: null }, { correlationId: "thread-1" });
    expect(invocation.result).toEqual({ age: 42, nickname: null });
    expect(invocation.envelope).toBeDefined();
  });

  it("is derived purely from the NodeDef — no separate configuration", async () => {
    // Same node, a second membrane() call: nothing to pass but the NodeDef itself
    // and this invocation's own arguments.
    const invocation = await membrane(birthday, { age: 10, nickname: "Bird" }, { correlationId: "thread-1" });
    expect(invocation.result).toEqual({ age: 11, nickname: "Bird" });
  });

  it("resolves to Failed<In>, carrying the original payload, when a required field is missing — fn never runs, but the attempt still carries a real envelope", async () => {
    let called = false;
    const node = defineNode({ ...birthday, fn: (p) => { called = true; return p; } });
    const invocation = await membrane(node, { nickname: null }, { correlationId: "thread-1" });
    expect(invocation.result).toEqual({ input: { nickname: null }, reason: expect.stringMatching(/age/) });
    expect(invocation.envelope).toBeDefined();
    expect(invocation.envelope.node).toBe(node.name);
    expect(invocation.envelope.contractHash).toBe((await hashNode(node)).hash);
    expect(called).toBe(false);
  });

  it("resolves to Failed<In> for the wrong type on a field — envelope present, since buildEnvelope now runs before the assert", async () => {
    const invocation = await membrane(birthday, { age: "old", nickname: null }, { correlationId: "thread-1" });
    expect(invocation.result).toEqual({ input: { age: "old", nickname: null }, reason: expect.stringMatching(/age/) });
    expect(invocation.envelope).toBeDefined();
    expect(invocation.envelope.node).toBe(birthday.name);
  });

  it("resolves to Failed<In> for null on a non-nullable field — envelope present, since buildEnvelope now runs before the assert", async () => {
    const invocation = await membrane(birthday, { age: null, nickname: null }, { correlationId: "thread-1" });
    expect(invocation.result).toEqual({ input: { age: null, nickname: null }, reason: expect.stringMatching(/age/) });
    expect(invocation.envelope).toBeDefined();
    expect(invocation.envelope.node).toBe(birthday.name);
  });

  it("accepts null for a nullable field", async () => {
    const invocation = await membrane(birthday, { age: 5, nickname: null }, { correlationId: "thread-1" });
    expect(invocation.result).toEqual({
      age: 6,
      nickname: null,
    });
  });

  it("resolves to Failed<In> for a non-object payload", async () => {
    expect((await membrane(birthday, "nope", { correlationId: "thread-1" })).result).toEqual({
      input: "nope",
      reason: expect.stringMatching(/Person/),
    });
    expect((await membrane(birthday, null, { correlationId: "thread-1" })).result).toEqual({
      input: null,
      reason: expect.stringMatching(/Person/),
    });
    expect((await membrane(birthday, [], { correlationId: "thread-1" })).result).toEqual({
      input: [],
      reason: expect.stringMatching(/Person/),
    });
  });

  it("lists every violation in Failed<In>.reason, not just the first", async () => {
    const invocation = await membrane(birthday, { age: "old", nickname: 5 }, { correlationId: "thread-1" });
    expect(invocation.result).toEqual({
      input: { age: "old", nickname: 5 },
      reason: expect.stringMatching(/age/),
    });
    expect((invocation.result as { reason: string }).reason).toMatch(/nickname/);
  });

  it("resolves to Failed<In> with the thrown message as reason, when fn throws — envelope present, since Fn ran", async () => {
    const node = defineNode({
      ...birthday,
      fn: () => {
        throw new Error("kaboom");
      },
    });
    const invocation = await membrane(node, { age: 41, nickname: null }, { correlationId: "thread-1" });
    expect(invocation.result).toEqual({ input: { age: 41, nickname: null }, reason: "kaboom" });
    expect(invocation.envelope).toBeDefined();
  });

  it("passes through an explicit Failed<In> a node returns itself — envelope still present, since Fn ran", async () => {
    const node = defineNode({
      ...birthday,
      fn: (p) => ({ input: p, reason: "too old to have a birthday" }),
    });
    const invocation = await membrane(node, { age: 200, nickname: null }, { correlationId: "thread-1" });
    expect(invocation.result).toEqual({ input: { age: 200, nickname: null }, reason: "too old to have a birthday" });
    expect(invocation.envelope).toBeDefined();
  });

  it("resolves to { result, envelope }, where envelope is the exact one Fn saw", async () => {
    // fn returns its own env as the result, so the envelope Fn saw and the
    // envelope the invoke resolves to can be compared by id — not merely
    // asserting some envelope exists on both sides.
    const node = defineNode({ ...birthday, fn: (_person, env) => env });
    const invocation = await membrane(node, { age: 41, nickname: null }, { correlationId: "thread-1" });
    expect(invocation.envelope).toBeDefined();
    expect((invocation.result as { id: string }).id).toBe(invocation.envelope?.id);
  });

  it("still returns a real envelope when the input assert rejects — Fn never ran, but the attempt is observable", async () => {
    const invocation = await membrane(birthday, { age: "old", nickname: null }, { correlationId: "thread-1" });
    expect(invocation.envelope).toBeDefined();
    expect(invocation.envelope.correlationId).toBe("thread-1");
    expect(invocation.envelope.node).toBe(birthday.name);
    expect(invocation.result).toEqual({
      input: { age: "old", nickname: null },
      reason: expect.stringMatching(/age/),
    });
  });
});

describe("Log — staged appends with no envelope", () => {
  it("round-trips a staged append through latest, with no envelope on latestInstance", () => {
    const log = new InMemoryLog();
    log.append("Person", "thread-1", { age: 41, nickname: null });
    expect(log.latest("Person", "thread-1")).toEqual({ age: 41, nickname: null });
    const instance = log.latestInstance("Person", "thread-1");
    expect(instance).toBeDefined();
    expect(instance?.payload).toEqual({ age: 41, nickname: null });
    expect(instance?.envelope).toBeUndefined();
    expect(instance?.id).toBeDefined();
    expect(instance?.seq).toEqual(0);
  });
});

const Address = defineEdge({
  name: "Address",
  label: "Address",
  description: "A mailing address",
  fields: {
    street: defineField({ type: "utf8", label: "Street", description: "Street address", nullable: false }),
  },
});
const PersonWithAddress = defineEdge({
  name: "PersonWithAddress",
  label: "Person with address",
  description: "A person with a nested address",
  fields: {
    name: defineField({ type: "utf8", label: "Name", description: "The person's name", nullable: false }),
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
    title: defineField({ type: "utf8", label: "Title", description: "The task's title", nullable: false }),
  },
});
const TaskWithNoIndex = defineEdge({
  name: "TaskWithNoIndex",
  label: "Task",
  description: "A task with no declared index",
  fields: {
    title: defineField({ type: "utf8", label: "Title", description: "The task's title", nullable: false }),
  },
});
const TaskList = defineEdge({
  name: "TaskList",
  label: "Task list",
  description: "A list of tasks",
  fields: { tasks: { many: Task } },
});

describe("assertPayload — compound fields", () => {
  it("accepts a valid nested-edge payload", () => {
    const payload = assertPayload(PersonWithAddress, { name: "Ada", address: { street: "1 Main St" } });
    expect(payload).toEqual({ name: "Ada", address: { street: "1 Main St" } });
  });

  it("rejects a nested-edge field whose own field has the wrong type", () => {
    expect(() =>
      assertPayload(PersonWithAddress, { name: "Ada", address: { street: 5 } }),
    ).toThrow(/address/);
  });

  it("rejects a compound field that isn't an object", () => {
    expect(() => assertPayload(PersonWithAddress, { name: "Ada", address: "nope" })).toThrow(/address/);
  });
});

describe("assertPayload — many fields", () => {
  it("accepts a collection of valid compound payloads, keyed by the referenced edge's index", () => {
    const payload = assertPayload(TaskList, {
      tasks: { "task-1": { id: "task-1", title: "Buy milk" }, "task-2": { id: "task-2", title: "Walk dog" } },
    });
    expect(payload).toEqual({
      tasks: { "task-1": { id: "task-1", title: "Buy milk" }, "task-2": { id: "task-2", title: "Walk dog" } },
    });
  });

  it("accepts an empty collection", () => {
    expect(assertPayload(TaskList, { tasks: {} })).toEqual({ tasks: {} });
  });

  it("rejects a many field that's an array, not a collection", () => {
    expect(() => assertPayload(TaskList, { tasks: [{ id: "task-1", title: "Buy milk" }] })).toThrow(/tasks/);
  });

  it("rejects a many field that isn't an object at all", () => {
    expect(() => assertPayload(TaskList, { tasks: "nope" })).toThrow(/tasks/);
  });

  it("rejects an invalid entry inside the collection, naming its key", () => {
    expect(() =>
      assertPayload(TaskList, {
        tasks: { "task-1": { id: "task-1", title: "Buy milk" }, "task-2": { id: "task-2", title: 5 } },
      }),
    ).toThrow(/tasks\["task-2"\]/);
  });

  it("rejects an entry keyed inconsistently with its own index field", () => {
    expect(() =>
      assertPayload(TaskList, { tasks: { "task-1": { id: "task-2", title: "Buy milk" } } }),
    ).toThrow(/task-1/);
  });

  it("throws immediately when the referenced edge declares no index at all", () => {
    const badTaskList = defineEdge({
      name: "BadTaskList",
      label: "Bad task list",
      description: "d",
      fields: { tasks: { many: TaskWithNoIndex } },
    });
    expect(() => assertPayload(badTaskList, { tasks: {} })).toThrow(/index/i);
  });

  it("accepts a collection keyed by a numeric index field — object keys are strings, the field value isn't", () => {
    const Sibling = defineEdge({
      name: "Sibling",
      label: "Sibling",
      description: "d",
      index: "age",
      fields: { age: defineField({ type: "uint8", label: "Age", description: "d", nullable: false }) },
    });
    const Siblings = defineEdge({
      name: "Siblings",
      label: "Siblings",
      description: "d",
      fields: { people: { many: Sibling } },
    });
    const payload = assertPayload(Siblings, { people: { "8": { age: 8 }, "12": { age: 12 } } });
    expect(payload).toEqual({ people: { "8": { age: 8 }, "12": { age: 12 } } });
  });
});

describe("assertPayload — literal fields", () => {
  const CompletedTodo = defineEdge({
    name: "CompletedTodo",
    label: "CompletedTodo",
    description: "A todo that's been completed",
    fields: {
      is_complete: { literal: true },
    },
  });

  it("accepts a payload matching the pinned literal value", () => {
    expect(assertPayload(CompletedTodo, { is_complete: true })).toEqual({ is_complete: true });
  });

  it("rejects a payload whose value differs from the pinned literal, with a clear pinned-value error", () => {
    expect(() => assertPayload(CompletedTodo, { is_complete: false })).toThrow(
      /is_complete is pinned to true, got boolean/,
    );
  });
});

describe("assertPayload — validations", () => {
  const Todo = defineEdge({
    name: "Todo",
    label: "Todo",
    description: "A task",
    fields: {
      title: defineField({
        type: "utf8",
        label: "Title",
        description: "d",
        nullable: false,
        validations: { minLength: 10, maxLength: 200 },
      }),
      code: defineField({
        type: "utf8",
        label: "Code",
        description: "d",
        nullable: false,
        validations: { pattern: "^[A-Z]{3}-\\d{4}$" },
      }),
      priority: defineField({
        type: "uint8",
        label: "Priority",
        description: "d",
        nullable: false,
        validations: { min: 1, max: 5 },
      }),
      status: defineField({
        type: "utf8",
        label: "Status",
        description: "d",
        nullable: false,
        enumValues: ["open", "done"],
      }),
    },
  });
  const valid = { title: "Buy the groceries", code: "ABC-1234", priority: 3, status: "open" };

  it("accepts a payload satisfying every validation", () => {
    expect(assertPayload(Todo, valid)).toEqual(valid);
  });

  it("rejects a string shorter than minLength", () => {
    expect(() => assertPayload(Todo, { ...valid, title: "short" })).toThrow(/title.*10/);
  });

  it("rejects a string longer than maxLength", () => {
    expect(() => assertPayload(Todo, { ...valid, title: "x".repeat(201) })).toThrow(/title.*200/);
  });

  it("rejects a string that doesn't match pattern", () => {
    expect(() => assertPayload(Todo, { ...valid, code: "nope" })).toThrow(/code/);
  });

  it("rejects a number below min", () => {
    expect(() => assertPayload(Todo, { ...valid, priority: 0 })).toThrow(/priority.*1/);
  });

  it("rejects a number above max", () => {
    expect(() => assertPayload(Todo, { ...valid, priority: 6 })).toThrow(/priority.*5/);
  });

  it("rejects a value not in enumValues", () => {
    expect(() => assertPayload(Todo, { ...valid, status: "archived" })).toThrow(/status/);
  });

  it("lists validation violations alongside type violations, not just the first", () => {
    let error: Error | undefined;
    try {
      assertPayload(Todo, { ...valid, title: "short", priority: 99 });
    } catch (cause) {
      error = cause as Error;
    }
    expect(error?.message).toMatch(/title/);
    expect(error?.message).toMatch(/priority/);
  });
});

const A = defineEdge({
  name: "A",
  label: "A",
  description: "Edge A",
  fields: { value: defineField({ type: "utf8", label: "Value", description: "A's value", nullable: false }) },
});
const B = defineEdge({
  name: "B",
  label: "B",
  description: "Edge B",
  fields: { value: defineField({ type: "utf8", label: "Value", description: "B's value", nullable: false }) },
});
const C = defineEdge({
  name: "C",
  label: "C",
  description: "Edge C",
  fields: { value: defineField({ type: "utf8", label: "Value", description: "C's value", nullable: false }) },
});

// docs/design.md §5's diamond: a node depending on `allOf: [A, B]` is a
// readiness check against each edge's own log for one correlation_id, not a
// synchronous join — matches the pulse model (docs/design-history.md).
const nodeC = defineNode({
  name: "C",
  input: allOf(A, B),
  output: single(C),
  fn: ({ A, B }) => ({ value: `${A.value}+${B.value}` }),
});

describe("membrane — allOf", () => {
  it("is not ready when only some declared edges are present for this correlation_id", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    await expect(membrane(nodeC, log, { correlationId: "thread-1" })).resolves.toBeUndefined();
  });

  it("is not ready with no edges present at all", async () => {
    const log = new InMemoryLog();
    await expect(membrane(nodeC, log, { correlationId: "thread-1" })).resolves.toBeUndefined();
  });

  it("calls fn once all declared edges are present, keyed by edge name", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("B", "thread-1", { value: "b" });
    const invocation = await membrane(nodeC, log, { correlationId: "thread-1" });
    expect(invocation?.result).toEqual({ value: "a+b" });
    expect(invocation?.envelope).toBeDefined();
  });

  it("doesn't care which order the edges arrived in", async () => {
    const log = new InMemoryLog();
    log.append("B", "thread-1", { value: "b" });
    log.append("A", "thread-1", { value: "a" });
    const invocation = await membrane(nodeC, log, { correlationId: "thread-1" });
    expect(invocation?.result).toEqual({ value: "a+b" });
  });

  it("keeps different correlation_ids independent", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("A", "thread-2", { value: "a2" });
    log.append("B", "thread-2", { value: "b2" });
    await expect(membrane(nodeC, log, { correlationId: "thread-1" })).resolves.toBeUndefined();
    const invocation = await membrane(nodeC, log, { correlationId: "thread-2" });
    expect(invocation?.result).toEqual({ value: "a2+b2" });
  });

  it("reading is not consuming — a second call resolves the same way", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("B", "thread-1", { value: "b" });
    const first = await membrane(nodeC, log, { correlationId: "thread-1" });
    const second = await membrane(nodeC, log, { correlationId: "thread-1" });
    expect(first?.result).toEqual({ value: "a+b" });
    expect(second?.result).toEqual({ value: "a+b" });
  });

  it("resolves to Failed<In>, carrying the raw bag, when one edge's payload fails assertion — envelope present, since buildEnvelope now runs before the assert", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: 5 });
    log.append("B", "thread-1", { value: "b" });
    const invocation = await membrane(nodeC, log, { correlationId: "thread-1" });
    expect(invocation?.result).toEqual({
      input: { A: { value: 5 }, B: { value: "b" } },
      reason: expect.stringMatching(/A/),
    });
    expect(invocation?.envelope).toBeDefined();
    expect(invocation?.envelope?.node).toBe(nodeC.name);
  });

  it("resolves to Failed<In> with the thrown message as reason, when fn throws — envelope present, since Fn ran", async () => {
    const throwing = defineNode({
      ...nodeC,
      fn: () => {
        throw new Error("kaboom");
      },
    });
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("B", "thread-1", { value: "b" });
    const invocation = await membrane(throwing, log, { correlationId: "thread-1" });
    expect(invocation?.result).toEqual({ input: { A: { value: "a" }, B: { value: "b" } }, reason: "kaboom" });
    expect(invocation?.envelope).toBeDefined();
  });
});

describe("membrane — envelope", () => {
  it("does not pass an env argument to an fn declared with one parameter", async () => {
    let receivedArgs = -1;
    const node = defineNode({
      ...birthday,
      fn: (...args: unknown[]) => {
        receivedArgs = args.length;
        return { age: 1, nickname: null };
      },
    });
    await membrane(node, { age: 41, nickname: null }, { correlationId: "thread-1" });
    expect(receivedArgs).toBe(1);
  });

  it("passes a real Envelope as the second argument to an fn declared with two parameters", async () => {
    let received: Record<string, unknown> | undefined;
    const node = defineNode({
      ...birthday,
      fn: (person, env) => {
        received = env as unknown as Record<string, unknown>;
        return person;
      },
    });
    await membrane(node, { age: 41, nickname: null }, { correlationId: "thread-1" });

    expect(received?.correlationId).toBe("thread-1");
    expect(received?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(received?.causationIds).toEqual([]);
    expect(typeof received?.timestamp).toBe("string");
    expect(new Date(received?.timestamp as string).toString()).not.toBe("Invalid Date");
    expect(typeof received?.contractHash).toBe("string");
    expect(received?.identity).toEqual({});
  });

  it("pins the envelope to (node name, contract hash) — the version pin replay needs", async () => {
    let received: Record<string, unknown> | undefined;
    const node = defineNode({
      ...birthday,
      fn: (person, env) => {
        received = env as unknown as Record<string, unknown>;
        return person;
      },
    });
    await membrane(node, { age: 41, nickname: null }, { correlationId: "thread-1" });

    expect(received?.node).toBe(birthday.name);
    expect(received?.contractHash).toBe((await hashNode(birthday)).hash);
  });

  it("gives allOf-input nodes a real Envelope the same way", async () => {
    let received: Record<string, unknown> | undefined;
    const node = defineNode({
      ...nodeC,
      fn: (bag, env) => {
        received = env as unknown as Record<string, unknown>;
        return { value: `${bag.A.value}+${bag.B.value}` };
      },
    });
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("B", "thread-1", { value: "b" });
    await membrane(node, log, { correlationId: "thread-1" });
    expect(received?.correlationId).toBe("thread-1");
  });

  it("gives every envelope a causationIds array, empty when nothing supplied one", async () => {
    const invocation = await membrane(birthday, { age: 41 }, { correlationId: "thread-1" });

    expect(invocation.envelope?.causationIds).toEqual([]);
  });

  it("carries the causationIds its caller supplied", async () => {
    const invocation = await membrane(birthday, { age: 41 }, {
      correlationId: "thread-1",
      causationIds: ["inst-a", "inst-b"],
    });

    expect(invocation.envelope?.causationIds).toEqual(["inst-a", "inst-b"]);
  });
});

describe("membrane — scope", () => {
  it("gives env.identity as {} when no scope is declared, even with a real identity supplied", async () => {
    let received: unknown;
    const node = defineNode({
      ...birthday,
      fn: (person, env) => {
        received = env?.identity;
        return person;
      },
    });
    await membrane(node, { age: 41, nickname: null }, { correlationId: "thread-1", identity: { sub: "user-1", iss: "issuer" } });
    expect(received).toEqual({});
  });

  it("narrows env.identity to only the fields scope names", async () => {
    let received: unknown;
    const node = defineNode({
      ...birthday,
      scope: ["read:Identity:sub"],
      fn: (person, env) => {
        received = env?.identity;
        return person;
      },
    });
    await membrane(node, { age: 41, nickname: null }, { correlationId: "thread-1", identity: { sub: "user-1", iss: "issuer" } });
    expect(received).toEqual({ sub: "user-1" });
  });

  it("defaults to a system identity when the caller supplies none", async () => {
    let received: unknown;
    const node = defineNode({
      ...birthday,
      scope: ["read:Identity:sub"],
      fn: (person, env) => {
        received = env?.identity;
        return person;
      },
    });
    await membrane(node, { age: 41, nickname: null }, { correlationId: "thread-1" });
    expect(received).toEqual({ sub: expect.any(String) });
  });

  it("resolves to Failed<In> when scope names a field Identity doesn't have — no envelope, buildEnvelope threw", async () => {
    const node = defineNode({ ...birthday, scope: ["read:Identity:email"] });
    const invocation = await membrane(node, { age: 41, nickname: null }, {
      correlationId: "thread-1",
      identity: { sub: "user-1", iss: "issuer" },
    });
    expect(invocation.result).toEqual({
      input: { age: 41, nickname: null },
      reason: expect.stringMatching(/email/),
    });
    expect(invocation.envelope).toBeUndefined();
  });

  it("resolves to Failed<In> when scope names an edge other than Identity — no envelope, buildEnvelope threw", async () => {
    const node = defineNode({ ...birthday, scope: ["read:Person:age"] });
    const invocation = await membrane(node, { age: 41, nickname: null }, {
      correlationId: "thread-1",
      identity: { sub: "user-1", iss: "issuer" },
    });
    expect(invocation.result).toEqual({
      input: { age: 41, nickname: null },
      reason: expect.stringMatching(/Person/),
    });
    expect(invocation.envelope).toBeUndefined();
  });

  it("resolves to Failed<In> for an unsupported verb — no envelope, buildEnvelope threw", async () => {
    const node = defineNode({ ...birthday, scope: ["write:Identity:sub"] });
    const invocation = await membrane(node, { age: 41, nickname: null }, {
      correlationId: "thread-1",
      identity: { sub: "user-1", iss: "issuer" },
    });
    expect(invocation.result).toEqual({
      input: { age: 41, nickname: null },
      reason: expect.stringMatching(/write/),
    });
    expect(invocation.envelope).toBeUndefined();
  });
});

describe("InMemoryLog — retention", () => {
  it("retains every appended instance rather than overwriting", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.append("Person", "c1", { age: 42 });

    expect(log.instances("Person", "c1").map((i) => i.payload)).toEqual([{ age: 41 }, { age: 42 }]);
  });

  it("still returns the most recent instance from latest and latestInstance", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.append("Person", "c1", { age: 42 });

    expect(log.latest("Person", "c1")).toEqual({ age: 42 });
    expect(log.latestInstance("Person", "c1")?.payload).toEqual({ age: 42 });
  });

  it("keeps correlations and edge types separate", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.append("Person", "c2", { age: 1 });
    log.append("Pet", "c1", { species: "cat" });

    expect(log.instances("Person", "c1")).toHaveLength(1);
    expect(log.instances("Person", "c2")).toHaveLength(1);
    expect(log.instances("Pet", "c1")).toHaveLength(1);
  });

  it("returns an empty array for an edge type never appended", () => {
    expect(new InMemoryLog().instances("Nothing", "c1")).toEqual([]);
  });

  it("mints a monotonic seq across edge types, not per edge type", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.append("Pet", "c1", { species: "cat" });
    log.append("Person", "c1", { age: 42 });

    const seqs = [
      log.instances("Person", "c1")[0].seq,
      log.instances("Pet", "c1")[0].seq,
      log.instances("Person", "c1")[1].seq,
    ];
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);
  });

  it("mints a distinct id per instance and returns it from append", () => {
    const log = new InMemoryLog();
    const first = log.append("Person", "c1", { age: 41 });
    const second = log.append("Person", "c1", { age: 41 });

    expect(first).not.toBe(second);
    expect(log.instances("Person", "c1").map((i) => i.id)).toEqual([first, second]);
  });

  it("does not let a returned instances array mutate the log", () => {
    const log = new InMemoryLog();
    log.append("Person", "c1", { age: 41 });
    log.instances("Person", "c1").push({ id: "x", seq: 99, payload: { age: 0 } });

    expect(log.instances("Person", "c1")).toHaveLength(1);
  });
});
