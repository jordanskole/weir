import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { elaborate, parseEdgeFile, parseFieldFile, parseNodeFile, parseTopologyFile } from "./elaborate.js";
import type { AnyEdgeDef } from "./types.js";

const PERSON_BIRTHDAY_SRC = fileURLToPath(
  new URL("../../../examples/person-birthday/src", import.meta.url),
);
const TODO_LIST_SRC = fileURLToPath(new URL("../../../examples/todo-list/src", import.meta.url));
const RECIPE_SRC = fileURLToPath(new URL("../../../examples/recipe/src", import.meta.url));

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
      index: "id",
      fields: {
        id: { type: "utf8" as const, label: "ID", description: "d", nullable: false as const },
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

  it("rejects a many: reference to an edge with no declared index", () => {
    const yaml = `
description: A list of tasks
fields:
  tasks:
    many: Task
`;
    const taskEdgeWithNoIndex = {
      name: "Task",
      label: "Task",
      description: "A task",
      fields: {
        title: { type: "utf8" as const, label: "Title", description: "d", nullable: false as const },
      },
    };
    expect(() => parseEdgeFile(yaml, "TaskList", () => taskEdgeWithNoIndex)).toThrow(/index/i);
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

  it("resolves a bare-boolean field value into a LiteralFieldDef", () => {
    const yaml = `
label: CompletedTodo
description: A todo that's been completed
fields:
  is_complete: true
`;
    const edge = parseEdgeFile(yaml, "CompletedTodo", () => {
      throw new Error("resolver should not be called — no references in this file");
    });
    expect(edge.fields.is_complete).toEqual({ literal: true });
  });

  it("resolves an explicit { literal } field value, label and description included", () => {
    const yaml = `
label: CompletedTodo
description: A todo that's been completed
fields:
  is_complete:
    literal: true
    label: Is Complete
    description: Always true on a CompletedTodo
`;
    const edge = parseEdgeFile(yaml, "CompletedTodo", () => {
      throw new Error("resolver should not be called — no references in this file");
    });
    expect(edge.fields.is_complete).toEqual({
      literal: true,
      label: "Is Complete",
      description: "Always true on a CompletedTodo",
    });
  });

  it("spreads a source edge's fields, then applies local overrides", () => {
    const yaml = `
label: Baked Cookies
description: The dough, baked
fields:
  "...Dough":
  done:
    type: bool
    label: Done
    description: Whether the cookies have cooled enough to eat
`;
    const doughEdge: AnyEdgeDef = {
      name: "Dough",
      label: "Dough",
      description: "d",
      fields: {
        title: { type: "utf8", label: "Title", description: "d", nullable: false },
        servings: { type: "uint8", label: "Servings", description: "d", nullable: false },
      },
    };
    const edge = parseEdgeFile(yaml, "BakedCookies", (referencedName) => {
      expect(referencedName).toBe("Dough");
      return doughEdge;
    });
    expect(edge.fields.title).toEqual(doughEdge.fields.title);
    expect(edge.fields.servings).toEqual(doughEdge.fields.servings);
    expect(edge.fields.done).toEqual({
      type: "bool",
      label: "Done",
      description: "Whether the cookies have cooled enough to eat",
    });
  });

  it("lets a local field override a spread-sourced field of the same name, whole-value replacement", () => {
    const yaml = `
label: Cookies
description: The finished, cooled cookies
fields:
  "...BakedCookies":
  done: true
`;
    const bakedCookiesEdge: AnyEdgeDef = {
      name: "BakedCookies",
      label: "Baked Cookies",
      description: "d",
      fields: {
        title: { type: "utf8", label: "Title", description: "d", nullable: false },
        done: { type: "bool", label: "Done", description: "d" },
      },
    };
    const edge = parseEdgeFile(yaml, "Cookies", () => bakedCookiesEdge);
    expect(edge.fields.title).toEqual(bakedCookiesEdge.fields.title);
    expect(edge.fields.done).toEqual({ literal: true });
  });

  it("inherits index from the spread source when not locally declared", () => {
    const yaml = `
label: CompletedTodo
description: A todo that's been completed
fields:
  "...Todo":
  is_complete: true
`;
    const todoEdge: AnyEdgeDef = {
      name: "Todo",
      label: "Todo",
      description: "d",
      index: "id",
      fields: {
        id: { type: "utf8", label: "ID", description: "d", nullable: false },
      },
    };
    const edge = parseEdgeFile(yaml, "CompletedTodo", () => todoEdge);
    expect(edge.index).toBe("id");
  });

  it("rejects more than one spread key in the same fields map", () => {
    const yaml = `
label: X
description: d
fields:
  "...A":
  "...B":
`;
    expect(() =>
      parseEdgeFile(yaml, "X", () => {
        throw new Error("unreachable");
      }),
    ).toThrow(/at most one/i);
  });

  it("rejects a spread key carrying a non-null value", () => {
    const yaml = `
label: Baked Cookies
description: The dough, baked
fields:
  "...Dough": garbage
  done: true
`;
    expect(() =>
      parseEdgeFile(yaml, "BakedCookies", () => {
        throw new Error("unreachable");
      }),
    ).toThrow(/must have no value \(null\)/i);
  });

  it("rejects a spread source that resolves to a field, not an edge", () => {
    const yaml = `
label: X
description: d
fields:
  "...title":
`;
    const titleField = { type: "utf8" as const, label: "Title", description: "d", nullable: false as const };
    expect(() => parseEdgeFile(yaml, "X", () => titleField)).toThrow(/spread is for edges only/i);
  });
});

describe("parseNodeFile", () => {
  const Person: AnyEdgeDef = {
    name: "Person",
    description: "A person",
    fields: { age: { type: "uint8", label: "Age", description: "d", nullable: false } },
  };
  const Todo: AnyEdgeDef = {
    name: "Todo",
    description: "A task",
    index: "id",
    fields: {
      id: { type: "utf8", label: "ID", description: "d", nullable: false },
      title: { type: "utf8", label: "Title", description: "d", nullable: false },
    },
  };
  const TodoList: AnyEdgeDef = {
    name: "TodoList",
    description: "A list of tasks",
    fields: { title: { type: "utf8", label: "Title", description: "d", nullable: false } },
  };
  const Pass: AnyEdgeDef = { name: "Pass", description: "d", fields: {} };
  const Fail: AnyEdgeDef = { name: "Fail", description: "d", fields: {} };
  const edgesByName: Record<string, AnyEdgeDef> = { Person, Todo, TodoList, Pass, Fail };
  const resolveEdge = (name: string): AnyEdgeDef => {
    const edge = edgesByName[name];
    if (!edge) throw new Error(`Cannot resolve "${name}" — no .edge file declares it.`);
    return edge;
  };

  it("parses a single-edge input/output node, resolving both by name", () => {
    const yaml = `
description: Increments a person's age by one year
input: Person
output: Person
examples:
  - given:
      Person:
        age: 41
    expect:
      Person:
        age: 42
`;
    const node = parseNodeFile(yaml, "birthday", resolveEdge);
    expect(node.name).toBe("birthday");
    expect(node.input).toEqual({ kind: "single", edge: Person });
    expect(node.output).toEqual({ kind: "single", edge: Person });
    expect(node.examples).toEqual([{ given: { Person: { age: 41 } }, expect: { Person: { age: 42 } } }]);
  });

  it("resolves an allOf: input into multiple edges, in declared order", () => {
    const yaml = `
description: Adds a task to a todo list
input:
  allOf:
    - TodoList
    - Todo
output: TodoList
examples:
  - given:
      TodoList: {}
      Todo: {}
    expect:
      TodoList: {}
`;
    const node = parseNodeFile(yaml, "AddTodoToList", resolveEdge);
    expect(node.input).toEqual({ kind: "allOf", edges: [TodoList, Todo] });
  });

  it("resolves a oneOf output into its listed edges, in declared order", () => {
    const yaml = `
description: Checks whether a person just turned 42
input: Person
output:
  oneOf:
    - Pass
    - Fail
examples:
  - given:
      Person:
        age: 42
    expect:
      Pass: {}
`;
    const node = parseNodeFile(yaml, "expect_Person_age_42", resolveEdge);
    expect(node.output).toEqual({ kind: "oneOf", edges: [Pass, Fail] });
  });

  it("resolves an allOf output into its listed edges, in declared order", () => {
    const yaml = `
description: d
input: Person
output:
  allOf:
    - Pass
    - Fail
`;
    const node = parseNodeFile(yaml, "weird", resolveEdge);
    expect(node.output).toEqual({ kind: "allOf", edges: [Pass, Fail] });
  });

  it("resolves a many output into its single edge", () => {
    const yaml = `
description: d
input: Person
output:
  many: Todo
`;
    const node = parseNodeFile(yaml, "duplicate", resolveEdge);
    expect(node.output).toEqual({ kind: "many", edge: Todo });
  });

  it("rejects a many output referencing an edge with no declared index", () => {
    const yaml = `
description: d
input: Person
output:
  many: Person
`;
    expect(() => parseNodeFile(yaml, "duplicate", resolveEdge)).toThrow(/index/i);
  });

  it("rejects a .node file that declares a name — the filename is the name", () => {
    const yaml = `
name: birthday
description: d
input: Person
output: Person
`;
    expect(() => parseNodeFile(yaml, "birthday", resolveEdge)).toThrow(/name/i);
  });

  it("rejects a .node file that declares fn — contract only, no implementation", () => {
    const yaml = `
description: d
input: Person
output: Person
fn: "() => {}"
`;
    expect(() => parseNodeFile(yaml, "birthday", resolveEdge)).toThrow(/fn/i);
  });

  it("parses properties, per the spec's §10 worked example", () => {
    const yaml = `
input: Person
output: Person
examples:
  - given: { age: 41 }
    expect: { age: 42 }
properties:
  - name: increments age by one
    description: A birthday advances the person's age by exactly one year.
    expr:
      eq:
        - get: output.age
        - add:
            - get: input.age
            - lit: 1
`;
    const node = parseNodeFile(yaml, "birthday", resolveEdge);
    expect(node.properties).toEqual([
      {
        name: "increments age by one",
        description: "A birthday advances the person's age by exactly one year.",
        expr: { eq: [{ get: "output.age" }, { add: [{ get: "input.age" }, { lit: 1 }] }] },
      },
    ]);
  });

  it("gives a .node file with no properties key a NodeDecl with no properties key at all", () => {
    const yaml = `
description: d
input: Person
output: Person
`;
    const node = parseNodeFile(yaml, "birthday", resolveEdge);
    expect(node).not.toHaveProperty("properties");
  });
});

describe("parseTopologyFile", () => {
  const knownNames = new Set(["A", "B", "C", "birthday"]);
  const resolveNodeName = (name: string): string[] => {
    if (!knownNames.has(name)) throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
    return [name];
  };

  it("parses a single sequential chain", () => {
    const wiring = parseTopologyFile(`A:\n  then:\n    B: {}\n`, resolveNodeName);
    expect(wiring.origins).toEqual(["A"]);
    expect(wiring.feeds).toEqual({ A: ["B"] });
  });

  it("parses fan-out — one node feeding several next nodes", () => {
    const wiring = parseTopologyFile(`A:\n  then:\n    B: {}\n    C: {}\n`, resolveNodeName);
    expect(wiring.origins).toEqual(["A"]);
    expect(wiring.feeds.A?.sort()).toEqual(["B", "C"]);
  });

  it("parses convergence — a node fed by two parents, no special join syntax", () => {
    const yaml = `
A:
  then:
    B:
      then:
        C: {}
    C: {}
`;
    const wiring = parseTopologyFile(yaml, resolveNodeName);
    expect(wiring.feeds.A?.sort()).toEqual(["B", "C"]);
    expect(wiring.feeds.B).toEqual(["C"]);
  });

  it("parses a repeated node application as distinct, not a cycle", () => {
    const yaml = `
birthday:
  then:
    birthday:
      then:
        birthday: {}
`;
    expect(() => parseTopologyFile(yaml, resolveNodeName)).not.toThrow();
    const wiring = parseTopologyFile(yaml, resolveNodeName);
    expect(wiring.feeds.birthday).toEqual(["birthday"]);
  });

  it("treats several top-level keys as independent origins", () => {
    const wiring = parseTopologyFile(`A: {}\nB: {}\n`, resolveNodeName);
    expect(wiring.origins.sort()).toEqual(["A", "B"]);
    expect(wiring.feeds).toEqual({});
  });

  it("rejects a then value that isn't a map", () => {
    expect(() => parseTopologyFile(`A:\n  then: "oops"\n`, resolveNodeName)).toThrow(/then/i);
  });

  it("rejects a key other than then", () => {
    expect(() => parseTopologyFile(`A:\n  bogus: {}\n`, resolveNodeName)).toThrow(/bogus/);
  });

  it("resolves every node name mentioned, including nested ones", () => {
    expect(() => parseTopologyFile(`A:\n  then:\n    Ghost: {}\n`, resolveNodeName)).toThrow(/Ghost/);
  });

  it("expands an aliased name (an anyOf-desugared original) into all its shadows, as a parent", () => {
    const aliasing = (name: string): string[] => {
      if (name === "HandleFailed") return ["HandleFailed__Failed_Todo", "HandleFailed__Failed_Person"];
      return knownNames.has(name) ? [name] : (() => {
        throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
      })();
    };
    const wiring = parseTopologyFile(`HandleFailed:\n  then:\n    A: {}\n`, aliasing);
    expect(wiring.origins.sort()).toEqual(["HandleFailed__Failed_Person", "HandleFailed__Failed_Todo"]);
    expect(wiring.feeds["HandleFailed__Failed_Todo"]).toEqual(["A"]);
    expect(wiring.feeds["HandleFailed__Failed_Person"]).toEqual(["A"]);
  });

  it("expands an aliased name into all its shadows, as a child", () => {
    const aliasing = (name: string): string[] => {
      if (name === "HandleFailed") return ["HandleFailed__Failed_Todo", "HandleFailed__Failed_Person"];
      return knownNames.has(name) ? [name] : (() => {
        throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
      })();
    };
    const wiring = parseTopologyFile(`A:\n  then:\n    HandleFailed: {}\n`, aliasing);
    expect(wiring.feeds.A?.sort()).toEqual(["HandleFailed__Failed_Person", "HandleFailed__Failed_Todo"]);
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
    expect(Object.keys(result.edges).sort()).toEqual([
      "Address",
      "Failed_Address",
      "Failed_PersonWithAddress",
      "PersonWithAddress",
    ]);
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

  it("synthesizes a Failed_<EdgeName> edge for every declared edge", async () => {
    const root = await writeFixture({
      "edges/Person.edge": `
description: A person
fields:
  age:
    type: uint8
    label: Age
    description: d
    nullable: false
`,
    });

    const result = await elaborate(root);

    expect(result.edges.Failed_Person).toBeDefined();
    expect(result.edges.Failed_Person!.fields.input).toBe(result.edges.Person);
    expect(result.edges.Failed_Person!.fields.reason).toMatchObject({ type: "utf8", nullable: true });
  });

  it("desugars an anyOf: input into N single-input NodeDecls, named <Node>__<Edge>", async () => {
    const root = await writeFixture({
      "edges/Failed_Todo.edge": `
description: A failed Todo
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Failed_Person.edge": `
description: A failed Person
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Recovered.edge": `
description: A recovered value
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "nodes/HandleFailed.node": `
description: Handles whichever failure shows up first
input:
  anyOf:
    - Failed_Todo
    - Failed_Person
output: Recovered
examples:
  - given:
      Failed_Todo:
        input: "bad todo"
    expect:
      Recovered:
        value: "recovered todo"
  - given:
      Failed_Person:
        input: "bad person"
    expect:
      Recovered:
        value: "recovered person"
`,
    });

    const result = await elaborate(root);

    expect(Object.keys(result.nodes).sort()).toEqual(["HandleFailed__Failed_Person", "HandleFailed__Failed_Todo"]);
    expect(result.nodes.HandleFailed__Failed_Todo!.input).toEqual({ kind: "single", edge: result.edges.Failed_Todo });
    expect(result.nodes.HandleFailed__Failed_Todo!.output).toEqual({ kind: "single", edge: result.edges.Recovered });
    expect(result.nodes.HandleFailed__Failed_Todo!.examples).toEqual([
      { given: { Failed_Todo: { input: "bad todo" } }, expect: { Recovered: { value: "recovered todo" } } },
    ]);
    expect(result.nodes.HandleFailed__Failed_Person!.input).toEqual({
      kind: "single",
      edge: result.edges.Failed_Person,
    });
    expect(result.nodes.HandleFailed__Failed_Person!.examples).toEqual([
      { given: { Failed_Person: { input: "bad person" } }, expect: { Recovered: { value: "recovered person" } } },
    ]);
    expect(result.nodes.HandleFailed).toBeUndefined();
  });

  it("gives an anyOf-desugared shadow no examples key when none of the file's examples tag its edge", async () => {
    const root = await writeFixture({
      "edges/Failed_Todo.edge": `
description: A failed Todo
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Failed_Person.edge": `
description: A failed Person
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Recovered.edge": `
description: A recovered value
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "nodes/HandleFailed.node": `
description: Handles whichever failure shows up first
input:
  anyOf:
    - Failed_Todo
    - Failed_Person
output: Recovered
examples:
  - given:
      Failed_Todo:
        input: "bad todo"
    expect:
      Recovered:
        value: "recovered todo"
`,
    });

    const result = await elaborate(root);

    expect(result.nodes.HandleFailed__Failed_Todo!.examples).toHaveLength(1);
    expect(result.nodes.HandleFailed__Failed_Person!.examples).toBeUndefined();
  });

  it("passes properties through to every anyOf-desugared shadow, same as closure", async () => {
    const root = await writeFixture({
      "edges/Failed_Todo.edge": `
description: A failed Todo
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Failed_Person.edge": `
description: A failed Person
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Recovered.edge": `
description: A recovered value
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "nodes/HandleFailed.node": `
description: Handles whichever failure shows up first
input:
  anyOf:
    - Failed_Todo
    - Failed_Person
output: Recovered
examples:
  - given:
      Failed_Todo:
        input: "bad todo"
    expect:
      Recovered:
        value: "recovered todo"
properties:
  - name: always recovers
    description: The output value is never empty.
    expr: { ne: [{ get: "output.value" }, { lit: "" }] }
`,
    });

    const result = await elaborate(root);

    expect(result.nodes.HandleFailed__Failed_Todo!.properties).toEqual([
      {
        name: "always recovers",
        description: "The output value is never empty.",
        expr: { ne: [{ get: "output.value" }, { lit: "" }] },
      },
    ]);
    expect(result.nodes.HandleFailed__Failed_Person!.properties).toEqual([
      {
        name: "always recovers",
        description: "The output value is never empty.",
        expr: { ne: [{ get: "output.value" }, { lit: "" }] },
      },
    ]);
  });

  it("synthesizes a Failed_<A>_<B> edge for a declared allOf: combo, sorted and order-independent", async () => {
    const root = await writeFixture({
      "edges/A.edge": `
description: Edge A
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "edges/B.edge": `
description: Edge B
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "nodes/Combine.node": `
description: Combines A and B
input:
  allOf:
    - B
    - A
output: A
examples:
  - given:
      A: { value: "a" }
      B: { value: "b" }
    expect:
      A: { value: "a" }
`,
    });

    const result = await elaborate(root);

    expect(result.edges.Failed_A_B).toBeDefined();
    expect(result.edges.Failed_A_B!.fields.A).toBe(result.edges.A);
    expect(result.edges.Failed_A_B!.fields.B).toBe(result.edges.B);
    expect(result.edges.Failed_A_B!.fields.reason).toMatchObject({ type: "utf8", nullable: true });
  });

  it("lets a .node file declare input: Failed_<A>_<B>, resolving against the synthesized combo edge", async () => {
    const root = await writeFixture({
      "edges/A.edge": `
description: Edge A
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "edges/B.edge": `
description: Edge B
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "nodes/Combine.node": `
description: Combines A and B
input:
  allOf:
    - A
    - B
output: A
examples:
  - given:
      A: { value: "a" }
      B: { value: "b" }
    expect:
      A: { value: "a" }
`,
      "nodes/HandleFailed.node": `
description: Recovers a failed A+B combo
input: Failed_A_B
output: A
examples:
  - given:
      Failed_A_B:
        A: { value: "a" }
        B: { value: "b" }
        reason: "kaboom"
    expect:
      A: { value: "a" }
`,
    });

    const result = await elaborate(root);

    expect(result.nodes.HandleFailed!.input).toEqual({ kind: "single", edge: result.edges.Failed_A_B });
  });

  it("lets a .node file declare input: Failed_<EdgeName>, resolving against the synthesized edge", async () => {
    const root = await writeFixture({
      "edges/Todo.edge": `
description: A task
fields:
  title:
    type: utf8
    label: Title
    description: d
    nullable: false
`,
      "nodes/HandleFailed.node": `
description: Recovers a failed Todo
input: Failed_Todo
output: Todo
examples:
  - given:
      Failed_Todo:
        input:
          title: "Buy milk"
        reason: "kaboom"
    expect:
      Todo:
        title: "Buy milk"
`,
    });

    const result = await elaborate(root);

    expect(result.nodes.HandleFailed!.input).toEqual({ kind: "single", edge: result.edges.Failed_Todo });
  });

  it("loads the real person-birthday example — proving the hand-authored files stay valid", async () => {
    const result = await elaborate(PERSON_BIRTHDAY_SRC);

    expect(Object.keys(result.fields)).toEqual(["email"]);
    expect(Object.keys(result.edges).sort()).toEqual([
      "Address",
      "Fail",
      "Failed_Address",
      "Failed_Fail",
      "Failed_Pass",
      "Failed_Person",
      "Failed_PersonWithAddress",
      "Pass",
      "Person",
      "PersonWithAddress",
    ]);

    expect(result.edges.Person!.fields.age).toMatchObject({ type: "uint8" });
    expect(result.edges.Address!.fields.street).toMatchObject({ type: "utf8" });
    expect(result.edges.PersonWithAddress!.fields.email).toBe(result.fields.email);
    expect(result.edges.PersonWithAddress!.fields.address).toBe(result.edges.Address);

    expect(Object.keys(result.nodes).sort()).toEqual(["birthday", "expect_Person_age_42"]);
    expect(result.nodes.birthday!.input).toEqual({ kind: "single", edge: result.edges.Person });
    expect(result.nodes.birthday!.output).toEqual({ kind: "single", edge: result.edges.Person });
    expect(result.nodes.expect_Person_age_42!.output).toEqual({
      kind: "oneOf",
      edges: [result.edges.Pass, result.edges.Fail],
    });
  });

  it("loads .node files, resolving a single-edge input against a declared edge", async () => {
    const root = await writeFixture({
      "edges/Person.edge": `
description: A person
fields:
  age:
    type: uint8
    label: Age
    description: d
    nullable: false
`,
      "nodes/birthday.node": `
description: Increments a person's age by one year
input: Person
output: Person
examples:
  - given:
      Person:
        age: 41
    expect:
      Person:
        age: 42
`,
    });

    const result = await elaborate(root);

    expect(Object.keys(result.nodes)).toEqual(["birthday"]);
    expect(result.nodes.birthday!.name).toBe("birthday");
    expect(result.nodes.birthday!.input).toEqual({ kind: "single", edge: result.edges.Person });
  });

  it("rejects a .node file referencing an edge no .edge file declares", async () => {
    const root = await writeFixture({
      "nodes/birthday.node": `
description: d
input: Ghost
output: Ghost
`,
    });

    await expect(elaborate(root)).rejects.toThrow(/ghost/i);
  });

  it("loads the real todo-list example — proving allOf: input resolves against real hand-authored files", async () => {
    const result = await elaborate(TODO_LIST_SRC);

    expect(Object.keys(result.nodes).sort()).toEqual(["AddTodoToList", "CompleteTodo", "CreateTodo", "startList"]);
    expect(result.nodes.AddTodoToList!.input).toEqual({
      kind: "allOf",
      edges: [result.edges.TodoList, result.edges.Todo],
    });
    expect(result.nodes.AddTodoToList!.output).toEqual({ kind: "single", edge: result.edges.TodoList });
    expect(result.edges.Failed_Todo_TodoList).toBeDefined();

    expect(result.nodes.CreateTodo!.input).toEqual({ kind: "single", edge: result.edges.NewTodo });
    expect(result.edges.NewTodo!.fields.id).toEqual(result.edges.Todo!.fields.id);
    expect(result.edges.NewTodo!.fields.title).toEqual(result.edges.Todo!.fields.title);
    expect(result.edges.NewTodo!.fields.description).toEqual(result.edges.Todo!.fields.description);
    expect(result.edges.NewTodo!.fields.is_complete).toEqual({ literal: false });
  });

  it("loads a .topology file, validating references against declared .node files", async () => {
    const root = await writeFixture({
      "edges/Person.edge": `
description: A person
fields:
  age:
    type: uint8
    label: Age
    description: d
    nullable: false
`,
      "nodes/birthday.node": `
description: d
input: Person
output: Person
examples:
  - given:
      Person:
        age: 41
    expect:
      Person:
        age: 42
`,
      "topology/main.topology": `
birthday:
  then:
    birthday: {}
`,
    });

    const result = await elaborate(root);

    expect(result.wiring.origins).toEqual(["birthday"]);
    expect(result.wiring.feeds).toEqual({ birthday: ["birthday"] });
  });

  it("rejects a .topology file referencing a node no .node file declares", async () => {
    const root = await writeFixture({
      "topology/main.topology": `
Ghost:
  then:
    AlsoGhost: {}
`,
    });

    await expect(elaborate(root)).rejects.toThrow(/Ghost/);
  });

  it("loads the real person-birthday example's topology", async () => {
    const result = await elaborate(PERSON_BIRTHDAY_SRC);

    expect(result.wiring.origins).toEqual(["birthday"]);
    expect(result.wiring.feeds).toEqual({ birthday: ["expect_Person_age_42"] });
  });

  it("loads the real todo-list example's topology — an asymmetric diamond converging on AddTodoToList", async () => {
    const result = await elaborate(TODO_LIST_SRC);

    expect(result.wiring.origins).toEqual(["CreateTodo"]);
    expect(result.wiring.feeds.CreateTodo?.sort()).toEqual(["AddTodoToList", "CompleteTodo", "startList"]);
    // Both arms of the join descend from CreateTodo's one Todo instance:
    // Todo reaches AddTodoToList in one hop, TodoList in two via startList.
    // That shared ancestor is what gives the allOf a lineage group to form
    // on — see docs/design-history.md, "A join is a topology boundary".
    expect(result.wiring.feeds.startList).toEqual(["AddTodoToList"]);
  });

  it("lets a .topology file reference an anyOf-desugared node's original name, expanding to all shadows", async () => {
    const root = await writeFixture({
      "edges/Start.edge": `
description: A starting value
fields:
  value:
    type: utf8
    label: Value
    description: d
    nullable: false
`,
      "edges/Failed_Todo.edge": `
description: A failed Todo
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      "edges/Failed_Person.edge": `
description: A failed Person
fields:
  input:
    type: utf8
    label: Input
    description: d
    nullable: false
`,
      // Emits Failed_Todo so one of HandleFailed's two shadows can actually
      // consume what this produces. Before assertWiringTypes existed this
      // fixture emitted Start, which neither shadow takes — the test only
      // ever asserted name expansion, so an unwireable topology went unnoticed.
      "nodes/failing.node": `
description: d
input: Start
output: Failed_Todo
examples:
  - given:
      Start:
        value: "a"
    expect:
      Failed_Todo:
        input: "bad todo"
`,
      "nodes/HandleFailed.node": `
description: Handles whichever failure shows up first
input:
  anyOf:
    - Failed_Todo
    - Failed_Person
output: Start
examples:
  - given:
      Failed_Todo:
        input: "bad todo"
    expect:
      Start:
        value: "a"
  - given:
      Failed_Person:
        input: "bad person"
    expect:
      Start:
        value: "a"
`,
      "topology/main.topology": `
failing:
  then:
    HandleFailed: {}
`,
    });

    const result = await elaborate(root);

    expect(result.wiring.feeds.failing?.sort()).toEqual(["HandleFailed__Failed_Person", "HandleFailed__Failed_Todo"]);
  });

  it("loads the real recipe example — a many(Ingredient) origin fanning out into a mix/preheat allOf join at bake", async () => {
    const result = await elaborate(RECIPE_SRC);

    expect(Object.keys(result.nodes).sort()).toEqual([
      "bake",
      "cool",
      "gatherIngredients",
      "mix",
      "preheatOven",
    ]);
    expect(result.nodes.gatherIngredients!.input).toEqual({ kind: "single", edge: result.edges.Recipe });
    expect(result.nodes.mix!.output).toEqual({ kind: "single", edge: result.edges.Dough });
    expect(result.nodes.preheatOven!.output).toEqual({ kind: "single", edge: result.edges.Oven });
    expect(result.nodes.bake!.input).toEqual({
      kind: "allOf",
      edges: [result.edges.Dough, result.edges.Oven],
    });
    expect(result.nodes.bake!.output).toEqual({ kind: "single", edge: result.edges.BakedCookies });
    expect(result.nodes.cool!.output).toEqual({ kind: "single", edge: result.edges.Cookies });

    expect(result.edges.Recipe!.fields.ingredients).toEqual({ many: result.edges.Ingredient });
    expect(result.edges.Failed_Dough_Oven).toBeDefined();

    expect(result.edges.BakedCookies!.fields.title).toEqual(result.edges.Dough!.fields.title);
    expect(result.edges.BakedCookies!.fields.servings).toEqual(result.edges.Dough!.fields.servings);
    expect(result.edges.BakedCookies!.fields.done).toEqual({
      type: "bool",
      label: "Done",
      description: "Whether the cookies have cooled enough to eat",
    });
    expect(result.edges.Cookies!.fields.title).toEqual(result.edges.Dough!.fields.title);
    expect(result.edges.Cookies!.fields.done).toEqual({ literal: true });

    expect(result.wiring.origins).toEqual(["gatherIngredients"]);
    expect(result.wiring.feeds.gatherIngredients?.sort()).toEqual(["mix", "preheatOven"]);
    expect(result.wiring.feeds.mix).toEqual(["bake"]);
    expect(result.wiring.feeds.preheatOven).toEqual(["bake"]);
    expect(result.wiring.feeds.bake).toEqual(["cool"]);
  });
});

/**
 * Elaboration-time wiring checks (assertWiringTypes). Two rules, both
 * running against the assembled Wiring before elaborate() returns:
 *
 *   A (arc soundness)      every arc must carry at least one edge the
 *                          consumer declares, at single multiplicity.
 *   B (node reachability)  the union of a node's parents must cover every
 *                          edge it declares needing. Origins are exempt —
 *                          their input arrives as an originPayload, not
 *                          along an arc.
 *
 * The motivating case is A's `many` branch: no InputSpec is ever `many`
 * (resolveInputSpec builds only `single`/`allOf`), so a `many X` output
 * can never satisfy any input. Before this check, wiring one into a
 * `single X` input elaborated clean, ran to quiescence, and failed as a
 * schema error two nodes downstream — see examples/soc-triage's history
 * in docs/open-questions.md ("There is no fan-out primitive").
 */
const ITEM_EDGE = `
description: One item
index: id
fields:
  id:
    type: utf8
    label: Id
    description: d
    nullable: false
`;

const PLAIN_EDGE = (name: string) => `
description: ${name}
fields:
  ${name.toLowerCase()}Value:
    type: utf8
    label: V
    description: d
    nullable: false
`;

describe("elaborate — wiring type checks", () => {
  it("rejects a many output wired into a single input, naming both nodes and the edge", async () => {
    const root = await writeFixture({
      "edges/Seed.edge": PLAIN_EDGE("Seed"),
      "edges/Item.edge": ITEM_EDGE,
      "edges/Report.edge": PLAIN_EDGE("Report"),
      "nodes/extract.node": `label: E\ndescription: d\ninput: Seed\noutput:\n  many: Item\n`,
      "nodes/use.node": `label: U\ndescription: d\ninput: Item\noutput: Report\n`,
      "topology/main.topology": `extract:\n  then:\n    use: {}\n`,
    });

    await expect(elaborate(root)).rejects.toThrow(/use.*extract.*many Item/s);
  });

  it("rejects an arc whose parent produces nothing the child consumes", async () => {
    const root = await writeFixture({
      "edges/Seed.edge": PLAIN_EDGE("Seed"),
      "edges/Other.edge": PLAIN_EDGE("Other"),
      "edges/Report.edge": PLAIN_EDGE("Report"),
      "nodes/a.node": `label: A\ndescription: d\ninput: Seed\noutput: Seed\n`,
      "nodes/b.node": `label: B\ndescription: d\ninput: Other\noutput: Report\n`,
      "topology/main.topology": `a:\n  then:\n    b: {}\n`,
    });

    await expect(elaborate(root)).rejects.toThrow(/carries nothing/i);
  });

  it("rejects a node whose parents cover only part of its allOf input", async () => {
    const root = await writeFixture({
      "edges/Seed.edge": PLAIN_EDGE("Seed"),
      "edges/Left.edge": PLAIN_EDGE("Left"),
      "edges/Right.edge": PLAIN_EDGE("Right"),
      "edges/Report.edge": PLAIN_EDGE("Report"),
      "nodes/split.node": `label: S\ndescription: d\ninput: Seed\noutput: Left\n`,
      "nodes/join.node": `label: J\ndescription: d\ninput:\n  allOf:\n    - Left\n    - Right\noutput: Report\n`,
      "topology/main.topology": `split:\n  then:\n    join: {}\n`,
    });

    await expect(elaborate(root)).rejects.toThrow(/join.*Right/s);
  });

  it("accepts a diamond where each arm supplies only half of the fan-in's allOf", async () => {
    const root = await writeFixture({
      "edges/Seed.edge": PLAIN_EDGE("Seed"),
      "edges/Left.edge": PLAIN_EDGE("Left"),
      "edges/Right.edge": PLAIN_EDGE("Right"),
      "edges/Report.edge": PLAIN_EDGE("Report"),
      "nodes/origin.node": `label: O\ndescription: d\ninput: Seed\noutput: Seed\n`,
      "nodes/left.node": `label: L\ndescription: d\ninput: Seed\noutput: Left\n`,
      "nodes/right.node": `label: R\ndescription: d\ninput: Seed\noutput: Right\n`,
      "nodes/join.node": `label: J\ndescription: d\ninput:\n  allOf:\n    - Left\n    - Right\noutput: Report\n`,
      "topology/main.topology": `origin:\n  then:\n    left:\n      then:\n        join: {}\n    right:\n      then:\n        join: {}\n`,
    });

    const result = await elaborate(root);
    expect(result.wiring.feeds.left).toEqual(["join"]);
    expect(result.wiring.feeds.right).toEqual(["join"]);
  });

  it("accepts a oneOf output feeding a child that consumes one of its branches", async () => {
    const root = await writeFixture({
      "edges/Seed.edge": PLAIN_EDGE("Seed"),
      "edges/Pass.edge": PLAIN_EDGE("Pass"),
      "edges/Fail.edge": PLAIN_EDGE("Fail"),
      "edges/Report.edge": PLAIN_EDGE("Report"),
      "nodes/check.node": `label: C\ndescription: d\ninput: Seed\noutput:\n  oneOf:\n    - Pass\n    - Fail\n`,
      "nodes/onPass.node": `label: P\ndescription: d\ninput: Pass\noutput: Report\n`,
      "topology/main.topology": `check:\n  then:\n    onPass: {}\n`,
    });

    const result = await elaborate(root);
    expect(result.wiring.feeds.check).toEqual(["onPass"]);
  });

  it("exempts an origin node from the coverage rule — its input is an originPayload, not an arc", async () => {
    const root = await writeFixture({
      "edges/Seed.edge": PLAIN_EDGE("Seed"),
      "edges/Report.edge": PLAIN_EDGE("Report"),
      "nodes/start.node": `label: S\ndescription: d\ninput: Seed\noutput: Report\n`,
      "topology/main.topology": `start: {}\n`,
    });

    const result = await elaborate(root);
    expect(result.wiring.origins).toEqual(["start"]);
  });

  it("accepts a self-loop, where a node's own output covers its own input", async () => {
    const root = await writeFixture({
      "edges/Tick.edge": PLAIN_EDGE("Tick"),
      "nodes/count.node": `label: C\ndescription: d\ninput: Tick\noutput: Tick\n`,
      "topology/main.topology": `count:\n  then:\n    count: {}\n`,
    });

    const result = await elaborate(root);
    expect(result.wiring.feeds.count).toEqual(["count"]);
  });
});
