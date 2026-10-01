/**
 * Pieces 2 and 3 of docs/superpowers/specs/2026-10-01-the-deterministic-scaffold.md:
 * emit a standalone workspace an implementer fills in, instead of a JSON
 * document they have to interpret.
 *
 * The emitter is pure — `scaffoldFiles` returns path → contents and touches no
 * disk — so the tests exercise the same strings the CLI writes.
 *
 * Three things the scaffold does that the sealed contract cannot:
 *
 * 1. **It separates whose fault a failure is.** Each example asserts the input
 *    against the input schema *before* calling `fn`, then the result against the
 *    output schema, then the value. An input-schema failure is a declaration
 *    bug; an output-schema failure is a wrong shape; a value mismatch is wrong
 *    logic. The pressure test's four failures were all misattributed to the
 *    implementation, which had no way to tell them apart
 *    (2026-10-01-what-an-isolated-agent-found.md).
 * 2. **It makes a property readable.** A property emitted as source shows what it
 *    actually checks. `parcelCentroid`'s is named "the centroid lies within the
 *    boundary's bounding box" and compares PINs; as generated code that is
 *    obvious, and in nested JSON it was not.
 * 3. **It gives a baseline to diff against.** Anything in a submission that is
 *    not in the scaffold is the implementer's own contribution, by construction.
 *
 * It compares with `node:assert`'s `deepStrictEqual`, which is the gate's own
 * `isDeepStrictEqual` — deliberately not vitest's `toEqual`, which is looser and
 * would let the scaffold pass something the gate rejects.
 */

import { emitEdgeModules, emitNodeSchemaModule, emitZodModule } from "./emit-zod.js";
import { generateInputCases } from "./generate.js";
import type { AnyEdgeDef, FieldDef, NodeDecl, PropertyDecl, PropertyExpr } from "./types.js";

/** A JS literal for emitted source. */
function lit(value: unknown): string {
  return JSON.stringify(value) ?? "undefined";
}

/**
 * Renders a property expression as readable TypeScript.
 *
 * The point is legibility rather than cleverness: an implementer should be able
 * to read what a property checks without learning the expression language,
 * whose path-resolution rules live in `property.ts`'s header comment where a
 * sealed contract never takes them.
 */
function renderExpr(expr: PropertyExpr): string {
  if (typeof expr !== "object" || expr === null) {
    throw new Error(`scaffold: unrecognized property expression: ${lit(expr)}`);
  }
  if ("lit" in expr) return lit(expr.lit);
  if ("get" in expr) return `read(${lit(expr.get)})`;

  const bin = (op: string, pair: readonly [PropertyExpr, PropertyExpr]): string =>
    `(${renderExpr(pair[0])} ${op} ${renderExpr(pair[1])})`;

  if ("eq" in expr) return `same(${renderExpr(expr.eq[0])}, ${renderExpr(expr.eq[1])})`;
  if ("ne" in expr) return `!same(${renderExpr(expr.ne[0])}, ${renderExpr(expr.ne[1])})`;
  if ("lt" in expr) return bin("<", expr.lt);
  if ("lte" in expr) return bin("<=", expr.lte);
  if ("gt" in expr) return bin(">", expr.gt);
  if ("gte" in expr) return bin(">=", expr.gte);
  if ("add" in expr) return bin("+", expr.add);
  if ("sub" in expr) return bin("-", expr.sub);
  if ("and" in expr) return `(${expr.and.map(renderExpr).join(" && ")})`;
  if ("or" in expr) return `(${expr.or.map(renderExpr).join(" || ")})`;
  if ("not" in expr) return `!(${renderExpr(expr.not)})`;
  // `implies` is material implication, and spelling it out keeps the emitted
  // source honest about the vacuous case: a false antecedent passes.
  if ("implies" in expr) return `(!(${renderExpr(expr.implies[0])}) || ${renderExpr(expr.implies[1])})`;

  throw new Error(`scaffold: unrecognized property expression: ${lit(expr)}`);
}

function propertyBlock(properties: PropertyDecl[]): string {
  if (properties.length === 0) {
    return `/**
 * This node declares no properties, so nothing here constrains it beyond the
 * examples above and the output schema. That is worth knowing: examples pin
 * down the cases somebody thought of, and a property is what holds for inputs
 * nobody thought of.
 */
export const properties: PropertyCheck[] = [];`;
  }

  const entries = properties.map((p) => {
    const doc = p.description === undefined ? "" : `    // ${p.description.replace(/\s+/g, " ").trim()}\n`;
    return `  {
    name: ${lit(p.name)},
${doc}    holds: (input, output) => {
      const read = reader(input, output);
      return ${renderExpr(p.expr)};
    },
  },`;
  });

  return `/**
 * The declared properties, rendered as source so you can see what each one
 * actually checks. **Read the body, not the name** — a property's name is
 * unchecked prose, and at least one in this repository is named for a check it
 * does not perform.
 *
 * These run against the declared examples here. The acceptance gate also runs
 * them against generated inputs, which is where a property earns its keep.
 */
export const properties: PropertyCheck[] = [
${entries.join("\n")}
];`;
}

const CHECK_PRELUDE = `import { isDeepStrictEqual } from "node:util";

export interface PropertyCheck {
  name: string;
  holds: (input: unknown, output: unknown) => boolean;
}

export interface Failure {
  example: number;
  stage: "input-schema" | "output-schema" | "value" | "threw" | "property";
  detail: string;
}

/** The gate's own comparison (node:util's isDeepStrictEqual), not a looser one. */
const same = (a: unknown, b: unknown): boolean => isDeepStrictEqual(a, b);

/**
 * Resolves a dotted path against { input, output }, the way property.ts does:
 * \`input.age\` for a single input, \`input.Person.age\` for an allOf bag, and
 * \`output.edge\` / \`output.payload.x\` for a tagged oneOf result. A path that
 * runs off the end throws rather than yielding undefined — a path that cannot
 * resolve is a broken property, not a failing one.
 */
const reader = (input: unknown, output: unknown) => (path: string): unknown => {
  const segments = path.split(".");
  const root = segments[0];
  if (root !== "input" && root !== "output") {
    throw new Error(\`path "\${path}" must start with "input" or "output".\`);
  }
  let current: unknown = root === "input" ? input : output;
  for (const segment of segments.slice(1)) {
    if (typeof current !== "object" || current === null) {
      throw new Error(\`path "\${path}" does not resolve: "\${segment}" has nothing to read from.\`);
    }
    if (!Object.hasOwn(current as Record<string, unknown>, segment)) {
      throw new Error(\`path "\${path}" does not resolve: no "\${segment}" here.\`);
    }
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
};
`;

function checkModule(node: NodeDecl): string {
  const examples = (node.examples ?? []).map(
    (ex) => `  { given: ${lit(ex.given)}, expect: ${lit(ex.expect)} },`,
  );

  return `// GENERATED by \`weir scaffold ${node.name}\` — do not edit.
// Edit ${node.name}.ts. Re-run the scaffold to pick up declaration changes.
${CHECK_PRELUDE}
import fn from "./${node.name}.js";
import { ${node.name}Input, ${node.name}Output } from "./schema.js";

/** The node's declared examples, in runtime form. */
export const examples: { given: unknown; expect: unknown }[] = [
${examples.join("\n")}
];

${propertyBlock((node.properties ?? []) as PropertyDecl[])}

/**
 * Runs every example and every property, and reports which **artifact** is wrong
 * rather than only that something is.
 *
 * - \`input-schema\`  the example's own \`given\` does not satisfy the input
 *                   schema. A declaration bug; your \`fn\` never ran.
 * - \`output-schema\` your result is the wrong shape.
 * - \`value\`         right shape, wrong value.
 * - \`threw\`         your \`fn\` declined. Correct for input it cannot handle,
 *                   and a bug on a declared example.
 * - \`property\`      a declared invariant did not hold.
 */
export function check(): Failure[] {
  const failures: Failure[] = [];

  for (const [i, ex] of examples.entries()) {
    const n = i + 1;

    const parsedInput = ${node.name}Input.safeParse(ex.given);
    if (!parsedInput.success) {
      failures.push({ example: n, stage: "input-schema", detail: parsedInput.error.message });
      continue;
    }

    let actual: unknown;
    try {
      actual = fn(ex.given as never);
    } catch (cause) {
      failures.push({ example: n, stage: "threw", detail: (cause as Error).message });
      continue;
    }

    const parsedOutput = ${node.name}Output.safeParse(actual);
    if (!parsedOutput.success) {
      failures.push({ example: n, stage: "output-schema", detail: parsedOutput.error.message });
      continue;
    }

    if (!same(actual, ex.expect)) {
      failures.push({
        example: n,
        stage: "value",
        detail: \`expected \${JSON.stringify(ex.expect)}, got \${JSON.stringify(actual)}\`,
      });
      continue;
    }

    for (const property of properties) {
      let held: boolean;
      try {
        held = property.holds(ex.given, actual);
      } catch (cause) {
        // A path that cannot resolve is a broken property — the contract's
        // defect, not yours. Reported separately so it is not read as a
        // violation you caused.
        failures.push({
          example: n,
          stage: "property",
          detail: \`"\${property.name}" is broken: \${(cause as Error).message}\`,
        });
        continue;
      }
      if (!held) {
        failures.push({ example: n, stage: "property", detail: \`"\${property.name}" did not hold\` });
      }
    }
  }

  return failures;
}
`;
}

function stubModule(node: NodeDecl): string {
  const declines =
    node.input.kind === "allOf"
      ? `the bag it was given`
      : `the payload it was given`;

  return `import type { ${node.name}Input, ${node.name}Output } from "./schema.js";

/**
 * ${node.name}
 *
 * The membrane asserts the input against the schema before this runs, so \`p\` is
 * already structurally valid — the type is backed by a runtime assertion rather
 * than being a promise.
 *
 * Decline by throwing. The membrane turns a throw into a \`Failed\` record
 * carrying ${declines} and the reason, which is the right answer for input this
 * cannot handle — but note that the acceptance gate reports a candidate that
 * declines *every* generated input as \`vacuous\`, which is a failing verdict.
 * If you believe every generated input is undeclinable-but-unusable, say so
 * rather than inventing a plausible value to get past the gate.
 */
export default function ${node.name}(p: ${node.name}Input): ${node.name}Output {
  throw new Error("${node.name}: not implemented");
}
`;
}

function readme(node: NodeDecl): string {
  const props = (node.properties ?? []).length;
  const exs = (node.examples ?? []).length;
  return `# ${node.name}

A scaffold generated from weir declarations. **Edit \`${node.name}.ts\` and nothing
else** — every other file is mechanical output of the declarations, and re-running
the scaffold overwrites it.

\`\`\`
npm install
npm test
\`\`\`

| file | what it is |
|---|---|
| \`${node.name}.ts\` | **yours.** The stub throws; make it work. |
| \`schema.ts\` | the input and output edges as zod. Validations included. |
| \`check.ts\` | the ${exs} declared example(s) and ${props} declared propert${props === 1 ? "y" : "ies"}, as source. |
| \`${node.name}.test.ts\` | runs \`check()\`. |
| \`vitest.config.ts\` | so this directory tests itself, wherever it sits. |

## Reading a failure

\`check()\` reports which artifact is wrong, not just that something is:

- **input-schema** — the example's own \`given\` does not satisfy the input schema.
  A declaration bug; your code never ran.
- **output-schema** — your result is the wrong shape.
- **value** — right shape, wrong value.
- **threw** — your function declined.
- **property** — a declared invariant did not hold, or the property itself is
  broken (an unresolvable path is the contract's defect, not yours).

## Two things worth knowing

**Read a property's body, not its name.** A property's name is unchecked prose.
\`check.ts\` renders each expression as source so you can see what it actually
checks.

**Declining is sometimes correct and still fails the gate.** If a field arrives as
an opaque string the generator fills with noise, the only correct response is to
throw — and the gate reports that as \`vacuous\`. Say so rather than returning a
plausible value you made up.
`;
}

const PACKAGE_JSON = (name: string): string =>
  `${JSON.stringify(
    {
      name: `weir-scaffold-${name.toLowerCase()}`,
      private: true,
      type: "module",
      scripts: { test: "vitest run", "test:watch": "vitest" },
      dependencies: { zod: "^4.6.5" },
      devDependencies: { typescript: "^5.7.2", vitest: "^2.1.0" },
      engines: { node: ">=24" },
    },
    null,
    2,
  )}\n`;

/**
 * The scaffold needs its own vitest config or it inherits whatever config vitest
 * finds by walking up — which, when the scaffold is written inside another
 * project, silently resolves to that project's `include` and finds no tests at
 * all. Found by running a scaffolded workspace rather than by reading it.
 */
const VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["*.test.ts"], root: "." },
});
`;

const TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
    },
    include: ["*.ts"],
  },
  null,
  2,
)}\n`;

/**
 * path → contents, relative to the output directory. Pure: the CLI writes
 * these, and the tests exercise the identical strings.
 */
export function scaffoldFiles(node: NodeDecl): Record<string, string> {
  return {
    "schema.ts": emitZodModule(node),
    [`${node.name}.ts`]: stubModule(node),
    "check.ts": checkModule(node),
    [`${node.name}.test.ts`]: `import { describe, expect, it } from "vitest";
import { check } from "./check.js";

describe("${node.name}", () => {
  it("satisfies every declared example and property", () => {
    // Printed in full on failure: each entry names the artifact at fault.
    expect(check()).toEqual([]);
  });
});
`,
    "package.json": PACKAGE_JSON(node.name),
    "vitest.config.ts": VITEST_CONFIG,
    "tsconfig.json": TSCONFIG,
    "README.md": readme(node),
  };
}


/* ------------------------------------------------------------------------- *
 * Whole-program scaffold
 * ------------------------------------------------------------------------- */

/**
 * The gate's own defaults (fuzz.ts). The report below must quote these or it
 * describes inputs nobody will be judged against.
 */
const GATE_SEED = 42;
const GATE_COUNT = 100;

/** A utf8 bound this generous means the generator fills it with bulk random text. */
const BULK_STRING_THRESHOLD = 10_000;

function scalarFieldsOf(edge: AnyEdgeDef): [string, FieldDef][] {
  return Object.entries(edge.fields).filter(
    ([, f]) => !("many" in f) && !("fields" in f) && !("literal" in f),
  ) as [string, FieldDef][];
}

function inputEdgesOf(node: NodeDecl): AnyEdgeDef[] {
  return node.input.kind === "allOf" ? node.input.edges : [node.input.edge];
}

/**
 * What `weir accept` will actually attack this node with.
 *
 * Shipped as a **report** rather than as embedded data, and that is not a
 * shortcut: at the gate's real settings (seed 42, 100 cases) blue-ribbon's
 * `parcelCentroid` inputs come to **108 MB**, because `boundaryJson` is declared
 * `maxLength: 2000000` and the generator samples length uniformly — median
 * 1,157,240 characters, max 2,000,000. Embedding that is not an option and
 * truncating it would misrepresent it.
 *
 * So the report states the shape, flags the fields that defeat a parser, and
 * shows a few real values from the head of the same deterministic sequence the
 * gate uses.
 */
function generatedInputReport(node: NodeDecl): string {
  const SAMPLE = 4;
  let samples: unknown[] = [];
  try {
    samples = generateInputCases(node.input, GATE_SEED, SAMPLE);
  } catch {
    samples = [];
  }

  const trunc = (v: unknown): string => {
    const text = JSON.stringify(v) ?? "undefined";
    return text.length <= 90 ? text : `${text.slice(0, 90)}… (${text.length} chars)`;
  };

  const bulk: string[] = [];
  for (const edge of inputEdgesOf(node)) {
    for (const [key, field] of scalarFieldsOf(edge)) {
      if (field.type !== "utf8") continue;
      const max = (field.validations as { maxLength?: number } | undefined)?.maxLength;
      if (max !== undefined && max >= BULK_STRING_THRESHOLD) {
        bulk.push(`\`${edge.name}.${key}\` (utf8, maxLength ${max.toLocaleString()})`);
      }
    }
  }

  const lines = [
    `# What the acceptance gate will generate`,
    ``,
    `\`weir accept\` runs your \`fn\` against **${GATE_COUNT} generated inputs** at seed`,
    `${GATE_SEED}, on top of the declared examples. They are not shipped here as data —`,
    `see below — but they are deterministic, so the samples are the real head of the`,
    `real sequence.`,
    ``,
  ];

  if (bulk.length > 0) {
    lines.push(
      `## Read this first`,
      ``,
      `${bulk.length === 1 ? "This field is" : "These fields are"} declared as a long \`utf8\` string:`,
      ``,
      ...bulk.map((b) => `- ${b}`),
      ``,
      `The generator fills ${bulk.length === 1 ? "it" : "them"} with **random text**, sampling the length`,
      `uniformly up to the declared maximum. Nothing makes the content well-formed, so if`,
      `your implementation parses ${bulk.length === 1 ? "that field" : "those fields"}, **every generated case will throw** and the`,
      `gate will report:`,
      ``,
      "```",
      `✗ ${node.name} was not accepted`,
      `  vacuous   no generated case produced a real output, so every property passed on nothing`,
      "```",
      ``,
      `That verdict is about the declaration, not about your code. Declining input you`,
      `cannot parse is correct. **Do not invent a plausible value to get past it** — say so`,
      `instead. See docs/open-questions/the-gate-rewards-fabrication.md.`,
      ``,
    );
  }

  lines.push(`## The first ${samples.length} inputs, verbatim`, ``, "```json");
  for (const [i, sample] of samples.entries()) {
    lines.push(`// case ${i + 1}`);
    if (sample !== null && typeof sample === "object" && !Array.isArray(sample)) {
      for (const [key, value] of Object.entries(sample as Record<string, unknown>)) {
        lines.push(`${key}: ${trunc(value)}`);
      }
    } else {
      lines.push(trunc(sample));
    }
    lines.push(``);
  }
  lines.push("```", ``);

  lines.push(
    `Long values are truncated **for this report only** — the gate passes them in full.`,
    `Regenerate with \`weir scaffold\`; nothing here is hand-maintained.`,
    ``,
  );

  return lines.join("\n");
}

const PROGRAM_PACKAGE_JSON = `${JSON.stringify(
  {
    name: "weir-scaffold",
    private: true,
    type: "module",
    scripts: { test: "vitest run", "test:watch": "vitest" },
    dependencies: { zod: "^4.6.5" },
    devDependencies: { typescript: "^5.7.2", vitest: "^2.1.0" },
    engines: { node: ">=24" },
  },
  null,
  2,
)}\n`;

const PROGRAM_VITEST_CONFIG = `import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["nodes/**/*.test.ts"], root: "." },
});
`;

const PROGRAM_TSCONFIG = `${JSON.stringify(
  {
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      verbatimModuleSyntax: true,
    },
    include: ["schemas/**/*.ts", "nodes/**/*.ts"],
  },
  null,
  2,
)}\n`;

function programReadme(nodes: NodeDecl[], edgeCount: number): string {
  const rows = nodes
    .map((n) => `| \`nodes/${n.name}/${n.name}.ts\` | ${(n.examples ?? []).length} example(s), ${(n.properties ?? []).length} propert${(n.properties ?? []).length === 1 ? "y" : "ies"} |`)
    .join("\n");

  return `# Scaffold

Generated from weir declarations. One install, one test run, ${nodes.length} node(s) to
implement.

\`\`\`
npm install
npm test
\`\`\`

## Layout

\`\`\`
schemas/            ${edgeCount} edge schema(s) as zod, ONE module per edge
nodes/<node>/
  <node>.ts         YOURS. The stub throws; make it work.
  schema.ts         this node's input/output, importing from schemas/
  check.ts          the declared examples and properties, as source
  generated-inputs.md   what the acceptance gate will attack it with
  <node>.test.ts    runs check()
\`\`\`

**Edit only \`nodes/<node>/<node>.ts\`.** Everything else is mechanical output and
re-running the scaffold overwrites it.

\`schemas/\` holds one module per edge rather than a copy per node on purpose. An
edge is weir's unit of shared vocabulary — the complete description of what crosses
a wire — and three nodes touching \`NormalizedParcel\` should see one schema, not
three that can drift.

## What to implement

| file | has |
|---|---|
${rows}

## Reading a failure

\`check()\` reports which artifact is wrong, not just that something is:

- **input-schema** — the example's own \`given\` does not satisfy the input schema.
  A declaration bug; your code never ran.
- **output-schema** — your result is the wrong shape, including an out-of-range
  value, since the range is in the schema rather than in a type.
- **value** — right shape, wrong value.
- **threw** — your function declined.
- **property** — a declared invariant did not hold, or the property itself is
  broken (an unresolvable path is the contract's defect, not yours).

## Two things worth knowing

**Read a property's body, not its name.** A property's name is unchecked prose.
\`check.ts\` renders each expression as source so you can see what it actually
checks — and in this repository at least one property has been named for a check it
did not perform.

**Declining is sometimes correct and still fails the gate.** Read each node's
\`generated-inputs.md\`: where a field is an opaque string, the generator fills it
with random text and the only correct response is to throw, which the gate reports
as \`vacuous\`. Say so rather than returning a value you made up.
`;
}

/**
 * The whole program as one workspace: shared `schemas/`, one directory per node.
 *
 * Replaces scaffolding node-by-node for the multi-node case, because that emitted
 * `NormalizedParcel` three times, byte-identical, once per node that touches it.
 * `scaffoldFiles` is kept for the single-node case, where a self-contained bundle
 * is the point rather than a defect.
 */
export function scaffoldProgramFiles(nodes: NodeDecl[]): Record<string, string> {
  const edges: AnyEdgeDef[] = [];
  for (const node of nodes) {
    for (const edge of inputEdgesOf(node)) edges.push(edge);
    const output = node.output;
    if (output.kind === "oneOf" || output.kind === "allOf") edges.push(...output.edges);
    else edges.push(output.edge);
  }

  const files: Record<string, string> = {};

  const schemaModules = emitEdgeModules(edges);
  for (const [name, source] of Object.entries(schemaModules)) files[`schemas/${name}`] = source;
  const edgeCount = Object.keys(schemaModules).filter((n) => !n.startsWith("_")).length;

  for (const node of nodes) {
    const dir = `nodes/${node.name}`;
    const single = scaffoldFiles(node);
    files[`${dir}/schema.ts`] = emitNodeSchemaModule(node, "../../schemas");
    files[`${dir}/${node.name}.ts`] = single[`${node.name}.ts`]!;
    files[`${dir}/check.ts`] = single["check.ts"]!;
    files[`${dir}/${node.name}.test.ts`] = single[`${node.name}.test.ts`]!;
    files[`${dir}/generated-inputs.md`] = generatedInputReport(node);
  }

  files["package.json"] = PROGRAM_PACKAGE_JSON;
  files["tsconfig.json"] = PROGRAM_TSCONFIG;
  files["vitest.config.ts"] = PROGRAM_VITEST_CONFIG;
  files["README.md"] = programReadme(nodes, edgeCount);

  return files;
}
