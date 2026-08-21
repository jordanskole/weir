import { describe, expect, it } from "vitest";
import { assertEdgeHash, hashEdge, hashEdges } from "./hash.js";
import type { AnyEdgeDef, EdgeDef } from "./types.js";

const base: EdgeDef = {
  name: "example",
  description: "A test edge",
  fields: {
    id: { type: "uint32", label: "ID", description: "The record id" },
    amount: {
      type: "f32",
      label: "Amount",
      description: "The transaction amount",
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
      fields: { ...base.fields, id: { type: "utf8", label: "ID", description: "The record id" } },
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
      fields: { ...base.fields, id: { ...base.fields.id!, validations: { min: 0, max: 10 } } },
    };
    expect((await hashEdge(mutated)).hash).not.toBe((await hashEdge(base)).hash);
  });

  it("changes when a field's minLength/maxLength/pattern changes", async () => {
    const withStringConstraints: EdgeDef = {
      name: "example2",
      description: "A test edge",
      fields: {
        name: {
          type: "utf8",
          label: "Name",
          description: "A name",
          validations: { minLength: 1, maxLength: 20, pattern: "^[a-z]+$" },
        },
      },
    };
    const withoutStringConstraints: EdgeDef = {
      name: "example2",
      description: "A test edge",
      fields: { name: { type: "utf8", label: "Name", description: "A name" } },
    };
    expect((await hashEdge(withStringConstraints)).hash).not.toBe(
      (await hashEdge(withoutStringConstraints)).hash,
    );
  });

  it("changes when a compound (nested-edge) field's own shape changes", async () => {
    const withUtf8Street: AnyEdgeDef = {
      name: "PersonWithAddress",
      description: "A test edge",
      fields: {
        address: {
          name: "Address",
          description: "A mailing address",
          fields: { street: { type: "utf8", label: "Street", description: "d" } },
        },
      },
    };
    const withUint8Street: AnyEdgeDef = {
      name: "PersonWithAddress",
      description: "A test edge",
      fields: {
        address: {
          name: "Address",
          description: "A mailing address",
          fields: { street: { type: "uint8", label: "Street", description: "d" } },
        },
      },
    };
    expect((await hashEdge(withUtf8Street)).hash).not.toBe((await hashEdge(withUint8Street)).hash);
  });

  it("produces distinct hashes for a field without optional fingerprint keys vs with them", async () => {
    const bare: EdgeDef = {
      name: base.name,
      description: "A test edge",
      fields: { id: { type: "uint32", label: "ID", description: "The record id" } },
    };
    expect((await hashEdge(bare)).hash).not.toBe((await hashEdge(base)).hash);
  });
});

describe("hashEdges", () => {
  it("returns a record keyed by edge name", async () => {
    const other: EdgeDef = {
      name: "other",
      description: "A test edge",
      fields: { id: { type: "uint32", label: "ID", description: "The record id" } },
    };
    const result = await hashEdges([base, other]);
    expect(Object.keys(result)).toEqual(["example", "other"]);
    expect(result.example!.hash).toBe((await hashEdge(base)).hash);
  });

  it("returns an empty object for an empty input", async () => {
    expect(await hashEdges([])).toEqual({});
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
