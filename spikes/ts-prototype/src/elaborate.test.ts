import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elaborate, parseEdgeFile, parseFieldFile } from "./elaborate.js";

const PERSON_BIRTHDAY_SRC = fileURLToPath(
  new URL("../../../examples/person-birthday/src", import.meta.url),
);

let dir: string | undefined;

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

async function writeFixture(files: Record<string, string>): Promise<string> {
  dir = await mkdtemp(join(tmpdir(), "weir-elaborate-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = join(dir, relPath);
    await mkdir(join(fullPath, ".."), { recursive: true });
    await writeFile(fullPath, content, "utf8");
  }
  return dir;
}

describe("parseFieldFile", () => {
  it("parses a valid .field YAML string into its declared name and FieldDef", () => {
    const yaml = `
name: email
type: utf8
label: Email
description: An email address
validations:
  pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
`;
    const { name, field } = parseFieldFile(yaml);
    expect(name).toBe("email");
    expect(field).toEqual({
      type: "utf8",
      label: "Email",
      description: "An email address",
      validations: { pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" },
    });
  });

  it("rejects a .field file missing a name", () => {
    const yaml = `
type: utf8
label: Email
description: An email address
`;
    expect(() => parseFieldFile(yaml)).toThrow(/name/i);
  });

  it("runs the parsed field through defineField's validation", () => {
    const yaml = `
name: age
type: uint8
label: Age
description: A person's age
validations:
  min: -5
`;
    expect(() => parseFieldFile(yaml)).toThrow(/min/i);
  });
});

describe("parseEdgeFile", () => {
  it("parses an .edge file with only inline scalar fields", () => {
    const yaml = `
name: Address
description: A mailing address
fields:
  street:
    type: utf8
    label: Street
    description: Street address
`;
    const { name, edge } = parseEdgeFile(yaml, () => {
      throw new Error("resolver should not be called — no references in this file");
    });
    expect(name).toBe("Address");
    expect(edge.name).toBe("Address");
    expect(edge.fields.street).toEqual({
      type: "utf8",
      label: "Street",
      description: "Street address",
    });
  });

  it("resolves a bare-name field reference via the resolver", () => {
    const yaml = `
name: Person
description: A person
fields:
  age:
    type: uint8
    label: Age
    description: The person's age
  email: email
`;
    const emailField = {
      type: "utf8" as const,
      label: "Email",
      description: "An email address",
    };
    const { edge } = parseEdgeFile(yaml, (referencedName) => {
      expect(referencedName).toBe("email");
      return emailField;
    });
    expect(edge.fields.email).toBe(emailField);
  });

  it("resolves a bare-name compound (nested-edge) reference via the resolver", () => {
    const yaml = `
name: PersonWithAddress
description: A person with a nested address edge
fields:
  name:
    type: utf8
    label: Name
    description: The person's name
  address: Address
`;
    const addressEdge = {
      name: "Address",
      description: "A mailing address",
      fields: {
        street: { type: "utf8" as const, label: "Street", description: "Street address" },
      },
    };
    const { edge } = parseEdgeFile(yaml, (referencedName) => {
      expect(referencedName).toBe("Address");
      return addressEdge;
    });
    expect(edge.fields.address).toBe(addressEdge);
  });

  it("rejects an .edge file missing a name", () => {
    const yaml = `
description: no name here
fields: {}
`;
    expect(() => parseEdgeFile(yaml, () => {
      throw new Error("unreachable");
    })).toThrow(/name/i);
  });
});

describe("elaborate", () => {
  it("loads a directory of .field/.edge files, resolving references across both", async () => {
    const root = await writeFixture({
      "fields/email.field": `
name: email
type: utf8
label: Email
description: An email address
validations:
  pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
`,
      "edges/Address.edge": `
name: Address
description: A mailing address
fields:
  street:
    type: utf8
    label: Street
    description: Street address
`,
      "edges/PersonWithAddress.edge": `
name: PersonWithAddress
description: A person with a nested address edge and a reused email field
fields:
  name:
    type: utf8
    label: Name
    description: The person's name
  email: email
  address: Address
`,
    });

    const result = await elaborate(root);

    expect(Object.keys(result.fields)).toEqual(["email"]);
    expect(Object.keys(result.edges).sort()).toEqual(["Address", "PersonWithAddress"]);
    expect(result.edges.PersonWithAddress!.fields.email).toBe(result.fields.email);
    expect(result.edges.PersonWithAddress!.fields.address).toBe(result.edges.Address);
  });

  it("rejects a .field file whose declared name doesn't match its filename", async () => {
    const root = await writeFixture({
      "fields/email.field": `
name: not-email
type: utf8
label: Email
description: An email address
`,
    });

    await expect(elaborate(root)).rejects.toThrow(/email/);
  });

  it("rejects a reference to a name no .field or .edge file declares", async () => {
    const root = await writeFixture({
      "edges/Person.edge": `
name: Person
description: A person
fields:
  ghost: nonexistent
`,
    });

    await expect(elaborate(root)).rejects.toThrow(/nonexistent/);
  });

  it("rejects a circular compound-edge reference", async () => {
    const root = await writeFixture({
      "edges/A.edge": `
name: A
description: A
fields:
  b: B
`,
      "edges/B.edge": `
name: B
description: B
fields:
  a: A
`,
    });

    await expect(elaborate(root)).rejects.toThrow(/circular/i);
  });

  it("loads the real person-birthday example — proving the hand-authored files stay valid", async () => {
    const result = await elaborate(PERSON_BIRTHDAY_SRC);

    expect(Object.keys(result.fields)).toEqual(["email"]);
    expect(Object.keys(result.edges).sort()).toEqual(["Address", "Person", "PersonWithAddress"]);

    expect(result.edges.Person!.fields.age).toMatchObject({ type: "uint8" });
    expect(result.edges.Address!.fields.street).toMatchObject({ type: "utf8" });
    expect(result.edges.PersonWithAddress!.fields.email).toBe(result.fields.email);
    expect(result.edges.PersonWithAddress!.fields.address).toBe(result.edges.Address);
  });
});
