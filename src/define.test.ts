import { describe, expect, it } from "vitest";
import { defineEdge, defineField } from "./define.js";
import type { EdgeDef, FieldDef } from "./types.js";

describe("defineField", () => {
  it("returns the input reference unchanged", () => {
    const field: FieldDef<"uint8"> = { type: "uint8" };
    expect(defineField(field)).toBe(field);
  });
});

describe("defineEdge", () => {
  it("returns the input reference unchanged", () => {
    const edge: EdgeDef = {
      name: "Person",
      fields: { age: { type: "uint8" } },
    };
    expect(defineEdge(edge)).toBe(edge);
  });
});
