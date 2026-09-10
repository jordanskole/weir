# Sealed Contract Export + Implementation Metadata Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build two pure, independently-testable functions on the TypeScript spike prototype: `exportContract(node: NodeDecl)`, which produces exactly the sealed JSON payload that would cross an isolation boundary to an agent implementing that node's `Fn`; and `computeImplementationMetadata(source: string)`, which derives cyclomatic-complexity/line-count analytics from an accepted implementation's source, purely as a side-channel with no automatic behavior anywhere downstream.

**Architecture:** `contract.ts` reuses `netlist.ts`'s existing per-field serialization logic (exported for this purpose, not duplicated) to embed full edge shapes — rather than bare name references — into a JSON structure mirroring `NetlistInputSpec`/`NetlistOutputSpec`'s existing tagging idiom. `metadata.ts` uses the `typescript` package's own compiler API (already a dependency, never previously imported as a library in this codebase) to parse implementation source and walk its AST counting decision points for a standard McCabe cyclomatic-complexity count. Neither module touches `elaborate.ts`, `hash.ts`, or any acceptance/validation logic — both are read-only, additive, and nothing else in the codebase calls into them yet.

**Tech Stack:** TypeScript (spike prototype, `spikes/ts-prototype/`), Vitest, the `typescript` package's compiler API (`ts.createSourceFile`, `ts.SyntaxKind`, `ts.isBinaryExpression`).

**Spec:** `docs/superpowers/specs/2026-09-10-sealed-contract-and-implementation-metadata.md` — this plan implements it in full. Read its Motivation section before Task 1; it explains *why* both pieces exist and why metadata is explicitly never fed back automatically — this plan only covers *how*.

## Global Constraints

- All source work happens in `spikes/ts-prototype/src/` unless a step says otherwise.
- Every task ends with `npm run typecheck` (from `spikes/ts-prototype/`) clean and `npx vitest run` fully green — no partial-red commits.
- Follow TDD: write/modify the test first, confirm it fails for the right reason, then write the minimal implementation change, then confirm it passes.
- No `Co-Authored-By: Claude` trailer on any commit (this repo's own convention).
- Commit after each task, one task per commit.
- This is a personal project with a work-hours commit convention: if the real time falls inside 9am–5pm on a weekday when you commit, shift the commit's timestamp outside that window using `git commit --date` and `GIT_COMMITTER_DATE` set to a plausible time the same day, rather than committing with the real in-hours timestamp. Check `date` before each commit.
- No new npm dependencies — `typescript` is already a `devDependency` and is available at runtime in this spike's test/dev environment (nothing here is a built/published artifact yet).

---

## Task 1: `contract.ts` — sealed contract export

**Files:**
- Modify: `spikes/ts-prototype/src/netlist.ts:61-65` (export the existing `serializeField`)
- Create: `spikes/ts-prototype/src/contract.ts`
- Test: `spikes/ts-prototype/src/contract.test.ts`

**Interfaces:**
- Consumes: `AnyEdgeDef`, `InputSpec`, `OutputSpec`, `NodeDecl` (`types.ts`, unchanged); `serializeField`, `NetlistField` (`netlist.ts`, `serializeField` newly exported by this task).
- Produces: `ContractEdgeShape`, `ContractInputSpec`, `ContractOutputSpec`, `SealedContract`, `exportContract(node: NodeDecl): SealedContract` — all from `contract.ts`, consumed by Task 2's `index.ts` export step.

- [ ] **Step 1: Export `serializeField` from `netlist.ts`**

```ts
// netlist.ts:61, before:
function serializeField(value: FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef): NetlistField {

// after:
export function serializeField(value: FieldDef | LiteralFieldDef | AnyEdgeDef | ManyEdgeDef): NetlistField {
```

No other change to `netlist.ts` — the function body, and every existing call site, stay exactly as they are.

Run: `cd spikes/ts-prototype && npx vitest run netlist.test.ts`
Expected: unaffected, still passing (a pure visibility change).

- [ ] **Step 2: Write the failing tests for `exportContract`**

Create `spikes/ts-prototype/src/contract.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { exportContract } from "./contract.js";
import type { NodeDecl } from "./types.js";

const Person = {
  name: "Person",
  label: "Person",
  description: "A person",
  fields: {
    age: { type: "uint8" as const, label: "Age", description: "The person's age", nullable: false as const },
  },
};

const Pass = { name: "Pass", label: "Pass", description: "A passing result", fields: {} };
const Fail = { name: "Fail", label: "Fail", description: "A failing result", fields: {} };

const TodoList = {
  name: "TodoList",
  label: "Todo List",
  description: "A list of todos",
  fields: {
    title: { type: "utf8" as const, label: "Title", description: "d", nullable: false as const },
  },
};

const Todo = {
  name: "Todo",
  label: "Todo",
  description: "A task",
  index: "id",
  fields: {
    id: { type: "utf8" as const, label: "ID", description: "d", nullable: false as const },
    is_complete: { literal: false as const },
  },
};

describe("exportContract", () => {
  it("exports a single-input, single-output node's full edge shapes, no description/examples/closure when absent", () => {
    const node: NodeDecl = {
      name: "birthday",
      input: { kind: "single", edge: Person },
      output: { kind: "single", edge: Person },
    };

    expect(exportContract(node)).toEqual({
      node: "birthday",
      input: {
        name: "Person",
        label: "Person",
        description: "A person",
        fields: { age: { type: "uint8", label: "Age", description: "The person's age", nullable: false } },
      },
      output: {
        name: "Person",
        label: "Person",
        description: "A person",
        fields: { age: { type: "uint8", label: "Age", description: "The person's age", nullable: false } },
      },
      failure: {
        input: {
          name: "Person",
          label: "Person",
          description: "A person",
          fields: { age: { type: "uint8", label: "Age", description: "The person's age", nullable: false } },
        },
      },
    });
  });

  it("includes description, examples, and closure only when present, and an edge's index when declared", () => {
    const node: NodeDecl = {
      name: "expect_Person_age_42",
      description: "Checks whether a person just turned 42",
      input: { kind: "single", edge: Person },
      output: { kind: "oneOf", edges: [Pass, Fail] },
      examples: [{ given: { age: 42 }, expect: { edge: "Pass", payload: {} } }],
      closure: { expected: { age: 42 } },
    };

    const contract = exportContract(node);

    expect(contract.description).toBe("Checks whether a person just turned 42");
    expect(contract.examples).toEqual([{ given: { age: 42 }, expect: { edge: "Pass", payload: {} } }]);
    expect(contract.closure).toEqual({ expected: { age: 42 } });
    expect(contract.output).toEqual({
      oneOf: [
        { name: "Pass", label: "Pass", description: "A passing result", fields: {} },
        { name: "Fail", label: "Fail", description: "A failing result", fields: {} },
      ],
    });
  });

  it("exports allOf-kind input as { allOf: [...] }, each edge in full", () => {
    const node: NodeDecl = {
      name: "AddTodoToList",
      input: { kind: "allOf", edges: [TodoList, Todo] },
      output: { kind: "single", edge: TodoList },
    };

    const contract = exportContract(node);

    expect(contract.input).toEqual({
      allOf: [
        {
          name: "TodoList",
          label: "Todo List",
          description: "A list of todos",
          fields: { title: { type: "utf8", label: "Title", description: "d", nullable: false } },
        },
        {
          name: "Todo",
          label: "Todo",
          description: "A task",
          index: "id",
          fields: {
            id: { type: "utf8", label: "ID", description: "d", nullable: false },
            is_complete: { literal: false },
          },
        },
      ],
    });
    expect(contract.failure).toEqual({
      input: {
        allOf: [
          {
            name: "TodoList",
            label: "Todo List",
            description: "A list of todos",
            fields: { title: { type: "utf8", label: "Title", description: "d", nullable: false } },
          },
          {
            name: "Todo",
            label: "Todo",
            description: "A task",
            index: "id",
            fields: {
              id: { type: "utf8", label: "ID", description: "d", nullable: false },
              is_complete: { literal: false },
            },
          },
        ],
      },
    });
  });

  it("exports many-kind output as { many: <edge shape> }", () => {
    const node: NodeDecl = {
      name: "spawnTodos",
      input: { kind: "single", edge: TodoList },
      output: { kind: "many", edge: Todo },
    };

    expect(exportContract(node).output).toEqual({
      many: {
        name: "Todo",
        label: "Todo",
        description: "A task",
        index: "id",
        fields: {
          id: { type: "utf8", label: "ID", description: "d", nullable: false },
          is_complete: { literal: false },
        },
      },
    });
  });

  it("exports allOf-kind output as { allOf: [...] }", () => {
    const node: NodeDecl = {
      name: "split",
      input: { kind: "single", edge: Person },
      output: { kind: "allOf", edges: [Pass, Fail] },
    };

    expect(exportContract(node).output).toEqual({
      allOf: [
        { name: "Pass", label: "Pass", description: "A passing result", fields: {} },
        { name: "Fail", label: "Fail", description: "A failing result", fields: {} },
      ],
    });
  });
});
```

- [ ] **Step 3: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run contract.test.ts`
Expected: fails to even collect/typecheck — `./contract.js` doesn't exist yet. `npm run typecheck` will show the same.

- [ ] **Step 4: Implement `contract.ts`**

```ts
// spikes/ts-prototype/src/contract.ts
/**
 * The sealed contract an isolated implementing agent receives for one node
 * — everything Fn must structurally satisfy (full input/output edge
 * shapes, description, examples, closure, and the Failed<In> shape it may
 * always return instead of output), and nothing else: no topology, no
 * sibling nodes, no design rationale for why the ontology is shaped this
 * way (docs/superpowers/specs/2026-09-10-sealed-contract-and-implementation-metadata.md).
 */

import { serializeField, type NetlistField } from "./netlist.js";
import type { AnyEdgeDef, NodeDecl } from "./types.js";

export interface ContractEdgeShape {
  name: string;
  label: string;
  description: string;
  index?: string;
  fields: Record<string, NetlistField>;
}

export type ContractInputSpec = ContractEdgeShape | { allOf: ContractEdgeShape[] };

export type ContractOutputSpec =
  | ContractEdgeShape
  | { oneOf: ContractEdgeShape[] }
  | { allOf: ContractEdgeShape[] }
  | { many: ContractEdgeShape };

export interface SealedContract {
  node: string;
  input: ContractInputSpec;
  output: ContractOutputSpec;
  description?: string;
  examples?: NodeDecl["examples"];
  closure?: NodeDecl["closure"];
  /** Fn may always return this instead of `output` — Failed<In>'s real shape, docs/design.md §3. */
  failure: { input: ContractInputSpec; reason?: string };
}

function edgeShape(edge: AnyEdgeDef): ContractEdgeShape {
  const fields: Record<string, NetlistField> = {};
  for (const [key, value] of Object.entries(edge.fields)) {
    fields[key] = serializeField(value);
  }
  return {
    name: edge.name,
    label: edge.label,
    description: edge.description,
    ...(edge.index !== undefined && { index: edge.index }),
    fields,
  };
}

function contractInputSpec(input: NodeDecl["input"]): ContractInputSpec {
  if (input.kind === "single") return edgeShape(input.edge);
  return { allOf: input.edges.map(edgeShape) };
}

function contractOutputSpec(output: NodeDecl["output"]): ContractOutputSpec {
  if (output.kind === "single") return edgeShape(output.edge);
  if (output.kind === "many") return { many: edgeShape(output.edge) };
  if (output.kind === "oneOf") return { oneOf: output.edges.map(edgeShape) };
  return { allOf: output.edges.map(edgeShape) };
}

export function exportContract(node: NodeDecl): SealedContract {
  return {
    node: node.name,
    input: contractInputSpec(node.input),
    output: contractOutputSpec(node.output),
    ...(node.description !== undefined && { description: node.description }),
    ...(node.examples !== undefined && { examples: node.examples }),
    ...(node.closure !== undefined && { closure: node.closure }),
    failure: { input: contractInputSpec(node.input) },
  };
}
```

- [ ] **Step 5: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS, including every test added in Step 2.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add spikes/ts-prototype/src/netlist.ts spikes/ts-prototype/src/contract.ts spikes/ts-prototype/src/contract.test.ts
git commit -m "Add exportContract: the sealed contract an isolated agent would receive"
```

---

## Task 2: `metadata.ts` — implementation metadata, and `index.ts` exports

**Files:**
- Create: `spikes/ts-prototype/src/metadata.ts`
- Test: `spikes/ts-prototype/src/metadata.test.ts`
- Modify: `spikes/ts-prototype/src/index.ts` (export both this task's and Task 1's new public symbols)

**Interfaces:**
- Consumes: the `typescript` package's compiler API directly (`ts.createSourceFile`, `ts.SyntaxKind`, `ts.isBinaryExpression`, `ts.Node.forEachChild`). Consumes `ContractEdgeShape`/`ContractInputSpec`/`ContractOutputSpec`/`SealedContract`/`exportContract` (Task 1, `contract.ts`) for the `index.ts` export step.
- Produces: `ImplementationMetadata`, `computeImplementationMetadata(source: string): ImplementationMetadata` — nothing later in this plan consumes them; this is the plan's last task.

- [ ] **Step 1: Write the failing tests for `computeImplementationMetadata`**

Create `spikes/ts-prototype/src/metadata.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { computeImplementationMetadata } from "./metadata.js";

describe("computeImplementationMetadata", () => {
  it("reports complexity 1 for a straight-line function with no branches", () => {
    const source = `export default function birthday(payload) {
  return { age: payload.age + 1 };
}
`;
    expect(computeImplementationMetadata(source).complexity).toBe(1);
  });

  it("counts an if statement as one decision point", () => {
    const source = `export default function classify(payload) {
  if (payload.age === 42) {
    return { edge: "Pass", payload: {} };
  }
  return { edge: "Fail", payload: {} };
}
`;
    expect(computeImplementationMetadata(source).complexity).toBe(2);
  });

  it("counts each && / || as its own decision point", () => {
    const source = `export default function eligible(payload) {
  return payload.age >= 18 && payload.age <= 65 || payload.override;
}
`;
    expect(computeImplementationMetadata(source).complexity).toBe(3);
  });

  it("counts a for loop, a switch's non-default case, and a catch block", () => {
    const source = `export default function process(payload) {
  for (const item of payload.items) {
    switch (item.kind) {
      case "a":
        break;
      default:
        break;
    }
  }
  try {
    risky();
  } catch (e) {
    return { edge: "Fail", payload: {} };
  }
  return { edge: "Pass", payload: {} };
}
`;
    expect(computeImplementationMetadata(source).complexity).toBe(4);
  });

  it("reports the actual line count", () => {
    const source = `export default function f(payload) {
  return payload;
}
`;
    expect(computeImplementationMetadata(source).lines).toBe(3);
  });
});
```

- [ ] **Step 2: Run the suite, confirm the new tests fail for the right reason**

Run: `cd spikes/ts-prototype && npx vitest run metadata.test.ts`
Expected: fails to collect/typecheck — `./metadata.js` doesn't exist yet.

- [ ] **Step 3: Implement `metadata.ts`**

```ts
// spikes/ts-prototype/src/metadata.ts
/**
 * Analytics about an accepted implementation's source — a side-channel,
 * never read by the elaborator, hash.ts, or any acceptance logic, and
 * never fed back to change behavior or as something an agent should
 * optimize against (docs/superpowers/specs/2026-09-10-sealed-contract-and-implementation-metadata.md).
 */

import * as ts from "typescript";

export interface ImplementationMetadata {
  lines: number;
  complexity: number;
}

/**
 * McCabe cyclomatic complexity's standard decision-point set. CaseClause
 * (not DefaultClause) means a switch's default branch is correctly
 * excluded without extra logic — the compiler API already distinguishes
 * them as different node kinds.
 */
const DECISION_KINDS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CaseClause,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
]);

function countDecisionPoints(node: ts.Node): number {
  let count = DECISION_KINDS.has(node.kind) ? 1 : 0;
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) count += 1;
  }
  node.forEachChild((child) => {
    count += countDecisionPoints(child);
  });
  return count;
}

export function computeImplementationMetadata(source: string): ImplementationMetadata {
  const lines = source.trim().split("\n").length;
  const sourceFile = ts.createSourceFile("implementation.ts", source, ts.ScriptTarget.Latest, true);
  const complexity = 1 + countDecisionPoints(sourceFile);
  return { lines, complexity };
}
```

- [ ] **Step 4: Run the suite, confirm everything passes**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS, including every test added in Step 1 and Task 1's `contract.test.ts`.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 5: Export both modules' public symbols from `index.ts`**

```ts
// index.ts, before (end of file):
export { serializeNetlist } from "./netlist.js";
export type {
  Netlist,
  NetlistEdge,
  NetlistField,
  NetlistInputSpec,
  NetlistNode,
  NetlistOutputSpec,
  NetlistTopology,
} from "./netlist.js";

// after:
export { serializeNetlist } from "./netlist.js";
export type {
  Netlist,
  NetlistEdge,
  NetlistField,
  NetlistInputSpec,
  NetlistNode,
  NetlistOutputSpec,
  NetlistTopology,
} from "./netlist.js";

export { exportContract } from "./contract.js";
export type { ContractEdgeShape, ContractInputSpec, ContractOutputSpec, SealedContract } from "./contract.js";

export { computeImplementationMetadata } from "./metadata.js";
export type { ImplementationMetadata } from "./metadata.js";
```

- [ ] **Step 6: Run the full suite and typecheck one final time**

Run: `cd spikes/ts-prototype && npx vitest run`
Expected: all tests PASS.

Run: `cd spikes/ts-prototype && npm run typecheck`
Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add spikes/ts-prototype/src/metadata.ts spikes/ts-prototype/src/metadata.test.ts spikes/ts-prototype/src/index.ts
git commit -m "Add computeImplementationMetadata, export both new modules from index.ts"
```
