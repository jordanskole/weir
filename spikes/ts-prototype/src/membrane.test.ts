import { describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, every, single } from "./define.js";
import { InMemoryLog, assertPayload, membrane } from "./membrane.js";

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
    const invoke = membrane(birthday);
    await expect(invoke({ age: 41, nickname: null })).resolves.toEqual({ age: 42, nickname: null });
  });

  it("is derived purely from the NodeDef — no separate configuration", async () => {
    // Same node, a second membrane() call: nothing to pass but the NodeDef itself.
    const invoke = membrane(birthday);
    await expect(invoke({ age: 10, nickname: "Bird" })).resolves.toEqual({ age: 11, nickname: "Bird" });
  });

  it("resolves to Failed<In>, carrying the original payload, when a required field is missing — fn never runs", async () => {
    let called = false;
    const node = defineNode({ ...birthday, fn: (p) => { called = true; return p; } });
    const result = await membrane(node)({ nickname: null });
    expect(result).toEqual({ input: { nickname: null }, reason: expect.stringMatching(/age/) });
    expect(called).toBe(false);
  });

  it("resolves to Failed<In> for the wrong type on a field", async () => {
    const result = await membrane(birthday)({ age: "old", nickname: null });
    expect(result).toEqual({ input: { age: "old", nickname: null }, reason: expect.stringMatching(/age/) });
  });

  it("resolves to Failed<In> for null on a non-nullable field", async () => {
    const result = await membrane(birthday)({ age: null, nickname: null });
    expect(result).toEqual({ input: { age: null, nickname: null }, reason: expect.stringMatching(/age/) });
  });

  it("accepts null for a nullable field", async () => {
    await expect(membrane(birthday)({ age: 5, nickname: null })).resolves.toEqual({ age: 6, nickname: null });
  });

  it("resolves to Failed<In> for a non-object payload", async () => {
    expect(await membrane(birthday)("nope")).toEqual({ input: "nope", reason: expect.stringMatching(/Person/) });
    expect(await membrane(birthday)(null)).toEqual({ input: null, reason: expect.stringMatching(/Person/) });
    expect(await membrane(birthday)([])).toEqual({ input: [], reason: expect.stringMatching(/Person/) });
  });

  it("lists every violation in Failed<In>.reason, not just the first", async () => {
    const result = await membrane(birthday)({ age: "old", nickname: 5 });
    expect(result).toEqual({
      input: { age: "old", nickname: 5 },
      reason: expect.stringMatching(/age/),
    });
    expect((result as { reason: string }).reason).toMatch(/nickname/);
  });

  it("resolves to Failed<In> with the thrown message as reason, when fn throws", async () => {
    const node = defineNode({
      ...birthday,
      fn: () => {
        throw new Error("kaboom");
      },
    });
    const result = await membrane(node)({ age: 41, nickname: null });
    expect(result).toEqual({ input: { age: 41, nickname: null }, reason: "kaboom" });
  });

  it("passes through an explicit Failed<In> a node returns itself", async () => {
    const node = defineNode({
      ...birthday,
      fn: (p) => ({ input: p, reason: "too old to have a birthday" }),
    });
    const result = await membrane(node)({ age: 200, nickname: null });
    expect(result).toEqual({ input: { age: 200, nickname: null }, reason: "too old to have a birthday" });
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
  it("accepts an array of valid compound payloads", () => {
    const payload = assertPayload(TaskList, { tasks: [{ title: "Buy milk" }, { title: "Walk dog" }] });
    expect(payload).toEqual({ tasks: [{ title: "Buy milk" }, { title: "Walk dog" }] });
  });

  it("accepts an empty array", () => {
    expect(assertPayload(TaskList, { tasks: [] })).toEqual({ tasks: [] });
  });

  it("rejects a many field that isn't an array", () => {
    expect(() => assertPayload(TaskList, { tasks: { title: "Buy milk" } })).toThrow(/tasks/);
  });

  it("rejects an invalid item inside the array, naming its index", () => {
    expect(() =>
      assertPayload(TaskList, { tasks: [{ title: "Buy milk" }, { title: 5 }] }),
    ).toThrow(/tasks\[1\]/);
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

// docs/design.md §5's diamond: a node depending on `every: [A, B]` is a
// readiness check against each edge's own log for one correlation_id, not a
// synchronous join — matches the pulse model (docs/design-history.md).
const nodeC = defineNode({
  name: "C",
  input: every(A, B),
  output: single(C),
  fn: ({ A, B }) => ({ value: `${A.value}+${B.value}` }),
});

describe("membrane — every", () => {
  it("is not ready when only some declared edges are present for this correlation_id", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    await expect(membrane(nodeC)("thread-1", log)).resolves.toBeUndefined();
  });

  it("is not ready with no edges present at all", async () => {
    const log = new InMemoryLog();
    await expect(membrane(nodeC)("thread-1", log)).resolves.toBeUndefined();
  });

  it("calls fn once every declared edge is present, keyed by edge name", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("B", "thread-1", { value: "b" });
    await expect(membrane(nodeC)("thread-1", log)).resolves.toEqual({ value: "a+b" });
  });

  it("doesn't care which order the edges arrived in", async () => {
    const log = new InMemoryLog();
    log.append("B", "thread-1", { value: "b" });
    log.append("A", "thread-1", { value: "a" });
    await expect(membrane(nodeC)("thread-1", log)).resolves.toEqual({ value: "a+b" });
  });

  it("keeps different correlation_ids independent", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("A", "thread-2", { value: "a2" });
    log.append("B", "thread-2", { value: "b2" });
    await expect(membrane(nodeC)("thread-1", log)).resolves.toBeUndefined();
    await expect(membrane(nodeC)("thread-2", log)).resolves.toEqual({ value: "a2+b2" });
  });

  it("reading is not consuming — a second call resolves the same way", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("B", "thread-1", { value: "b" });
    await expect(membrane(nodeC)("thread-1", log)).resolves.toEqual({ value: "a+b" });
    await expect(membrane(nodeC)("thread-1", log)).resolves.toEqual({ value: "a+b" });
  });

  it("resolves to Failed<In>, carrying the raw bag, when one edge's payload fails assertion", async () => {
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: 5 });
    log.append("B", "thread-1", { value: "b" });
    const result = await membrane(nodeC)("thread-1", log);
    expect(result).toEqual({
      input: { A: { value: 5 }, B: { value: "b" } },
      reason: expect.stringMatching(/A/),
    });
  });

  it("resolves to Failed<In> with the thrown message as reason, when fn throws", async () => {
    const throwing = defineNode({
      ...nodeC,
      fn: () => {
        throw new Error("kaboom");
      },
    });
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("B", "thread-1", { value: "b" });
    const result = await membrane(throwing)("thread-1", log);
    expect(result).toEqual({ input: { A: { value: "a" }, B: { value: "b" } }, reason: "kaboom" });
  });
});
