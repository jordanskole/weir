import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, defineAnyOfNodes, allOf, single } from "./define.js";
import { elaborate } from "./elaborate.js";
import { hashNode } from "./hash.js";
import { elaborateWithImplementations } from "./implementation.js";
import { InMemoryLog } from "./membrane.js";
import { runNetlist } from "./runtime.js";
import type { Program } from "./implementation.js";
import type { NodeDef } from "./types.js";

const PERSON_BIRTHDAY_SRC = fileURLToPath(
  new URL("../../../examples/person-birthday/src", import.meta.url),
);
const TODO_LIST_SRC = fileURLToPath(new URL("../../../examples/todo-list/src", import.meta.url));
const RECIPE_SRC = fileURLToPath(new URL("../../../examples/recipe/src", import.meta.url));

const Start = defineEdge({
  name: "Start",
  label: "Start",
  description: "A starting value",
  fields: { value: defineField({ type: "utf8", label: "Value", description: "d", nullable: false }) },
});

function programWith(nodes: Record<string, NodeDef>, wiring: Program["wiring"]): Program {
  return { fields: {}, edges: { Start }, nodes, wiring };
}

describe("runNetlist", () => {
  it("fires an origin node with the supplied payload, logging its output", async () => {
    const doubled = defineNode({
      name: "doubled",
      input: single(Start),
      output: single(Start),
      fn: (s) => ({ value: s.value + s.value }),
    });
    const program = programWith({ doubled }, { origins: ["doubled"], feeds: {} });
    const log = new InMemoryLog();

    const result = await runNetlist(program, log, "thread-1", { doubled: { value: "a" } });

    expect(result.failures).toEqual([]);
    expect(log.latest("Start", "thread-1")).toEqual({ value: "aa" });
  });

  it("does not fire an origin node whose payload was never supplied", async () => {
    const doubled = defineNode({
      name: "doubled",
      input: single(Start),
      output: single(Start),
      fn: (s) => ({ value: s.value + s.value }),
    });
    const program = programWith({ doubled }, { origins: ["doubled"], feeds: {} });
    const log = new InMemoryLog();

    await runNetlist(program, log, "thread-1", {});

    expect(log.latest("Start", "thread-1")).toBeUndefined();
  });

  it("walks a sequential chain, feeding one node's output to the next", async () => {
    const step1 = defineNode({
      name: "step1",
      input: single(Start),
      output: single(Start),
      fn: (s) => ({ value: `${s.value}-1` }),
    });
    const step2 = defineNode({
      name: "step2",
      input: single(Start),
      output: single(Start),
      fn: (s) => ({ value: `${s.value}-2` }),
    });
    const program = programWith(
      { step1, step2 },
      { origins: ["step1"], feeds: { step1: ["step2"] } },
    );
    const log = new InMemoryLog();

    await runNetlist(program, log, "thread-1", { step1: { value: "a" } });

    expect(log.latest("Start", "thread-1")).toEqual({ value: "a-1-2" });
  });

  it("walks a fan-out — one node feeding two next nodes, both firing off the same output", async () => {
    const Left = defineEdge({
      name: "Left",
      label: "Left",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const Right = defineEdge({
      name: "Right",
      label: "Right",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const origin = defineNode({
      name: "origin",
      input: single(Start),
      output: single(Start),
      fn: (s) => s,
    });
    const toLeft = defineNode({
      name: "toLeft",
      input: single(Start),
      output: single(Left),
      fn: (s) => ({ value: `left-${s.value}` }),
    });
    const toRight = defineNode({
      name: "toRight",
      input: single(Start),
      output: single(Right),
      fn: (s) => ({ value: `right-${s.value}` }),
    });
    const program: Program = {
      fields: {},
      edges: { Start, Left, Right },
      nodes: { origin, toLeft, toRight },
      wiring: { origins: ["origin"], feeds: { origin: ["toLeft", "toRight"] } },
    };
    const log = new InMemoryLog();

    await runNetlist(program, log, "thread-1", { origin: { value: "a" } });

    expect(log.latest("Left", "thread-1")).toEqual({ value: "left-a" });
    expect(log.latest("Right", "thread-1")).toEqual({ value: "right-a" });
  });

  it("walks a diamond convergence — the joining node fires exactly once, after both parents arrive", async () => {
    const A = defineEdge({
      name: "A",
      label: "A",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const B = defineEdge({
      name: "B",
      label: "B",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const C = defineEdge({
      name: "C",
      label: "C",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    let cCalls = 0;
    const nodeA = defineNode({
      name: "nodeA",
      input: single(Start),
      output: single(A),
      fn: (s) => ({ value: s.value }),
    });
    const nodeB = defineNode({
      name: "nodeB",
      input: single(A),
      output: single(B),
      fn: (a) => ({ value: a.value }),
    });
    const nodeC = defineNode({
      name: "nodeC",
      input: allOf(A, B),
      output: single(C),
      fn: ({ A, B }) => {
        cCalls++;
        return { value: `${A.value}+${B.value}` };
      },
    });
    const program: Program = {
      fields: {},
      edges: { Start, A, B, C },
      nodes: { nodeA, nodeB, nodeC },
      wiring: { origins: ["nodeA"], feeds: { nodeA: ["nodeB", "nodeC"], nodeB: ["nodeC"] } },
    };
    const log = new InMemoryLog();

    await runNetlist(program, log, "thread-1", { nodeA: { value: "a" } });

    expect(log.latest("C", "thread-1")).toEqual({ value: "a+a" });
    expect(cCalls).toBe(1);
  });

  it("routes a single-input node's failure to Failed_<InputEdgeName>, not the original edge", async () => {
    const failing = defineNode({
      name: "failing",
      input: single(Start),
      output: single(Start),
      fn: () => {
        throw new Error("kaboom");
      },
    });
    const downstream = defineNode({
      name: "downstream",
      input: single(Start),
      output: single(Start),
      fn: (s) => s,
    });
    const program = programWith(
      { failing, downstream },
      { origins: ["failing"], feeds: { failing: ["downstream"] } },
    );
    const log = new InMemoryLog();

    const result = await runNetlist(program, log, "thread-1", { failing: { value: "a" } });

    expect(result.failures).toEqual([]);
    expect(log.latest("Failed_Start", "thread-1")).toEqual({ input: { value: "a" }, reason: "kaboom" });
    expect(log.latest("Start", "thread-1")).toBeUndefined();
  });

  it("a downstream node declaring Failed_<InputEdgeName> as its input becomes ready once the failure is logged", async () => {
    const FailedStart = defineEdge({
      name: "Failed_Start",
      label: "Failed (Start)",
      description: "d",
      fields: { input: Start, reason: defineField({ type: "utf8", label: "Reason", description: "d", nullable: true }) },
    });
    const failing = defineNode({
      name: "failing",
      input: single(Start),
      output: single(Start),
      fn: () => {
        throw new Error("kaboom");
      },
    });
    const handleFailed = defineNode({
      name: "handleFailed",
      input: single(FailedStart),
      output: single(Start),
      fn: (failed) => failed.input,
    });
    const program: Program = {
      fields: {},
      edges: { Start, Failed_Start: FailedStart },
      nodes: { failing, handleFailed },
      wiring: { origins: ["failing"], feeds: { failing: ["handleFailed"] } },
    };
    const log = new InMemoryLog();

    const result = await runNetlist(program, log, "thread-1", { failing: { value: "a" } });

    expect(result.failures).toEqual([]);
    expect(log.latest("Failed_Start", "thread-1")).toEqual({ input: { value: "a" }, reason: "kaboom" });
    expect(log.latest("Start", "thread-1")).toEqual({ value: "a" });
  });

  it("routes an allOf-input node's failure to the sorted-name combo edge, order-independent", async () => {
    const A = defineEdge({
      name: "A",
      label: "A",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const B = defineEdge({
      name: "B",
      label: "B",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const failingJoin = defineNode({
      name: "failingJoin",
      input: allOf(B, A), // declared out of alphabetical order — the synthesized name should sort anyway
      output: single(Start),
      fn: () => {
        throw new Error("kaboom");
      },
    });
    const program: Program = {
      fields: {},
      edges: { Start, A, B },
      nodes: { failingJoin },
      wiring: { origins: ["failingJoin"], feeds: {} },
    };
    const log = new InMemoryLog();
    log.append("A", "thread-1", { value: "a" });
    log.append("B", "thread-1", { value: "b" });

    const result = await runNetlist(program, log, "thread-1", {});

    expect(result.failures).toEqual([]);
    expect(log.latest("Failed_A_B", "thread-1")).toEqual({
      A: { value: "a" },
      B: { value: "b" },
      reason: "kaboom",
    });
  });

  it("routes a oneOf output — logs only the edge that actually fired", async () => {
    const Pass = defineEdge({ name: "Pass", label: "Pass", description: "d", fields: {} });
    const Fail = defineEdge({ name: "Fail", label: "Fail", description: "d", fields: {} });
    const checker = defineNode({
      name: "checker",
      input: single(Start),
      output: { kind: "oneOf", edges: [Pass, Fail] },
      fn: (s) => (s.value === "ok" ? { edge: "Pass" as const, payload: {} } : { edge: "Fail" as const, payload: {} }),
    });
    const program: Program = {
      fields: {},
      edges: { Start, Pass, Fail },
      nodes: { checker },
      wiring: { origins: ["checker"], feeds: {} },
    };
    const log = new InMemoryLog();

    const result = await runNetlist(program, log, "thread-1", { checker: { value: "ok" } });

    expect(log.latest("Pass", "thread-1")).toEqual({});
    expect(log.latest("Fail", "thread-1")).toBeUndefined();
    expect(result.failures).toEqual([]);
  });

  it("routes an allOf output — logs every tagged branch", async () => {
    const InvoiceRequested = defineEdge({
      name: "InvoiceRequested",
      label: "Invoice requested",
      description: "d",
      fields: {},
    });
    const InventoryReserved = defineEdge({
      name: "InventoryReserved",
      label: "Inventory reserved",
      description: "d",
      fields: {},
    });
    const placeOrder = defineNode({
      name: "placeOrder",
      input: single(Start),
      output: { kind: "allOf", edges: [InvoiceRequested, InventoryReserved] },
      fn: () => [
        { edge: "InvoiceRequested" as const, payload: {} },
        { edge: "InventoryReserved" as const, payload: {} },
      ],
    });
    const program: Program = {
      fields: {},
      edges: { Start, InvoiceRequested, InventoryReserved },
      nodes: { placeOrder },
      wiring: { origins: ["placeOrder"], feeds: {} },
    };
    const log = new InMemoryLog();

    const result = await runNetlist(program, log, "thread-1", { placeOrder: { value: "a" } });

    expect(log.latest("InvoiceRequested", "thread-1")).toEqual({});
    expect(log.latest("InventoryReserved", "thread-1")).toEqual({});
    expect(result.failures).toEqual([]);
  });

  it("routes a many output — logs the whole collection as one edge instance", async () => {
    const Sibling = defineEdge({
      name: "Sibling",
      label: "Sibling",
      description: "d",
      index: "age",
      fields: { age: defineField({ type: "uint8", label: "Age", description: "d", nullable: false }) },
    });
    const siblings = defineNode({
      name: "siblings",
      input: single(Start),
      output: { kind: "many", edge: Sibling },
      fn: () => ({ "8": { age: 8 }, "12": { age: 12 } }),
    });
    const program: Program = {
      fields: {},
      edges: { Start, Sibling },
      nodes: { siblings },
      wiring: { origins: ["siblings"], feeds: {} },
    };
    const log = new InMemoryLog();

    const result = await runNetlist(program, log, "thread-1", { siblings: { value: "a" } });

    expect(log.latest("Sibling", "thread-1")).toEqual({ "8": { age: 8 }, "12": { age: 12 } });
    expect(result.failures).toEqual([]);
  });

  it("runs the real person-birthday topology end-to-end", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-runtime-"));
    try {
      const raw = await elaborate(PERSON_BIRTHDAY_SRC);

      const birthdayHash = (await hashNode(raw.nodes.birthday!)).short;
      await mkdir(join(dir, "birthday"), { recursive: true });
      await writeFile(
        join(dir, "birthday", `${birthdayHash}.ts`),
        `export default function birthday(payload) { return { age: payload.age + 1, nickname: null }; }\n`,
        "utf8",
      );
      const expectHash = (await hashNode(raw.nodes.expect_Person_age_42!)).short;
      await mkdir(join(dir, "expect_Person_age_42"), { recursive: true });
      await writeFile(
        join(dir, "expect_Person_age_42", `${expectHash}.ts`),
        `export default function expect_Person_age_42(payload) {
  return payload.age === 42 ? { edge: "Pass", payload: {} } : { edge: "Fail", payload: {} };
}
`,
        "utf8",
      );

      const program = await elaborateWithImplementations(PERSON_BIRTHDAY_SRC, dir);
      const log = new InMemoryLog();

      const result = await runNetlist(program, log, "thread-1", { birthday: { age: 41, nickname: null } });

      expect(log.latest("Person", "thread-1")).toEqual({ age: 42, nickname: null });
      expect(log.latest("Pass", "thread-1")).toEqual({});
      expect(log.latest("Fail", "thread-1")).toBeUndefined();
      expect(result.failures).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs the real todo-list topology — CompleteTodo fires from CreateTodo's output; AddTodoToList never becomes ready", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-runtime-"));
    try {
      const raw = await elaborate(TODO_LIST_SRC);

      for (const [name, fn] of [
        ["CreateTodo", `export default function CreateTodo(payload) { return payload; }`],
        ["CompleteTodo", `export default function CompleteTodo(payload) { return { ...payload, is_complete: true }; }`],
        ["AddTodoToList", `export default function AddTodoToList(payload) { return payload.TodoList; }`],
      ] as const) {
        const hash = (await hashNode(raw.nodes[name]!)).short;
        await mkdir(join(dir, name), { recursive: true });
        await writeFile(join(dir, name, `${hash}.ts`), `${fn}\n`, "utf8");
      }

      const program = await elaborateWithImplementations(TODO_LIST_SRC, dir);
      const log = new InMemoryLog();
      const todo = { id: "todo-1", title: "Buy milk and eggs", description: null, is_complete: false };

      const result = await runNetlist(program, log, "thread-1", { CreateTodo: todo });

      expect(log.latest("Todo", "thread-1")).toEqual({ ...todo, is_complete: true });
      expect(log.latest("TodoList", "thread-1")).toBeUndefined();
      expect(result.failures).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("real: AddTodoToList fails on a malformed Todo — allOf-input Failed<In> routes to Failed_Todo_TodoList", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-runtime-"));
    try {
      const raw = await elaborate(TODO_LIST_SRC);

      for (const [name, fn] of [
        ["CreateTodo", `export default function CreateTodo(payload) { return payload; }`],
        ["CompleteTodo", `export default function CompleteTodo(payload) { return { ...payload, is_complete: true }; }`],
        ["AddTodoToList", `export default function AddTodoToList(payload) { return payload.TodoList; }`],
      ] as const) {
        const hash = (await hashNode(raw.nodes[name]!)).short;
        await mkdir(join(dir, name), { recursive: true });
        await writeFile(join(dir, name, `${hash}.ts`), `${fn}\n`, "utf8");
      }

      const program = await elaborateWithImplementations(TODO_LIST_SRC, dir);
      const log = new InMemoryLog();
      const validTodoList = { title: "Grocery List", description: null, tasks: {} };
      // title should be a string — a real assertPayload type violation, not a
      // `validations` (minLength etc.) one, since those aren't enforced yet.
      const malformedTodo = { id: "todo-1", title: 12345, description: null, is_complete: false };
      log.append("TodoList", "thread-1", validTodoList);
      log.append("Todo", "thread-1", malformedTodo);

      const result = await runNetlist(
        { ...program, wiring: { origins: ["AddTodoToList"], feeds: {} } },
        log,
        "thread-1",
        {},
      );

      expect(result.failures).toEqual([]);
      expect(log.latest("Failed_Todo_TodoList", "thread-1")).toEqual({
        TodoList: validTodoList,
        Todo: malformedTodo,
        reason: expect.stringMatching(/title/),
      });
      expect(log.latest("TodoList", "thread-1")).toEqual(validTodoList);
      expect(log.latest("Failed_Todo", "thread-1")).toBeUndefined();
      expect(log.latest("Failed_TodoList", "thread-1")).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs the real recipe topology end-to-end — bake waits for both mix and preheatOven before firing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-runtime-"));
    try {
      const raw = await elaborate(RECIPE_SRC);

      for (const [name, fn] of [
        ["gatherIngredients", `export default function gatherIngredients(payload) { return payload; }`],
        [
          "mix",
          `export default function mix(payload) { return { title: payload.title, servings: payload.servings }; }`,
        ],
        [
          "preheatOven",
          `export default function preheatOven(payload) { return { temperature: payload.temperature, preheated: true }; }`,
        ],
        [
          "bake",
          `export default function bake(payload) { return { title: payload.Dough.title, servings: payload.Dough.servings }; }`,
        ],
        ["cool", `export default function cool(payload) { return { ...payload, done: true }; }`],
      ] as const) {
        const hash = (await hashNode(raw.nodes[name]!)).short;
        await mkdir(join(dir, name), { recursive: true });
        await writeFile(join(dir, name, `${hash}.ts`), `${fn}\n`, "utf8");
      }

      const program = await elaborateWithImplementations(RECIPE_SRC, dir);
      const log = new InMemoryLog();
      const recipe = {
        title: "Chocolate Chip Cookies",
        servings: 24,
        temperature: 375,
        ingredients: { Butter: { name: "Butter", amount: "1 cup, softened" } },
      };

      const result = await runNetlist(program, log, "thread-1", { gatherIngredients: recipe });

      expect(log.latest("Dough", "thread-1")).toEqual({ title: recipe.title, servings: recipe.servings });
      expect(log.latest("Oven", "thread-1")).toEqual({ temperature: recipe.temperature, preheated: true });
      expect(log.latest("BakedCookies", "thread-1")).toEqual({
        title: recipe.title,
        servings: recipe.servings,
      });
      expect(log.latest("Cookies", "thread-1")).toEqual({
        title: recipe.title,
        servings: recipe.servings,
        done: true,
      });
      expect(result.failures).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("real: an anyOf-desugared shadow fires through the worklist via an aliased .topology reference", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weir-runtime-"));
    const root = await mkdtemp(join(tmpdir(), "weir-decl-"));
    try {
      await mkdir(join(root, "edges"), { recursive: true });
      await mkdir(join(root, "nodes"), { recursive: true });
      await mkdir(join(root, "topology"), { recursive: true });
      // Todo/Person exist so elaborate()'s unconditional synthesizeFailedEdges
      // auto-creates Failed_Todo/Failed_Person for us — hand-authoring those
      // edges directly would fight that mechanism and produce the wrong shape
      // ({input: <embedded Todo/Person>, reason}, not a bare scalar).
      await writeFile(
        join(root, "edges", "Todo.edge"),
        `description: d\nfields:\n  title:\n    type: utf8\n    label: v\n    description: d\n    nullable: false\n`,
        "utf8",
      );
      await writeFile(
        join(root, "edges", "Person.edge"),
        `description: d\nfields:\n  name:\n    type: utf8\n    label: v\n    description: d\n    nullable: false\n`,
        "utf8",
      );
      await writeFile(
        join(root, "edges", "Start.edge"),
        `description: d\nfields:\n  value:\n    type: utf8\n    label: v\n    description: d\n    nullable: false\n`,
        "utf8",
      );
      await writeFile(
        join(root, "nodes", "failing.node"),
        `description: d\ninput: Todo\noutput: Todo\nexamples:\n  - given:\n      Todo:\n        title: "bad todo"\n    expect:\n      Todo:\n        title: "bad todo"\n`,
        "utf8",
      );
      await writeFile(
        join(root, "nodes", "HandleFailed.node"),
        `description: d\ninput:\n  anyOf:\n    - Failed_Todo\n    - Failed_Person\noutput: Start\nexamples:\n  - given:\n      Failed_Todo:\n        input:\n          title: "bad todo"\n        reason: "kaboom"\n    expect:\n      Start:\n        value: "recovered"\n  - given:\n      Failed_Person:\n        input:\n          name: "bad person"\n        reason: "kaboom"\n    expect:\n      Start:\n        value: "recovered"\n`,
        "utf8",
      );
      await writeFile(join(root, "topology", "main.topology"), `failing:\n  then:\n    HandleFailed: {}\n`, "utf8");

      const raw = await elaborate(root);
      // failing fails on Todo -> logs Failed_Todo, which HandleFailed__Failed_Todo
      // is listening for; HandleFailed__Failed_Person never becomes ready (nothing
      // ever logs Failed_Person) — proving the alias's "wasted, harmless attempt"
      // on the shadow that can't actually fire, not just the one that can.
      for (const [name, fn] of [
        ["failing", `export default function failing() { throw new Error("kaboom"); }`],
        ["HandleFailed__Failed_Todo", `export default function handle() { return { value: "recovered" }; }`],
        ["HandleFailed__Failed_Person", `export default function handle() { return { value: "recovered" }; }`],
      ] as const) {
        const hash = (await hashNode(raw.nodes[name]!)).short;
        await mkdir(join(dir, name), { recursive: true });
        await writeFile(join(dir, name, `${hash}.ts`), `${fn}\n`, "utf8");
      }

      const program = await elaborateWithImplementations(root, dir);
      const log = new InMemoryLog();

      await runNetlist(program, log, "thread-1", { failing: { title: "bad todo" } });

      expect(log.latest("Failed_Todo", "thread-1")).toEqual({ input: { title: "bad todo" }, reason: "kaboom" });
      expect(log.latest("Failed_Person", "thread-1")).toBeUndefined();
      expect(log.latest("Start", "thread-1")).toEqual({ value: "recovered" });
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });

  it("desugared shadows fire independently — no cross-shadow exclusivity, unlike the old any", async () => {
    const A = defineEdge({
      name: "A",
      label: "A",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const B = defineEdge({
      name: "B",
      label: "B",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const Out = defineEdge({
      name: "Out",
      label: "Out",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    // A side-effect counter, not the shared Out edge's log state, proves both
    // fired: InMemoryLog.latest() only keeps the most recent write, so two
    // firings to the same edge would be indistinguishable from "only one
    // fired" by log state alone. defineAnyOfNodes shares one `output` across
    // every shadow (same as parseAnyOfNodeFile's .node YAML equivalent), so
    // there's no way to give each shadow its own output edge to tell them
    // apart that way either — the counter is the real, unambiguous proof.
    const received: string[] = [];
    const shadows = defineAnyOfNodes("Handle", [A, B], single(Out), (payload) => {
      received.push(payload.value);
      return { value: payload.value };
    });
    // Both listed as origins with real originPayloads, not pre-logged edges
    // read via log.latest — runNetlist requires an origin's payload to come
    // from originPayloads (it returns false early otherwise, never touching
    // the log), so this is the correct way to seed two independent origins
    // in one worklist run, not a simplification of the real scenario.
    const program = programWith(shadows, { origins: ["Handle__A", "Handle__B"], feeds: {} });
    const log = new InMemoryLog();

    await runNetlist(program, log, "thread-1", { Handle__A: { value: "a" }, Handle__B: { value: "b" } });

    expect(received.sort()).toEqual(["a", "b"]);
  });
});
