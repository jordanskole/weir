import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { allOf, defineEdge, defineNode, many, oneOf, single } from "./define.js";
import { elaborate, type Elaborated } from "./elaborate.js";
import { hashEdge } from "./hash.js";
import { serializeNetlist } from "./netlist.js";
import type { AnyEdgeDef } from "./types.js";

const PERSON_BIRTHDAY_SRC = fileURLToPath(
  new URL("../../../examples/person-birthday/src", import.meta.url),
);

const Person: AnyEdgeDef = defineEdge({
  name: "Person",
  label: "Person",
  description: "A person",
  fields: {
    age: { type: "uint8", label: "Age", description: "Age in years", nullable: false },
  },
});

const Address: AnyEdgeDef = defineEdge({
  name: "Address",
  label: "Address",
  description: "A mailing address",
  fields: {
    street: { type: "utf8", label: "Street", description: "Street address", nullable: false },
  },
});

const PersonWithAddress: AnyEdgeDef = defineEdge({
  name: "PersonWithAddress",
  label: "Person with address",
  description: "A person plus their address",
  fields: { age: Person.fields.age!, address: Address },
});

const Pet: AnyEdgeDef = defineEdge({
  name: "Pet",
  label: "Pet",
  description: "A pet",
  index: "id",
  fields: {
    id: { type: "utf8", label: "Id", description: "The pet's id", nullable: false },
  },
});

const Household: AnyEdgeDef = defineEdge({
  name: "Household",
  label: "Household",
  description: "A household",
  fields: { pets: { many: Pet } },
});

const Pass: AnyEdgeDef = defineEdge({ name: "Pass", label: "Pass", description: "Passed", fields: {} });
const Fail: AnyEdgeDef = defineEdge({ name: "Fail", label: "Fail", description: "Failed", fields: {} });

function elaborated(overrides: Partial<Elaborated>): Elaborated {
  return { fields: {}, edges: {}, nodes: {}, wiring: { origins: [], feeds: {} }, ...overrides };
}

describe("serializeNetlist — edges", () => {
  it("serializes a scalar-only edge's fields verbatim, plus its schemaHash", async () => {
    const netlist = await serializeNetlist(elaborated({ edges: { Person } }));

    expect(netlist.edges.Person!.fields.age).toEqual(Person.fields.age);
    expect(netlist.edges.Person!.schemaHash).toBe((await hashEdge(Person)).short);
  });

  it("serializes a compound field as an { edge: name } reference, not embedded", async () => {
    const netlist = await serializeNetlist(
      elaborated({ edges: { Person, Address, PersonWithAddress } }),
    );

    expect(netlist.edges.PersonWithAddress!.fields.address).toEqual({ edge: "Address" });
  });

  it("serializes a many field as a { many: name } reference", async () => {
    const netlist = await serializeNetlist(elaborated({ edges: { Pet, Household } }));

    expect(netlist.edges.Household!.fields.pets).toEqual({ many: "Pet" });
  });
});

describe("serializeNetlist — nodes", () => {
  it("serializes single input/output as bare edge names", async () => {
    const birthday = defineNode({
      name: "birthday",
      input: single(Person),
      output: single(Person),
      fn: (p) => p,
    });

    const netlist = await serializeNetlist(
      elaborated({ edges: { Person }, nodes: { birthday } }),
    );

    expect(netlist.nodes.birthday).toEqual({ input: "Person", output: "Person" });
  });

  it("serializes an allOf input as { allOf: [...] } of edge names", async () => {
    const node = defineNode({
      name: "combine",
      input: allOf(Person, Address),
      output: single(Person),
      fn: (p) => p.Person,
    });

    const netlist = await serializeNetlist(
      elaborated({ edges: { Person, Address }, nodes: { combine: node } }),
    );

    expect(netlist.nodes.combine!.input).toEqual({ allOf: ["Person", "Address"] });
  });

  it("serializes oneOf/allOf/many outputs as tagged shapes with edge names", async () => {
    const oneOfNode = defineNode({
      name: "expect_Person_age_42",
      input: single(Person),
      output: oneOf(Pass, Fail),
      fn: () => ({ edge: "Pass", payload: {} }),
    });
    const allOfNode = defineNode({
      name: "split",
      input: single(Person),
      output: allOf(Pass, Fail),
      fn: () => [
        { edge: "Pass", payload: {} },
        { edge: "Fail", payload: {} },
      ],
    });
    const manyNode = defineNode({
      name: "spawnPets",
      input: single(Person),
      output: many(Pet),
      fn: () => ({}),
    });

    const netlist = await serializeNetlist(
      elaborated({
        edges: { Person, Pass, Fail, Pet },
        nodes: { expect_Person_age_42: oneOfNode, split: allOfNode, spawnPets: manyNode },
      }),
    );

    expect(netlist.nodes.expect_Person_age_42!.output).toEqual({ oneOf: ["Pass", "Fail"] });
    expect(netlist.nodes.split!.output).toEqual({ allOf: ["Pass", "Fail"] });
    expect(netlist.nodes.spawnPets!.output).toEqual({ many: "Pet" });
  });

  it("includes label/description/closure/examples/scope only when present", async () => {
    const bare = defineNode({ name: "bare", input: single(Person), output: single(Person), fn: (p) => p });
    const rich = defineNode({
      name: "rich",
      label: "Rich",
      description: "Has everything",
      input: single(Person),
      output: single(Person),
      closure: { literal: { age: 41 } },
      examples: [{ given: { age: 1 }, expect: { age: 1 } }],
      scope: ["read:Identity:sub"],
      fn: (p) => p,
    });

    const netlist = await serializeNetlist(
      elaborated({ edges: { Person }, nodes: { bare, rich } }),
    );

    expect(netlist.nodes.bare).toStrictEqual({ input: "Person", output: "Person" });
    expect(netlist.nodes.rich).toStrictEqual({
      input: "Person",
      output: "Person",
      label: "Rich",
      description: "Has everything",
      closure: { literal: { age: 41 } },
      examples: [{ given: { age: 1 }, expect: { age: 1 } }],
      scope: ["read:Identity:sub"],
    });
  });
});

describe("serializeNetlist — topology", () => {
  it("serializes wiring into origins/instances/wires with `${name}#1` instance ids", async () => {
    const netlist = await serializeNetlist(
      elaborated({
        wiring: { origins: ["birthday"], feeds: { birthday: ["expect_Person_age_42"] } },
      }),
    );

    expect(netlist.topology).toEqual({
      origins: ["birthday#1"],
      instances: {
        "birthday#1": { node: "birthday" },
        "expect_Person_age_42#1": { node: "expect_Person_age_42" },
      },
      wires: [{ from: "birthday#1", to: "expect_Person_age_42#1" }],
    });
  });

  it("gives a declared-but-unwired node no instance", async () => {
    const netlist = await serializeNetlist(
      elaborated({
        nodes: {
          birthday: defineNode({ name: "birthday", input: single(Person), output: single(Person), fn: (p) => p }),
        },
        wiring: { origins: [], feeds: {} },
      }),
    );

    expect(netlist.topology).toEqual({ origins: [], instances: {}, wires: [] });
  });
});

describe("serializeNetlist — round-trips the real person-birthday fixture", () => {
  it("elaborates and serializes the on-disk fixture into a consistent netlist", async () => {
    const elaboratedResult = await elaborate(PERSON_BIRTHDAY_SRC);
    const netlist = await serializeNetlist(elaboratedResult);

    expect(netlist.edges.Person!.fields.age).toMatchObject({ type: "uint8" });
    expect(netlist.edges.Person!.schemaHash).toBe(
      (await hashEdge(elaboratedResult.edges.Person!)).short,
    );

    // PersonWithAddress is a real compound-field edge on disk (not a synthetic
    // fixture) — its "address" field holds a full nested EdgeDef in memory and
    // must flatten to a name reference, not an embedded copy of Address.
    expect(netlist.edges.PersonWithAddress!.fields.address).toEqual({ edge: "Address" });
    expect(netlist.edges.PersonWithAddress!.fields.email).toEqual(elaboratedResult.fields.email);

    // Failed_PersonWithAddress is synthesized by elaborate(), not hand-authored —
    // its "input" field is itself a compound reference back to PersonWithAddress,
    // proving the flattening applies uniformly to synthesized edges too.
    expect(netlist.edges.Failed_PersonWithAddress!.fields.input).toEqual({
      edge: "PersonWithAddress",
    });
    expect(netlist.edges.Failed_PersonWithAddress!.fields.reason).toMatchObject({ type: "utf8" });

    expect(netlist.nodes.birthday).toMatchObject({ input: "Person", output: "Person" });
    expect(netlist.nodes.expect_Person_age_42).toMatchObject({
      input: "Person",
      output: { oneOf: ["Pass", "Fail"] },
    });

    expect(netlist.topology).toEqual({
      origins: ["birthday#1"],
      instances: {
        "birthday#1": { node: "birthday" },
        "expect_Person_age_42#1": { node: "expect_Person_age_42" },
      },
      wires: [{ from: "birthday#1", to: "expect_Person_age_42#1" }],
    });
  });
});
