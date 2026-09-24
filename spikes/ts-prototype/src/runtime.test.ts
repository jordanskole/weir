import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defineEdge, defineField, defineNode, defineAnyOfNodes, allOf, single } from "./define.js";
import { elaborate } from "./elaborate.js";
import { hashEdge, hashNode } from "./hash.js";
import { elaborateWithImplementations } from "./implementation.js";
import { InMemoryLog } from "./membrane.js";
import { eligibleInstances, runNetlist } from "./runtime.js";
import { InMemoryTrace } from "./trace.js";
import type { Program } from "./implementation.js";
import type { NodeDef } from "./types.js";
import type { InstanceEnvelope } from "./membrane.js";

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

    const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { doubled: { value: "a" } } }, { log });

    expect(result.failures).toEqual([]);
    expect(log.latest("Start", "thread-1")).toEqual({ value: "aa" });
  });

  it("stores per-instance provenance on the logged instance — envelope.node and envelope.schemaHash for the emitted edge", async () => {
    const doubled = defineNode({
      name: "doubled",
      input: single(Start),
      output: single(Start),
      fn: (s) => ({ value: s.value + s.value }),
    });
    const program = programWith({ doubled }, { origins: ["doubled"], feeds: {} });
    const log = new InMemoryLog();

    await runNetlist(program, { correlationId: "thread-1", originPayloads: { doubled: { value: "a" } } }, { log });

    const instance = log.latestInstance("Start", "thread-1");
    expect(instance?.payload).toEqual({ value: "aa" });
    expect(instance?.envelope?.node).toBe("doubled");
    expect(instance?.envelope?.schemaHash).toBe((await hashEdge(Start)).hash);
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

    await runNetlist(program, { correlationId: "thread-1", originPayloads: {} }, { log });

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

    await runNetlist(program, { correlationId: "thread-1", originPayloads: { step1: { value: "a" } } }, { log });

    expect(log.latest("Start", "thread-1")).toEqual({ value: "a-1-2" });
  });

  it("records one trace entry per invocation, each pinned to the node/contractHash that ran, with its real input and result", async () => {
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
    const trace = new InMemoryTrace();

    await runNetlist(program, { correlationId: "thread-1", originPayloads: { step1: { value: "a" } } }, { log, trace });

    const entries = trace.entries("thread-1");
    expect(entries).toHaveLength(2);

    expect(entries[0]?.envelope.node).toBe("step1");
    expect(entries[0]?.envelope.contractHash).toBe((await hashNode(step1)).hash);
    expect(entries[0]?.input).toEqual({ value: "a" });
    expect(entries[0]?.result).toEqual({ value: "a-1" });

    expect(entries[1]?.envelope.node).toBe("step2");
    expect(entries[1]?.envelope.contractHash).toBe((await hashNode(step2)).hash);
    expect(entries[1]?.input).toEqual({ value: "a-1" });
    expect(entries[1]?.result).toEqual({ value: "a-1-2" });
  });

  it("records the assembled bag as the input for an allOf-input node's trace entry", async () => {
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
    const nodeC = defineNode({
      name: "nodeC",
      input: allOf(A, B),
      output: single(C),
      fn: ({ A, B }) => ({ value: `${A.value}+${B.value}` }),
    });
    const program: Program = {
      fields: {},
      edges: { Start, A, B, C },
      nodes: { nodeC },
      wiring: { origins: ["nodeC"], feeds: {} },
    };
    const log = new InMemoryLog();
    const trace = new InMemoryTrace();
    log.append("A", "thread-1", { value: "a" });
    log.append("B", "thread-1", { value: "b" });

    await runNetlist(program, { correlationId: "thread-1", originPayloads: {} }, { log, trace });

    const entries = trace.entries("thread-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.envelope.node).toBe("nodeC");
    expect(entries[0]?.envelope.contractHash).toBe((await hashNode(nodeC)).hash);
    expect(entries[0]?.input).toEqual({ A: { value: "a" }, B: { value: "b" } });
    expect(entries[0]?.result).toEqual({ value: "a+b" });
  });

  it("records a trace entry and a provenance-carrying Failed_* instance for a rejected input — before 2026-09-24 a rejection produced neither", async () => {
    const FailedStart = defineEdge({
      name: "Failed_Start",
      label: "Failed (Start)",
      description: "d",
      fields: { input: Start, reason: defineField({ type: "utf8", label: "Reason", description: "d", nullable: true }) },
    });
    const rejecting = defineNode({
      name: "rejecting",
      input: single(Start),
      output: single(Start),
      fn: (s) => s,
    });
    const program: Program = {
      fields: {},
      edges: { Start, Failed_Start: FailedStart },
      nodes: { rejecting },
      wiring: { origins: ["rejecting"], feeds: {} },
    };
    const log = new InMemoryLog();
    const trace = new InMemoryTrace();

    // Malformed payload (`value` is a number, Start declares it `utf8`):
    // assertPayload rejects it, but membrane() now builds the envelope
    // *before* asserting, so this attempt is observable — a real trace
    // entry, and a Failed_Start instance that carries provenance instead of
    // looking exactly like a staged input.
    await runNetlist(
      program,
      { correlationId: "thread-1", originPayloads: { rejecting: { value: 5 } } },
      { log, trace },
    );

    const entries = trace.entries("thread-1");
    expect(entries).toHaveLength(1);
    expect(entries[0]?.envelope.node).toBe("rejecting");
    expect(entries[0]?.envelope.contractHash).toBe((await hashNode(rejecting)).hash);
    expect(entries[0]?.input).toEqual({ value: 5 });
    expect(entries[0]?.result).toEqual({ input: { value: 5 }, reason: expect.stringMatching(/value/) });

    const instance = log.latestInstance("Failed_Start", "thread-1");
    expect(instance?.envelope).toBeDefined();
    expect(instance?.envelope?.node).toBe("rejecting");
    expect(instance?.envelope?.schemaHash).toBe((await hashEdge(FailedStart)).hash);
  });

  it("a bad scope declaration — the one remaining no-envelope path — logs Failed<In> with no provenance and records no trace entry, without corrupting either", async () => {
    const FailedStart = defineEdge({
      name: "Failed_Start",
      label: "Failed (Start)",
      description: "d",
      fields: { input: Start, reason: defineField({ type: "utf8", label: "Reason", description: "d", nullable: true }) },
    });
    const badScope = defineNode({
      name: "badScope",
      input: single(Start),
      output: single(Start),
      // Not "read:Identity:<field>" — buildEnvelope throws before the input
      // is ever asserted, so this node fails on every input, valid or not.
      scope: ["read:Identity:bogus"],
      fn: (s) => s,
    });
    const program: Program = {
      fields: {},
      edges: { Start, Failed_Start: FailedStart },
      nodes: { badScope },
      wiring: { origins: ["badScope"], feeds: {} },
    };
    const log = new InMemoryLog();
    const trace = new InMemoryTrace();

    // A perfectly valid Start payload — isolating the failure to the
    // declaration itself, not the data. membrane()'s Invocation.envelope is
    // absent here specifically because buildEnvelope itself threw (a
    // declaration bug), the one case that stays optional after 2026-09-24's
    // reordering (see membrane.ts's Invocation doc comment).
    const result = await runNetlist(
      program,
      { correlationId: "thread-1", originPayloads: { badScope: { value: "a" } } },
      { log, trace },
    );

    expect(result.stopped).toBe("quiescence");
    expect(log.latest("Failed_Start", "thread-1")).toEqual({
      input: { value: "a" },
      reason: expect.stringMatching(/bogus/),
    });
    expect(log.latest("Start", "thread-1")).toBeUndefined();

    // No envelope to build a trace entry from — tryFire's `envelope !==
    // undefined` guard excludes it, rather than recording a trace entry
    // with no envelope.
    expect(trace.entries("thread-1")).toEqual([]);

    // No envelope to hash the instance's provenance from either —
    // instanceEnvelope's `!envelope` guard returns undefined cleanly here,
    // rather than spreading `undefined` into `{ schemaHash }` and minting a
    // corrupt InstanceEnvelope missing every real field.
    const instance = log.latestInstance("Failed_Start", "thread-1");
    expect(instance?.envelope).toBeUndefined();
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

    await runNetlist(program, { correlationId: "thread-1", originPayloads: { origin: { value: "a" } } }, { log });

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

    await runNetlist(program, { correlationId: "thread-1", originPayloads: { nodeA: { value: "a" } } }, { log });

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

    const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { failing: { value: "a" } } }, { log });

    expect(result.failures).toEqual([]);
    expect(log.latest("Failed_Start", "thread-1")).toEqual({ input: { value: "a" }, reason: "kaboom" });
    expect(log.latest("Start", "thread-1")).toBeUndefined();
    // Failed_Start is synthesized by the elaborator, not declared in this
    // hand-built program's `edges` — a missing synthesized edge is an
    // elaborator concern, not something the runtime fails the run over, so
    // the instance is logged with no envelope rather than throwing.
    expect(program.edges.Failed_Start).toBeUndefined();
    expect(log.latestInstance("Failed_Start", "thread-1")?.envelope).toBeUndefined();
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

    const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { failing: { value: "a" } } }, { log });

    expect(result.failures).toEqual([]);
    expect(log.latest("Failed_Start", "thread-1")).toEqual({ input: { value: "a" }, reason: "kaboom" });
    expect(log.latest("Start", "thread-1")).toEqual({ value: "a" });
    // Failed_Start *is* declared in this program's `edges` (FailedStart,
    // above) — the runtime looks it up and hashes it, same as any other
    // emitted instance.
    expect(log.latestInstance("Failed_Start", "thread-1")?.envelope?.schemaHash).toBe(
      (await hashEdge(FailedStart)).hash,
    );
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

    const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: {} }, { log });

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

    const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { checker: { value: "ok" } } }, { log });

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

    const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { placeOrder: { value: "a" } } }, { log });

    expect(log.latest("InvoiceRequested", "thread-1")).toEqual({});
    expect(log.latest("InventoryReserved", "thread-1")).toEqual({});
    expect(result.failures).toEqual([]);

    // Same invocation (one call to placeOrder), two emitted instances: the
    // envelope.id ties them back to that one invocation, but each carries
    // the schema hash of the edge it was actually written under — the whole
    // reason this lives at instance grain rather than on the invocation.
    const invoiceInstance = log.latestInstance("InvoiceRequested", "thread-1");
    const inventoryInstance = log.latestInstance("InventoryReserved", "thread-1");
    expect(invoiceInstance?.envelope?.id).toBeDefined();
    expect(invoiceInstance?.envelope?.id).toBe(inventoryInstance?.envelope?.id);
    expect(invoiceInstance?.envelope?.schemaHash).toBe((await hashEdge(InvoiceRequested)).hash);
    expect(inventoryInstance?.envelope?.schemaHash).toBe((await hashEdge(InventoryReserved)).hash);
    expect(invoiceInstance?.envelope?.schemaHash).not.toBe(inventoryInstance?.envelope?.schemaHash);
    // envelope.id can't distinguish these two instances — same invocation,
    // so same id — which is exactly the case the spec calls out `seq` for
    // (docs/superpowers/specs/2026-09-24-instance-retention-and-iteration.md,
    // Testing: "`seq` distinct for two instances an `allOf`-output node
    // emits from one invocation"). `seq` is minted per append, so it must
    // differ even though `id` doesn't.
    expect(invoiceInstance?.seq).toBeDefined();
    expect(inventoryInstance?.seq).toBeDefined();
    expect(invoiceInstance?.seq).not.toBe(inventoryInstance?.seq);
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

    const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { siblings: { value: "a" } } }, { log });

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

      const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { birthday: { age: 41, nickname: null } } }, { log });

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

      const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { CreateTodo: todo } }, { log });

      expect(log.latest("Todo", "thread-1")).toEqual({ ...todo, is_complete: true });
      expect(log.latest("TodoList", "thread-1")).toBeUndefined();
      expect(result.failures).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("real: CreateTodo rejects a caller trying to set is_complete — NewTodo's literal pin is enforced at invocation", async () => {
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
      const attempt = { id: "todo-1", title: "Buy milk and eggs", description: null, is_complete: true };

      const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { CreateTodo: attempt } }, { log });

      expect(result.failures).toEqual([]);
      expect(log.latest("Failed_NewTodo", "thread-1")).toEqual({
        input: attempt,
        reason: expect.stringMatching(/is_complete is pinned to false, got boolean/),
      });
      expect(log.latest("Todo", "thread-1")).toBeUndefined();
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

      // Only the wiring is narrowed, not `program.nodes`: CompleteTodo also
      // declares Todo as its input and the staged instance is envelope-less
      // (so eligible by type), but this wiring does not reach it, and the
      // pulse loop scans only what the wiring reaches. The per-edge-routing
      // assertions below therefore measure AddTodoToList's failure routing
      // and nothing else.
      const result = await runNetlist(
        { ...program, wiring: { origins: ["AddTodoToList"], feeds: {} } },
        { correlationId: "thread-1", originPayloads: {} },
        { log },
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
          `export default function bake(payload) { return { title: payload.Dough.title, servings: payload.Dough.servings, done: false }; }`,
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

      const result = await runNetlist(program, { correlationId: "thread-1", originPayloads: { gatherIngredients: recipe } }, { log });

      expect(log.latest("Dough", "thread-1")).toEqual({ title: recipe.title, servings: recipe.servings });
      expect(log.latest("Oven", "thread-1")).toEqual({ temperature: recipe.temperature, preheated: true });
      expect(log.latest("BakedCookies", "thread-1")).toEqual({
        title: recipe.title,
        servings: recipe.servings,
        done: false,
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

  it("real: an anyOf-desugared shadow fires through the pulse loop via an aliased .topology reference", async () => {
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

      await runNetlist(program, { correlationId: "thread-1", originPayloads: { failing: { title: "bad todo" } } }, { log });

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
    // in one pulse-loop run, not a simplification of the real scenario.
    const program = programWith(shadows, { origins: ["Handle__A", "Handle__B"], feeds: {} });
    const log = new InMemoryLog();

    await runNetlist(program, { correlationId: "thread-1", originPayloads: { Handle__A: { value: "a" }, Handle__B: { value: "b" } } }, { log });

    expect(received.sort()).toEqual(["a", "b"]);
  });
});

// ---------------------------------------------------------------------------
// Fixtures for the pulse loop. Each is the smallest topology that makes its
// assertion mean something; the comment on each says which bug it is there to
// catch.
// ---------------------------------------------------------------------------

/**
 * The canonical example, hand-built rather than elaborated from disk: an
 * origin emitting `Person`, and `birthday: Person → Person` consuming it.
 * `birthday` is deliberately *not* wired back to itself, so its own output is
 * ineligible for it under arc-based readiness. Readiness by edge *type* would
 * let it eat its own `Person` forever.
 *
 * Deliberately hand-built rather than loaded from the real
 * `examples/person-birthday` files — do not "upgrade" this to elaborate the
 * real ones, even though that would look like a simplification. In the real
 * `.node`/`.topology` files `birthday` *is* the origin, and an origin fires
 * at most once per run regardless of readiness (`originsFired`) — that
 * once-only branch would mask a type-based-readiness runaway entirely,
 * since `birthday` would never get a second chance to eat its own output no
 * matter which readiness rule is in effect. This fixture adds a separate
 * `origin` node precisely so `birthday` is a non-origin, which is what makes
 * "leaves the canonical example unchanged" below a genuine §4 regression
 * test rather than one that would pass under the old, broken by-type
 * readiness too. The real topology is exercised separately, end-to-end, by
 * "runs the real person-birthday topology end-to-end" above.
 */
const Person = defineEdge({
  name: "Person",
  label: "Person",
  description: "d",
  fields: { age: defineField({ type: "uint8", label: "Age", description: "d", nullable: false }) },
});
const personOrigin = defineNode({
  name: "origin",
  input: single(Person),
  output: single(Person),
  fn: (p) => p,
});
const birthday = defineNode({
  name: "birthday",
  input: single(Person),
  output: single(Person),
  fn: (p) => ({ age: p.age + 1 }),
});
const personBirthdayProgram = programWith(
  { origin: personOrigin, birthday },
  { origins: ["origin"], feeds: { origin: ["birthday"] } },
);

/**
 * A real cycle. `seed` starts it; `countToThree` is wired back to itself and
 * emits `Continue` until the bound, then the terminal `Done` branch nothing
 * routes back — the base case that makes the graph go quiet. `forever` is the
 * same node with the same output contract, minus the terminal branch.
 */
const Continue = defineEdge({
  name: "Continue",
  label: "Continue",
  description: "d",
  fields: { n: defineField({ type: "uint8", label: "n", description: "d", nullable: false }) },
});
const Done = defineEdge({
  name: "Done",
  label: "Done",
  description: "d",
  fields: { n: defineField({ type: "uint8", label: "n", description: "d", nullable: false }) },
});
const seed = defineNode({
  name: "seed",
  input: single(Continue),
  output: single(Continue),
  fn: (c) => c,
});
const countToThree = defineNode({
  name: "countToThree",
  input: single(Continue),
  output: { kind: "oneOf", edges: [Continue, Done] },
  fn: (c) => (c.n >= 3 ? { edge: "Done" as const, payload: c } : { edge: "Continue" as const, payload: { n: c.n + 1 } }),
});
const forever = defineNode({
  name: "forever",
  input: single(Continue),
  output: { kind: "oneOf", edges: [Continue, Done] },
  fn: (c) => ({ edge: "Continue" as const, payload: { n: c.n + 1 } }),
});
const countToThreeProgram = programWith(
  { seed, countToThree },
  { origins: ["seed"], feeds: { seed: ["countToThree"], countToThree: ["countToThree"] } },
);
const foreverProgram = programWith(
  { seed, forever },
  { origins: ["seed"], feeds: { seed: ["forever"], forever: ["forever"] } },
);

/**
 * `forever`'s endless self-feeding loop plus one unrelated node that is
 * ready from pulse 1 and shares none of `forever`'s edges. The "no
 * starvation" test (spec Testing section) needs exactly this shape: a
 * self-feeding node and an independent ready node in one topology, so a
 * scheduler that only re-offers whichever node is already looping —
 * instead of scanning every reachable node every pulse — has something to
 * starve.
 */
const Independent = defineEdge({
  name: "Independent",
  label: "Independent",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const sideOrigin = defineNode({
  name: "sideOrigin",
  input: single(Independent),
  output: single(Independent),
  fn: (v) => v,
});
const foreverWithSideProgram = programWith(
  { seed, forever, sideOrigin },
  { origins: ["seed", "sideOrigin"], feeds: { seed: ["forever"], forever: ["forever"] } },
);

/**
 * One instance consumed independently by two nodes. Both consumers fire in the
 * same pulse, which is what makes them siblings: same `step`, different `seq`.
 */
const FanOutLeft = defineEdge({
  name: "Left",
  label: "Left",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const FanOutRight = defineEdge({
  name: "Right",
  label: "Right",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const fanOutProgram = programWith(
  {
    source: defineNode({ name: "source", input: single(Start), output: single(Start), fn: (s) => s }),
    toLeft: defineNode({
      name: "toLeft",
      input: single(Start),
      output: single(FanOutLeft),
      fn: (s) => ({ value: `left-${s.value}` }),
    }),
    toRight: defineNode({
      name: "toRight",
      input: single(Start),
      output: single(FanOutRight),
      fn: (s) => ({ value: `right-${s.value}` }),
    }),
  },
  { origins: ["source"], feeds: { source: ["toLeft", "toRight"] } },
);

/**
 * An `allOf` node inside a genuine cycle: `join` emits `Joined`, `recycle`
 * turns that back into a fresh `A`, which feeds `join` again. Only the
 * `firedAllOf` guard stops that looping — remove it and this runs to budget.
 */
const CycleA = defineEdge({
  name: "A",
  label: "A",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const CycleB = defineEdge({
  name: "B",
  label: "B",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const Joined = defineEdge({
  name: "Joined",
  label: "Joined",
  description: "d",
  fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
});
const allOfInCycleProgram = programWith(
  {
    a: defineNode({ name: "a", input: single(CycleA), output: single(CycleA), fn: (v) => v }),
    b: defineNode({ name: "b", input: single(CycleB), output: single(CycleB), fn: (v) => v }),
    join: defineNode({
      name: "join",
      input: allOf(CycleA, CycleB),
      output: single(Joined),
      fn: ({ A, B }) => ({ value: `${A.value}+${B.value}` }),
    }),
    recycle: defineNode({
      name: "recycle",
      input: single(Joined),
      output: single(CycleA),
      fn: (j) => ({ value: j.value }),
    }),
  },
  {
    origins: ["a", "b"],
    feeds: { a: ["join"], b: ["join"], join: ["recycle"], recycle: ["join"] },
  },
);

describe("runNetlist — iteration", () => {
  it("leaves the canonical example unchanged: each node fires once, stopping on quiescence", async () => {
    // The regression test for arc-based eligibility. If readiness were by
    // edge type, birthday would consume its own Person output forever.
    const log = new InMemoryLog();
    const result = await runNetlist(
      personBirthdayProgram,
      { correlationId: "c1", originPayloads: { origin: { age: 41 } } },
      { log, budget: 50 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(result.firings).toBe(2);
    expect(log.instances("Person", "c1")).toHaveLength(2); // the origin's, and birthday's
    expect(log.latest("Person", "c1")).toEqual({ age: 42 });
  });

  it("runs a real cycle until the node emits its terminal branch", async () => {
    // countToThree is wired to itself and emits Continue until 3, then Done.
    const log = new InMemoryLog();
    const result = await runNetlist(
      countToThreeProgram,
      { correlationId: "c1", originPayloads: { seed: { n: 0 } } },
      { log, budget: 50 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(log.latest("Done", "c1")).toEqual({ n: 3 });
    // seed, then countToThree on n=0,1,2,3 — the iteration count, not just
    // the terminal value, so a loop that fired the node once more or once
    // fewer would still be caught.
    expect(result.firings).toBe(5);
    expect(log.instances("Continue", "c1")).toHaveLength(4);
  });

  it("stops on budget rather than hanging when a cycle never terminates", async () => {
    const log = new InMemoryLog();
    const result = await runNetlist(
      foreverProgram,
      { correlationId: "c1", originPayloads: { seed: { n: 0 } } },
      { log, budget: 10 },
    );

    expect(result.stopped).toBe("budget");
    expect(result.firings).toBe(10);
  });

  it("does not starve an unrelated ready node behind a self-feeding one", async () => {
    // forever never quiesces; sideOrigin is ready once, independently, from
    // pulse 1. Snapshot semantics say every reachable node is scanned for
    // candidates every pulse — not just whichever node is already looping —
    // so sideOrigin gets its turn on pulse 1 regardless of how long forever
    // keeps the run going after that. A scheduler that instead gave only
    // one node a turn per pulse (the "one firing per node per round"
    // fairness rule the spec explicitly rejects as unnecessary) would still
    // let this pass by accident; a scheduler that stopped scanning once it
    // found a ready candidate would starve sideOrigin outright — this test
    // would then see zero Independent instances rather than one.
    const log = new InMemoryLog();
    const result = await runNetlist(
      foreverWithSideProgram,
      { correlationId: "c1", originPayloads: { seed: { n: 0 }, sideOrigin: { value: "x" } } },
      { log, budget: 10 },
    );

    expect(result.stopped).toBe("budget");
    expect(log.instances("Independent", "c1")).toHaveLength(1);
    expect(log.latestInstance("Independent", "c1")?.envelope?.step).toBe(1);
    // The run kept firing forever well past sideOrigin's one turn — proof
    // sideOrigin firing wasn't just a lucky side effect of the run ending
    // early.
    expect(result.pulses).toBeGreaterThan(1);
  });

  it("does not consume within the pulse that produced — snapshot isolation", async () => {
    // A self-feeding node fires exactly once per pulse. With 10 firings
    // allowed it therefore takes 10 pulses, never draining its own output
    // inside one.
    const log = new InMemoryLog();
    const result = await runNetlist(
      foreverProgram,
      { correlationId: "c1", originPayloads: { seed: { n: 0 } } },
      { log, budget: 10 },
    );

    expect(result.pulses).toBe(result.firings);
    expect(result.pulses).toBe(10);
  });

  it("gives every invocation in a pulse the same step, and siblings different seqs", async () => {
    const log = new InMemoryLog();
    await runNetlist(
      fanOutProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 50 },
    );

    const siblings = [...log.instances("Left", "c1"), ...log.instances("Right", "c1")];
    expect(new Set(siblings.map((i) => i.envelope?.step)).size).toBe(1);
    expect(new Set(siblings.map((i) => i.seq)).size).toBe(siblings.length);
    // Sharing a step is not enough on its own — a hardcoded 0 shares it too.
    // The value has to be the pulse the siblings actually fired in, one past
    // the pulse that produced the instance they consumed.
    expect(siblings[0]?.envelope?.step).toBe(2);
    expect(log.instances("Start", "c1")[0]?.envelope?.step).toBe(1);
  });

  it("fans one instance out to two consumers without either starving the other", async () => {
    const log = new InMemoryLog();
    await runNetlist(
      fanOutProgram,
      { correlationId: "c1", originPayloads: { source: { value: "a" } } },
      { log, budget: 50 },
    );

    expect(log.instances("Left", "c1")).toHaveLength(1);
    expect(log.instances("Right", "c1")).toHaveLength(1);
  });

  it("fires a node once per queued instance, each invocation seeing its own payload at one shared step", async () => {
    // Three producers put three instances of one edge type in front of one
    // consumer. It fires three times — on *those* instances, not on whatever
    // log.latest holds by then, which is the newest of the three — and all
    // three invocations share a step while differing in seq. This is the case
    // that distinguishes step from seq, and the one that catches a firing
    // resolved by edge name instead of by the token it was handed.
    const received: string[] = [];
    const Out = defineEdge({
      name: "Out",
      label: "Out",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const producers = ["p1", "p2", "p3"].map((name) =>
      defineNode({ name, input: single(Start), output: single(Start), fn: (s) => s }),
    );
    const sink = defineNode({
      name: "sink",
      input: single(Start),
      output: single(Out),
      fn: (s) => {
        received.push(s.value);
        return { value: s.value };
      },
    });
    const program = programWith(
      { p1: producers[0]!, p2: producers[1]!, p3: producers[2]!, sink },
      { origins: ["p1", "p2", "p3"], feeds: { p1: ["sink"], p2: ["sink"], p3: ["sink"] } },
    );
    const log = new InMemoryLog();

    const result = await runNetlist(
      program,
      { correlationId: "c1", originPayloads: { p1: { value: "a" }, p2: { value: "b" }, p3: { value: "c" } } },
      { log, budget: 50 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(received.sort()).toEqual(["a", "b", "c"]);
    const out = log.instances("Out", "c1");
    expect(out).toHaveLength(3);
    expect(new Set(out.map((i) => i.envelope?.step))).toEqual(new Set([2]));
    expect(new Set(out.map((i) => i.seq)).size).toBe(3);
  });

  it("still fires an allOf node at most once — deliberately unchanged here", async () => {
    // Joining is a later spec. Pinned so that change is visible when it
    // comes rather than silent.
    const log = new InMemoryLog();
    const result = await runNetlist(
      allOfInCycleProgram,
      { correlationId: "c1", originPayloads: { a: { value: "a" }, b: { value: "b" } } },
      { log, budget: 50 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(log.instances("Joined", "c1")).toHaveLength(1);
    // The cycle is real: recycle did fire on the join's output and put a
    // fresh A back in front of join, which declined to fire again.
    expect(log.instances("A", "c1")).toHaveLength(2);
    // Three pulses, not two: join is offered only once A and B are in the
    // log at snapshot time, so it fires in the pulse after the one that
    // produced them rather than inside it.
    expect(result.pulses).toBe(3);
    expect(log.instances("Joined", "c1")[0]?.envelope?.step).toBe(2);
  });

  it("gives a fan-in node a step one past the longest path feeding it, not the shortest", async () => {
    // top → A (pulse 1); mid consumes A → B (pulse 2); zip joins A and B.
    // A is one hop from the origin and B is two, so zip belongs at step 3.
    // Node names matter here and are chosen deliberately: "zip" sorts after
    // both producers, so within a pulse it is attempted *after* they have
    // appended. A fan-in whose readiness is decided at fire time rather than
    // at snapshot time therefore fires in pulse 2 and lands at step 2 — the
    // same step as the B it just consumed. Renaming zip to something that
    // sorts first would hide that, and the test would pass for free.
    const Joined2 = defineEdge({
      name: "Joined",
      label: "Joined",
      description: "d",
      fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
    });
    const program = programWith(
      {
        top: defineNode({ name: "top", input: single(Start), output: single(CycleA), fn: (s) => ({ value: s.value }) }),
        mid: defineNode({ name: "mid", input: single(CycleA), output: single(CycleB), fn: (a) => ({ value: a.value }) }),
        zip: defineNode({
          name: "zip",
          input: allOf(CycleA, CycleB),
          output: single(Joined2),
          fn: ({ A, B }) => ({ value: `${A.value}+${B.value}` }),
        }),
      },
      { origins: ["top"], feeds: { top: ["mid", "zip"], mid: ["zip"] } },
    );
    const log = new InMemoryLog();

    const result = await runNetlist(
      program,
      { correlationId: "c1", originPayloads: { top: { value: "a" } } },
      { log, budget: 50 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(log.latest("Joined", "c1")).toEqual({ value: "a+a" });

    const consumedSteps = [
      log.latestInstance("A", "c1")?.envelope?.step,
      log.latestInstance("B", "c1")?.envelope?.step,
    ];
    expect(consumedSteps).toEqual([1, 2]); // the short path and the long one
    const fanIn = log.latestInstance("Joined", "c1")?.envelope?.step;
    expect(fanIn).toBe(3);
    for (const step of consumedSteps) expect(fanIn!).toBeGreaterThan(step!);
    expect(result.pulses).toBe(3);
  });

  it("never fires a node the wiring does not reach, even with a staged instance of its input edge", async () => {
    // Eligibility follows arcs, not types. A node with no incoming arc has
    // nothing to filter on — the envelope-less bypass would make any staged
    // instance of its input edge eligible — so the pulse scan is restricted
    // to the transitive closure of `feeds` from `origins`. The staged
    // instance here is exactly the bypass's shape: appended with no
    // envelope, as invoke.ts and the readiness fixtures do.
    const received: string[] = [];
    const wired = defineNode({ name: "wired", input: single(Start), output: single(Start), fn: (s) => s });
    const unwired = defineNode({
      name: "unwired",
      input: single(CycleA),
      output: single(Joined),
      fn: (v) => {
        received.push(v.value);
        return { value: v.value };
      },
    });
    const log = new InMemoryLog();
    log.append("A", "c1", { value: "staged" });

    const result = await runNetlist(
      programWith({ wired, unwired }, { origins: ["wired"], feeds: {} }),
      { correlationId: "c1", originPayloads: { wired: { value: "a" } } },
      { log, budget: 50 },
    );

    // The run did happen — `wired` fired — so this is not passing because
    // nothing ran at all.
    expect(result.firings).toBe(1);
    expect(log.latest("Start", "c1")).toEqual({ value: "a" });
    expect(received).toEqual([]);
    expect(log.instances("Joined", "c1")).toEqual([]);
  });

  it("does not spin when an allOf node can never become ready", async () => {
    // An allOf node is a candidate on every pulse until it fires, but
    // membrane declines it while an edge it declared is missing. Quiescence
    // has to count firings, not candidates, or this hangs.
    const log = new InMemoryLog();
    const result = await runNetlist(
      programWith(
        {
          a: defineNode({ name: "a", input: single(CycleA), output: single(CycleA), fn: (v) => v }),
          join: defineNode({
            name: "join",
            input: allOf(CycleA, CycleB),
            output: single(Joined),
            fn: ({ A, B }) => ({ value: `${A.value}+${B.value}` }),
          }),
        },
        { origins: ["a"], feeds: { a: ["join"] } },
      ),
      { correlationId: "c1", originPayloads: { a: { value: "a" } } },
      { log, budget: 50 },
    );

    expect(result.stopped).toBe("quiescence");
    expect(result.firings).toBe(1);
    expect(log.instances("Joined", "c1")).toEqual([]);
  });
});

describe("eligibleInstances", () => {
  const Value = defineEdge({
    name: "Value",
    label: "Value",
    description: "d",
    fields: { value: defineField({ type: "utf8", label: "v", description: "d", nullable: false }) },
  });
  const downstream = defineNode({
    name: "downstream",
    input: single(Value),
    output: single(Value),
    fn: (v) => v,
  });
  const someAllOfNode = defineNode({
    name: "someAllOfNode",
    input: allOf(Value),
    output: single(Value),
    fn: () => ({ value: "x" }),
  });
  // "upstream" appears only as a producer name in test envelopes, never as
  // an actual NodeDef — eligibleInstances only ever reads
  // program.wiring.feeds[envelope.node], so a bare string key is enough to
  // stand in for a real wired-in producer node.
  const program = programWith(
    { downstream, someAllOfNode },
    // someAllOfNode is wired as a second consumer of "upstream" so the arc
    // filter alone cannot empty eligibleInstances' result for it — the
    // "returns nothing for an allOf-input node" test below needs the `kind
    // !== "single"` guard to be the only thing doing the work, or it passes
    // for the wrong reason (task-3-findings.md, round 1).
    { origins: [], feeds: { upstream: ["downstream", "someAllOfNode"] } },
  );

  function envelopeFrom(node: string): InstanceEnvelope {
    return {
      id: "inv-" + node,
      correlationId: "c1",
      causationId: null,
      timestamp: new Date().toISOString(),
      step: 0,
      identity: {},
      node,
      contractHash: "hash",
      schemaHash: "edge-hash",
    };
  }

  it("returns an unconsumed instance produced by a node wired to this one", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" }, envelopeFrom("upstream"));

    const result = eligibleInstances(program, log, new Set(), program.nodes.downstream, "c1");

    expect(result.map((i) => i.payload)).toEqual([{ value: "a" }]);
  });

  it("excludes an instance produced by a node NOT wired to this one", () => {
    // The canonical-example guard: birthday emits Person and also consumes
    // Person, but nothing wires birthday to itself, so its own output is
    // not eligible for it.
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" }, envelopeFrom("unrelated"));

    expect(eligibleInstances(program, log, new Set(), program.nodes.downstream, "c1")).toEqual([]);
  });

  it("excludes an already-consumed instance", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" }, envelopeFrom("upstream"));
    const seq = log.instances("Value", "c1")[0].seq;

    expect(eligibleInstances(program, log, new Set([seq]), program.nodes.downstream, "c1")).toEqual([]);
  });

  it("treats an instance with no envelope as eligible by type — a staged input", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" });

    expect(eligibleInstances(program, log, new Set(), program.nodes.downstream, "c1")).toHaveLength(1);
  });

  it("returns instances oldest first", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "first" }, envelopeFrom("upstream"));
    log.append("Value", "c1", { value: "second" }, envelopeFrom("upstream"));

    expect(eligibleInstances(program, log, new Set(), program.nodes.downstream, "c1").map((i) => i.payload)).toEqual([
      { value: "first" },
      { value: "second" },
    ]);
  });

  it("returns nothing for an allOf-input node — that is not its job", () => {
    const log = new InMemoryLog();
    log.append("Value", "c1", { value: "a" }, envelopeFrom("upstream"));

    expect(eligibleInstances(program, log, new Set(), program.nodes.someAllOfNode, "c1")).toEqual([]);
  });
});
