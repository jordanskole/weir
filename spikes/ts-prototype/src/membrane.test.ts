import { describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, single } from "./define.js";
import { membrane } from "./membrane.js";

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
  input: Person,
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

  it("rejects a payload missing a required field, before fn runs", async () => {
    let called = false;
    const node = defineNode({ ...birthday, fn: (p) => { called = true; return p; } });
    await expect(membrane(node)({ nickname: null })).rejects.toThrow(/age/);
    expect(called).toBe(false);
  });

  it("rejects the wrong type for a field", async () => {
    await expect(membrane(birthday)({ age: "old", nickname: null })).rejects.toThrow(/age/);
  });

  it("rejects null for a non-nullable field", async () => {
    await expect(membrane(birthday)({ age: null, nickname: null })).rejects.toThrow(/age/);
  });

  it("accepts null for a nullable field", async () => {
    await expect(membrane(birthday)({ age: 5, nickname: null })).resolves.toEqual({ age: 6, nickname: null });
  });

  it("rejects a non-object payload", async () => {
    await expect(membrane(birthday)("nope")).rejects.toThrow(/Person/);
    await expect(membrane(birthday)(null)).rejects.toThrow(/Person/);
    await expect(membrane(birthday)([])).rejects.toThrow(/Person/);
  });

  it("lists every violation, not just the first", async () => {
    await expect(membrane(birthday)({ age: "old", nickname: 5 })).rejects.toThrow(/age/);
    await expect(membrane(birthday)({ age: "old", nickname: 5 })).rejects.toThrow(/nickname/);
  });
});
