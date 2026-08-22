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
  it("parses a valid .field YAML string into a FieldDef", () => {
    const yaml = `
type: utf8
label: Email
description: An email address
nullable: false
validations:
  pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
`;
    const field = parseFieldFile(yaml);
    expect(field).toEqual({
      type: "utf8",
      label: "Email",
      description: "An email address",
      nullable: false,
      validations: { pattern: "^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$" },
    });
  });

  it("rejects a .field file that declares a name — the filename is the name", () => {
    const yaml = `
name: email
type: utf8
label: Email
description: An email address
`;
    expect(() => parseFieldFile(yaml)).toThrow(/name/i);
  });

  it("runs the parsed field through defineField's validation", () => {
    const yaml = `
type: uint8
label: Age
description: A person's age
nullable: false
validations:
  min: -5
`;
    expect(() => parseFieldFile(yaml)).toThrow(/min/i);
  });
});

describe("parseEdgeFile", () => {
  it("parses an .edge file with only inline scalar fields", () => {
    const yaml = `
label: Mailing address
description: A mailing address
fields:
  street:
    type: utf8
    label: Street
    description: Street address
    nullable: false
`;
    const edge = parseEdgeFile(yaml, "Address", () => {
      throw new Error("resolver should not be called — no references in this file");
    });
    expect(edge.name).toBe("Address");
    expect(edge.label).toBe("Mailing address");
    expect(edge.fields.street).toEqual({
      type: "utf8",
      label: "Street",
      description: "Street address",
      nullable: false,
    });
  });

  it("rejects an .edge file that declares a name — the filename is the name", () => {
    const yaml = `
name: Address
description: A mailing address
fields: {}
`;
    expect(() => parseEdgeFile(yaml, "Address", () => {
      throw new Error("unreachable");
    })).toThrow(/name/i);
  });

  it("resolves a bare-name field reference via the resolver", () => {
    const yaml = `
description: A person
fields:
  age:
    type: uint8
    label: Age
    description: The person's age
    nullable: false
  email: email
`;
    const emailField = {
      type: "utf8" as const,
      label: "Email",
      description: "An email address",
      nullable: false as const,
    };
    const edge = parseEdgeFile(yaml, "Person", (referencedName) => {
      expect(referencedName).toBe("email");
      return emailField;
    });
    expect(edge.fields.email).toBe(emailField);
  });

  it("resolves a bare-name compound (nested-edge) reference via the resolver", () => {
    const yaml = `
description: A person with a nested address edge
fields:
  name:
    type: utf8
    label: Name
    description: The person's name
    nullable: false
  address: Address
`;
    const addressEdge = {
      name: "Address",
      label: "Address",
      description: "A mailing address",
      fields: {
        street: {
          type: "utf8" as const,
          label: "Street",
          description: "Street address",
          nullable: false as const,
        },
      },
    };
    const edge = parseEdgeFile(yaml, "PersonWithAddress", (referencedName) => {
      expect(referencedName).toBe("Address");
      return addressEdge;
    });
    expect(edge.fields.address).toBe(addressEdge);
  });

  it("resolves a many-of-compound-edge field via the resolver", () => {
    const yaml = `
description: A list of tasks
fields:
  title:
    type: utf8
    label: Title
    description: The list's title
    nullable: false
  tasks:
    many: Task
`;
    const taskEdge = {
      name: "Task",
      label: "Task",
      description: "A task",
      fields: {
        title: {
          type: "utf8" as const,
          label: "Title",
          description: "The task's title",
          nullable: false as const,
        },
      },
    };
    const edge = parseEdgeFile(yaml, "TaskList", (referencedName) => {
      expect(referencedName).toBe("Task");
      return taskEdge;
    });
    expect(edge.fields.tasks).toEqual({ many: taskEdge });
  });

  it("rejects a many: value that isn't a bare-name reference", () => {
    const yaml = `
description: A list of tasks
fields:
  tasks:
    many:
      type: utf8
      label: bad
      description: bad
`;
    expect(() =>
      parseEdgeFile(yaml, "TaskList", () => {
        throw new Error("unreachable");
      }),
    ).toThrow(/many/i);
  });

  it("rejects a many: reference that resolves to a field, not an edge", () => {
    const yaml = `
description: A list of tasks
fields:
  tasks:
    many: title
`;
    const titleField = { type: "utf8" as const, label: "Title", description: "d", nullable: false as const };
    expect(() => parseEdgeFile(yaml, "TaskList", () => titleField)).toThrow(/many/i);
  });
});

describe("elaborate", () => {
  it("loads a directory of .field/.edge files, resolving references across both", async () => {
    const root = await writeFixture({
      "fields/email.field": `
type: utf8
label: Email
description: An email address
nullable: false
validations:
  pattern: '^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\\.[a-zA-Z]{2,}$'
`,
      "edges/Address.edge": `
description: A mailing address
fields:
  street:
    type: utf8
    label: Street
    description: Street address
    nullable: false
`,
      "edges/PersonWithAddress.edge": `
description: A person with a nested address edge and a reused email field
fields:
  name:
    type: utf8
    label: Name
    description: The person's name
    nullable: false
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

  it("rejects a .field file that declares a name", async () => {
    const root = await writeFixture({
      "fields/email.field": `
name: email
type: utf8
label: Email
description: An email address
`,
    });

    await expect(elaborate(root)).rejects.toThrow(/name/i);
  });

  it("rejects a reference to a name no .field or .edge file declares", async () => {
    const root = await writeFixture({
      "edges/Person.edge": `
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
description: A
fields:
  b: B
`,
      "edges/B.edge": `
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
