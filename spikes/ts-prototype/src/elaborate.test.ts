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

  it("resolves an every: input into multiple edges, in declared order", () => {
    const yaml = `
description: Adds a task to a todo list
input:
  every:
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
    expect(node.input).toEqual({ kind: "every", edges: [TodoList, Todo] });
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
});

describe("parseTopologyFile", () => {
  const knownNames = new Set(["A", "B", "C", "birthday"]);
  const resolveNodeName = (name: string): void => {
    if (!knownNames.has(name)) throw new Error(`Cannot resolve "${name}" — no .node file declares it.`);
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

  it("desugars a oneOf: input into N single-input NodeDecls, named <Node>__<Edge>", async () => {
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
  oneOf:
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

  it("gives a oneOf-desugared shadow no examples key when none of the file's examples tag its edge", async () => {
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
  oneOf:
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

  it("synthesizes a Failed_<A>_<B> edge for a declared every: combo, sorted and order-independent", async () => {
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
  every:
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
  every:
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

  it("loads the real todo-list example — proving every: input resolves against real hand-authored files", async () => {
    const result = await elaborate(TODO_LIST_SRC);

    expect(Object.keys(result.nodes).sort()).toEqual(["AddTodoToList", "CompleteTodo", "CreateTodo"]);
    expect(result.nodes.AddTodoToList!.input).toEqual({
      kind: "every",
      edges: [result.edges.TodoList, result.edges.Todo],
    });
    expect(result.nodes.AddTodoToList!.output).toEqual({ kind: "single", edge: result.edges.TodoList });
    expect(result.edges.Failed_Todo_TodoList).toBeDefined();
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

  it("loads the real todo-list example's topology — a fan-out from CreateTodo", async () => {
    const result = await elaborate(TODO_LIST_SRC);

    expect(result.wiring.origins).toEqual(["CreateTodo"]);
    expect(result.wiring.feeds.CreateTodo?.sort()).toEqual(["AddTodoToList", "CompleteTodo"]);
  });
});
