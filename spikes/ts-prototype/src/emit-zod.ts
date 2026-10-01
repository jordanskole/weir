/**
 * Emits a zod module for a node's declared input and output edges — piece 1 of
 * docs/superpowers/specs/2026-10-01-the-deterministic-scaffold.md.
 *
 * Why this exists: an agent handed four sealed contracts wrote four functions
 * taking `p: any`, because a JSON document gives it no name to refer to and
 * hand-writing a type literal would drift from the contract it is drafting
 * against. A type would not fix it either — a type throws the validations away,
 * so `lng` declaring `min: -180, max: 180` becomes `lng: number`. A schema keeps
 * them, and `z.infer` yields the type as a derived artifact that cannot drift.
 *
 * The output is **source text**, not a live schema, and deliberately so: the
 * scaffold hands an implementer a file. A parallel in-memory builder beside this
 * renderer would be two implementations of one mapping — the drift class the
 * scaffold exists to close — so `emit-zod.test.ts` imports the emitted text and
 * tests *that*, rather than a second code path.
 *
 * It does not feed the membrane. `assertPayload` stays the enforcer, and a test
 * asserts the two accept, reject, and strip identically across every edge in
 * every example app. Replacing `assertPayload` is the right destination and is
 * deferred: it is a load-bearing refactor, it puts zod in the runtime
 * dependencies, and `assertPayload`'s weir-voiced reasons feed the `Failed`
 * envelope and the trace, so those strings would change observably.
 */

import { INT_BOUNDS, isIntegerType } from "./types.js";
import type { AnyEdgeDef, FieldDef, ManyEdgeDef, NodeDecl } from "./types.js";

/** A JS string literal for emitted source. */
function lit(value: string): string {
  return JSON.stringify(value);
}

/**
 * `datetime` emits `z.string()`, not `z.iso.datetime()`.
 *
 * types.ts calls `datetime` "an ISO-8601 string", but `membrane.ts`'s
 * `typeofFor` maps it to `"string"` and nothing checks the format — so the
 * declared intent and the enforced rule differ. Emitting the stricter form
 * would make this module reject payloads the membrane accepts, which is exactly
 * the divergence the agreement test exists to prevent, so it matches the
 * enforcer and the gap is recorded in the spec instead. No declaration in the
 * repository uses `datetime`, so nothing is exercising the gap today.
 */
function scalarBase(field: FieldDef): string {
  if (field.enumValues !== undefined && field.enumValues.length > 0) {
    return `z.enum([${field.enumValues.map(lit).join(", ")}])`;
  }
  if (field.type === "bool") return "z.boolean()";
  if (field.type === "utf8" || field.type === "datetime") return "z.string()";

  if (!isIntegerType(field.type)) return "z.number()";
  const [min, max] = INT_BOUNDS[field.type];
  return `z.number().int().min(${min}).max(${max})`;
}

/**
 * `enumValues` suppresses `validations`: the membrane checks the enum
 * membership and a `minLength` alongside it would be checking the length of a
 * value already pinned to a closed set.
 */
function scalarExpr(field: FieldDef): string {
  let expr = scalarBase(field);

  const validations = field.validations as
    | { min?: number; max?: number; minLength?: number; maxLength?: number; pattern?: string }
    | undefined;

  if (validations !== undefined && field.enumValues === undefined) {
    if (validations.min !== undefined) expr += `.min(${validations.min})`;
    if (validations.max !== undefined) expr += `.max(${validations.max})`;
    if (validations.minLength !== undefined) expr += `.min(${validations.minLength})`;
    if (validations.maxLength !== undefined) expr += `.max(${validations.maxLength})`;
    if (validations.pattern !== undefined) expr += `.regex(new RegExp(${lit(validations.pattern)}))`;
  }

  // `bool` has no `nullable` at all — a nullable boolean is a tri-state in
  // disguise, which types.ts rejects at the declaration level.
  if (field.type !== "bool" && (field as { nullable?: boolean }).nullable === true) {
    expr += ".nullable()";
  }

  if (field.description !== undefined && field.description !== "") {
    expr += `.describe(${lit(field.description)})`;
  }

  return expr;
}

type AnyField = FieldDef | { literal: boolean } | AnyEdgeDef | ManyEdgeDef;

/** Emitted once, and only when a `many` field or output needs it. */
const KEYED_BY_HELPER = `/**
 * A collection is keyed by each entry's own index field, and the key must agree
 * with it — the membrane's rule for both \`many\` fields and \`many\` outputs.
 */
const keyedBy = <T extends z.ZodType>(index: string, entry: T) =>
  z.record(z.string(), entry).superRefine((collection, ctx) => {
    for (const [key, value] of Object.entries(collection)) {
      const own = String((value as Record<string, unknown>)[index]);
      if (own !== key) {
        ctx.addIssue({
          code: "custom",
          message: \`["\${key}"]: keyed by "\${key}" but its own "\${index}" is "\${own}"\`,
        });
      }
    }
  });`;

function fieldExpr(field: AnyField, usesKeyedBy: { value: boolean }): string {
  if ("many" in field) {
    const entry = field.many;
    if (entry.index === undefined) {
      throw new Error(
        `emit-zod: many requires "${entry.name}" to declare an index — a collection needs a real key.`,
      );
    }
    usesKeyedBy.value = true;
    return `keyedBy(${lit(entry.index)}, ${entry.name})`;
  }
  if ("literal" in field) return `z.literal(${String(field.literal)})`;
  if ("fields" in field) return field.name;
  return scalarExpr(field as FieldDef);
}

/**
 * Every distinct edge reachable from `roots`, in dependency order, so a nested
 * edge is declared before the edge that references it. Collected by name: an
 * edge reached twice is emitted once, and two different shapes under one name
 * is a declaration bug rather than something to paper over.
 */
function collectEdges(roots: AnyEdgeDef[]): AnyEdgeDef[] {
  const ordered: AnyEdgeDef[] = [];
  const byName = new Map<string, AnyEdgeDef>();

  const visit = (edge: AnyEdgeDef): void => {
    const seen = byName.get(edge.name);
    if (seen !== undefined) {
      if (seen !== edge) {
        throw new Error(
          `emit-zod: two different edges are both named "${edge.name}" — one name cannot emit two schemas.`,
        );
      }
      return;
    }
    byName.set(edge.name, edge);

    for (const field of Object.values(edge.fields) as AnyField[]) {
      if ("many" in field) visit(field.many);
      else if ("fields" in field) visit(field);
    }
    // Pushed after its children, so the emitted order compiles top to bottom.
    ordered.push(edge);
  };

  for (const root of roots) visit(root);
  return ordered;
}

function edgeConst(edge: AnyEdgeDef, usesKeyedBy: { value: boolean }): string {
  const fields = Object.entries(edge.fields).map(
    ([key, field]) => `  ${JSON.stringify(key)}: ${fieldExpr(field as AnyField, usesKeyedBy)},`,
  );
  const doc = edge.description === undefined || edge.description === "" ? "" : `/** ${edge.label} */\n`;
  return `${doc}export const ${edge.name} = z.object({\n${fields.join("\n")}\n});\nexport type ${edge.name} = z.infer<typeof ${edge.name}>;`;
}

/** The input edges a node reads, whatever its input kind. */
function inputEdges(node: NodeDecl): AnyEdgeDef[] {
  const input = node.input;
  if (input.kind === "allOf") return input.edges;
  return [input.edge];
}

function outputEdges(node: NodeDecl): AnyEdgeDef[] {
  const output = node.output;
  if (output.kind === "oneOf" || output.kind === "allOf") return output.edges;
  return [output.edge];
}

function inputExpr(node: NodeDecl, usesKeyedBy: { value: boolean }): string {
  const input = node.input;
  if (input.kind === "single") return input.edge.name;
  if (input.kind === "allOf") {
    const members = input.edges.map((e) => `  ${JSON.stringify(e.name)}: ${e.name},`);
    return `z.object({\n${members.join("\n")}\n})`;
  }
  // gather — a keyed collection of the gathered edge, the shape a gather receives.
  if (input.edge.index === undefined) {
    throw new Error(`emit-zod: gather of "${input.edge.name}" needs an index.`);
  }
  usesKeyedBy.value = true;
  return `keyedBy(${lit(input.edge.index)}, ${input.edge.name})`;
}

/**
 * The output shapes, which are the ones an implementer most needs stated:
 * `oneOf` is a tagged `{ edge, payload }` and `allOf` is an *array* of them,
 * neither of which is guessable. The agent that drafted `routeCounty`
 * discovered the `oneOf` shape by probing.
 */
function outputExpr(node: NodeDecl, usesKeyedBy: { value: boolean }): string {
  const output = node.output;
  if (output.kind === "single") return output.edge.name;

  if (output.kind === "many") {
    if (output.edge.index === undefined) {
      throw new Error(`emit-zod: many output "${output.edge.name}" needs an index.`);
    }
    usesKeyedBy.value = true;
    return `keyedBy(${lit(output.edge.index)}, ${output.edge.name})`;
  }

  const branch = (e: AnyEdgeDef): string =>
    `  z.object({ edge: z.literal(${lit(e.name)}), payload: ${e.name} }),`;
  const union = `z.discriminatedUnion("edge", [\n${output.edges.map(branch).join("\n")}\n])`;

  if (output.kind === "oneOf") return union;

  // allOf — an array of tagged branches, one per edge, order-independent.
  const names = output.edges.map((e) => lit(e.name)).join(", ");
  return `z.array(${union})
  .length(${output.edges.length})
  .superRefine((branches, ctx) => {
    for (const name of [${names}]) {
      if (!branches.some((b) => b.edge === name)) {
        ctx.addIssue({ code: "custom", message: \`allOf output: missing a tagged branch for "\${name}"\` });
      }
    }
  })`;
}

/**
 * The module an implementer receives. `Fn` declines by throwing — the membrane
 * turns a throw into `Failed_<InputEdge>` carrying the reason — so the return
 * type is the output alone rather than a union with the failure envelope.
 */
export function emitZodModule(node: NodeDecl): string {
  const usesKeyedBy = { value: false };

  const edges = collectEdges([...inputEdges(node), ...outputEdges(node)]);
  const consts = edges.map((edge) => edgeConst(edge, usesKeyedBy));

  const input = inputExpr(node, usesKeyedBy);
  const output = outputExpr(node, usesKeyedBy);

  const parts = [
    `// GENERATED from the declarations by \`weir emit-zod ${node.name}\` — do not edit.`,
    `// Re-run the emitter instead; this file is mechanical output.`,
    ``,
    `import { z } from "zod";`,
    ``,
    ...(usesKeyedBy.value ? [KEYED_BY_HELPER, ``] : []),
    ...consts.flatMap((c) => [c, ``]),
    `/** What \`${node.name}\` receives, after the membrane has asserted it. */`,
    `export const ${node.name}Input = ${input};`,
    `export type ${node.name}Input = z.infer<typeof ${node.name}Input>;`,
    ``,
    `/** What \`${node.name}\` must return. Throw to decline. */`,
    `export const ${node.name}Output = ${output};`,
    `export type ${node.name}Output = z.infer<typeof ${node.name}Output>;`,
    ``,
    `export type ${node.name}Fn = (p: ${node.name}Input) => ${node.name}Output;`,
    ``,
  ];

  return parts.join("\n");
}
