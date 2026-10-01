/**
 * The emitted zod module is **source text**, so these tests import the text and
 * exercise that — never a parallel in-memory builder, which would be a second
 * implementation of the same mapping and the exact drift this emitter exists to
 * close (docs/superpowers/specs/2026-10-01-the-deterministic-scaffold.md).
 *
 * The central assertion is *agreement*: `assertPayload` stays the membrane's
 * enforcer, and the emitted schema must accept, reject, and strip identically.
 * A divergence has to fail here rather than reaching an implementer as a local
 * green that becomes a red at the gate — which is the misattribution pattern
 * the pressure test found four times over.
 */

import { describe, expect, it } from "vitest";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { elaborate } from "./elaborate.js";
import { emitZodModule } from "./emit-zod.js";
import { assertPayload } from "./membrane.js";
import { generateInputCases } from "./generate.js";
import { SCALAR_TYPES } from "./types.js";
import type { AnyEdgeDef, FieldDef, NodeDecl } from "./types.js";

const REPO = join(import.meta.dirname, "..", "..", "..");
const OUT = join(import.meta.dirname, "..", ".emit-zod-test");

/**
 * Every app with declarations, not a chosen subset — the mapping has to hold
 * across the whole corpus or the agreement claim is only about what was looked
 * at. 9 apps at the time of writing.
 */
const APPS = [
  "examples/escalation",
  "examples/flaky-source",
  "examples/manuscript-review",
  "examples/person-birthday",
  "examples/recipe",
  "examples/soc-triage",
  "examples/todo-list",
  "spikes/blue-ribbon-slice",
  "spikes/blue-ribbon-soil",
];

/** Writes the emitted module and imports it. Unique filename per node — the
 * module cache is keyed by path, so a reused name would silently return the
 * first node's schemas. */
async function importEmitted(app: string, node: NodeDecl): Promise<Record<string, any>> {
  await mkdir(OUT, { recursive: true });
  const slug = `${app.replace(/[^a-z0-9]/gi, "-")}-${node.name}`;
  const file = join(OUT, `${slug}.ts`);
  await writeFile(file, emitZodModule(node), "utf8");
  return (await import(/* @vite-ignore */ file)) as Record<string, any>;
}

/** `assertPayload` either returns the stripped payload or throws. */
function enforced(edge: AnyEdgeDef, payload: unknown): { ok: boolean; stripped?: unknown } {
  try {
    return { ok: true, stripped: assertPayload(edge, payload) };
  } catch {
    return { ok: false };
  }
}

function scalarFields(edge: AnyEdgeDef): [string, FieldDef][] {
  return Object.entries(edge.fields).filter(
    ([, f]) => !("many" in f) && !("fields" in f) && !("literal" in f),
  ) as [string, FieldDef][];
}

/** Every input edge of every node, with the emitted schema beside it. */
async function corpus(): Promise<
  { app: string; node: string; edge: AnyEdgeDef; schema: any }[]
> {
  const rows: { app: string; node: string; edge: AnyEdgeDef; schema: any }[] = [];
  for (const app of APPS) {
    const elaborated = await elaborate(join(REPO, app));
    for (const node of Object.values(elaborated.nodes) as NodeDecl[]) {
      const mod = await importEmitted(app, node);
      const edges =
        node.input.kind === "allOf" ? node.input.edges : [node.input.edge];
      for (const edge of edges) {
        if (mod[edge.name] !== undefined) {
          rows.push({ app, node: node.name, edge, schema: mod[edge.name] });
        }
      }
    }
  }
  return rows;
}

/**
 * A synthetic edge with one field per scalar type, so the mapping table is
 * covered rather than assumed — the corpus uses neither `datetime` nor four of
 * the six integer widths.
 */
async function everyScalar(): Promise<{ edge: AnyEdgeDef; schema: any; source: string }> {
  const fields: Record<string, FieldDef> = {};
  for (const type of SCALAR_TYPES) {
    fields[`f_${type}`] = {
      type,
      label: type,
      description: `a ${type}`,
      ...(type === "bool" ? {} : { nullable: false }),
    } as FieldDef;
  }
  const edge = {
    name: "EveryScalar",
    label: "Every Scalar",
    description: "One field per scalar type.",
    fields,
  } as AnyEdgeDef;
  const node = {
    name: "everyScalar",
    input: { kind: "single", edge },
    output: { kind: "single", edge },
  } as unknown as NodeDecl;
  const mod = await importEmitted("synthetic", node);
  return { edge, schema: mod.EveryScalar, source: emitZodModule(node) };
}

describe("emit-zod — the emitted schema agrees with the membrane", () => {
  /**
   * BREAK-PROOFS, and the result is the reason the other tests in this file
   * exist. **No constraint-dropping break reddens this test.** Dropping
   * `.min()`, `.max(maxLength)`, or `z.enum` leaves it green, because
   * `generateInputCases` emits well-formed payloads and a loosened schema still
   * accepts those. Each of those breaks reddens the mutation test below instead.
   *
   * So what this test actually guards is agreement on *well-formed* data —
   * type mapping, nullability handling, and the stripped result — and the real
   * constraint guard is the mutation test. Recorded plainly because the first
   * version of this comment claimed this test caught a dropped `.min()` with "14
   * disagreements across 4 apps", a number that was never measured and is wrong:
   * the break reddens a different test and this one stays green.
   *
   * BREAK-PROOF that does NOT redden, correctly: dropping `.describe(...)` — a
   * description is not validation, and the description test covers it.
   */
  it("accepts, rejects and strips identically on every generated case, for every edge in every app", async () => {
    const rows = await corpus();
    // Guard against the check silently examining nothing, this repo's most
    // frequent bug.
    expect(rows.length).toBeGreaterThan(20);

    const disagreements: string[] = [];
    let compared = 0;

    for (const { app, edge, schema } of rows) {
      const cases = generateInputCases({ kind: "single", edge } as any, 7, 12);
      for (const payload of cases) {
        const mine = enforced(edge, payload);
        const theirs = schema.safeParse(payload);
        compared += 1;

        if (mine.ok !== theirs.success) {
          disagreements.push(
            `${app} ${edge.name}: membrane ${mine.ok ? "accepted" : "rejected"}, ` +
              `schema ${theirs.success ? "accepted" : "rejected"} — ${JSON.stringify(payload).slice(0, 160)}`,
          );
          continue;
        }
        // Both accepted: the stripped shapes must match too, or an implementer
        // validating locally sees a different payload than the log records.
        if (mine.ok && theirs.success) {
          expect(theirs.data).toEqual(mine.stripped);
        }
      }
    }

    expect(compared).toBeGreaterThan(200);
    expect(disagreements).toEqual([]);
  });

  /**
   * The guard that makes the test above mean something. An emitter that dropped
   * every constraint would agree on well-formed generated payloads and disagree
   * on nothing — agreement on acceptance alone is not evidence.
   *
   * BREAK-PROOF: dropping `.max(${validations.maxLength})` reddens this on the
   * over-long-string mutation; dropping `z.enum` in favour of `z.string()`
   * reddens it on the non-enum mutation.
   */
  it("rejects identically when a payload is mutated away from the declaration", async () => {
    const rows = await corpus();
    const disagreements: string[] = [];
    let mutationsTried = 0;

    for (const { app, edge, schema } of rows) {
      const [valid] = generateInputCases({ kind: "single", edge } as any, 11, 1);
      if (enforced(edge, valid).ok !== true) continue;
      const base = valid as Record<string, unknown>;

      const mutations: [string, Record<string, unknown>][] = [];
      for (const [key, field] of scalarFields(edge)) {
        const nullable = (field as { nullable?: boolean }).nullable === true;
        const v = field.validations as Record<string, number | string> | undefined;

        mutations.push([`drop ${key}`, { ...base, [key]: undefined }]);
        mutations.push([
          `wrong type ${key}`,
          { ...base, [key]: field.type === "utf8" || field.type === "datetime" ? 42 : "not-a-number" },
        ]);
        if (!nullable) mutations.push([`null ${key}`, { ...base, [key]: null }]);
        if (field.enumValues !== undefined && field.enumValues.length > 0) {
          mutations.push([`non-enum ${key}`, { ...base, [key]: "\u0000not-a-member" }]);
        }
        if (v?.min !== undefined) {
          mutations.push([`below min ${key}`, { ...base, [key]: (v.min as number) - 1 }]);
        }
        if (v?.max !== undefined) {
          mutations.push([`above max ${key}`, { ...base, [key]: (v.max as number) + 1 }]);
        }
        if (v?.minLength !== undefined && (v.minLength as number) > 0) {
          mutations.push([`too short ${key}`, { ...base, [key]: "" }]);
        }
        if (v?.maxLength !== undefined) {
          mutations.push([
            `too long ${key}`,
            { ...base, [key]: "x".repeat((v.maxLength as number) + 1) },
          ]);
        }
      }

      for (const [label, payload] of mutations) {
        mutationsTried += 1;
        const mine = enforced(edge, payload);
        const theirs = schema.safeParse(payload);
        if (mine.ok !== theirs.success) {
          disagreements.push(
            `${app} ${edge.name} [${label}]: membrane ${mine.ok ? "accepted" : "rejected"}, ` +
              `schema ${theirs.success ? "accepted" : "rejected"}`,
          );
        }
      }
    }

    expect(mutationsTried).toBeGreaterThan(200);
    expect(disagreements).toEqual([]);
  });
});

/**
 * BREAK-PROOF-DRIVEN. Two emitter breaks reddened nothing in the tests above:
 * switching `z.object` to `.strict()`, and dropping `.nullable()`. Both are
 * invisible to `generateInputCases`, which emits only declared fields and never
 * emits `null` (docs/open-questions/generator-coverage.md). So the agreement
 * test was substantially vacuous on exactly the two behaviours an implementer
 * is most likely to trip over, and these probes are the fix.
 */
describe("emit-zod — agrees on payloads the generator cannot produce", () => {
  /** BREAK-PROOF: `.strict()` on the emitted objects reddens this. */
  it("strips undeclared fields rather than rejecting them, as the membrane does", async () => {
    const rows = await corpus();
    let probed = 0;
    for (const { app, edge, schema } of rows) {
      const [valid] = generateInputCases({ kind: "single", edge } as any, 23, 1);
      if (enforced(edge, valid).ok !== true) continue;
      const withExtra = { ...(valid as object), __undeclared: "rides along?" };
      probed += 1;

      const mine = enforced(edge, withExtra);
      const theirs = schema.safeParse(withExtra);
      expect(theirs.success, `${app} ${edge.name}: schema rejected an undeclared key`).toBe(true);
      expect(mine.ok, `${app} ${edge.name}: membrane rejected an undeclared key`).toBe(true);
      // The point of stripping: the undeclared field reaches neither result.
      expect(theirs.data).not.toHaveProperty("__undeclared");
      expect(mine.stripped).not.toHaveProperty("__undeclared");
      expect(theirs.data).toEqual(mine.stripped);
    }
    expect(probed).toBeGreaterThan(20);
  });

  /** BREAK-PROOF: dropping `.nullable()` reddens this. */
  it("accepts null in a nullable field and rejects it in a non-nullable one, as the membrane does", async () => {
    const rows = await corpus();
    let nullableProbes = 0;
    let nonNullableProbes = 0;

    for (const { app, edge, schema } of rows) {
      const [valid] = generateInputCases({ kind: "single", edge } as any, 29, 1);
      if (enforced(edge, valid).ok !== true) continue;

      for (const [key, field] of scalarFields(edge)) {
        if (field.type === "bool") continue; // no `nullable` on bool at all
        const nullable = (field as { nullable?: boolean }).nullable === true;
        const payload = { ...(valid as object), [key]: null };

        const mine = enforced(edge, payload).ok;
        const theirs = schema.safeParse(payload).success;
        expect(theirs, `${app} ${edge.name}.${key} (nullable=${nullable})`).toBe(mine);
        expect(mine, `${app} ${edge.name}.${key} should ${nullable ? "accept" : "reject"} null`).toBe(nullable);

        if (nullable) nullableProbes += 1;
        else nonNullableProbes += 1;
      }
    }
    // Both arms must actually be exercised, or this passes by never testing one.
    expect(nullableProbes).toBeGreaterThan(5);
    expect(nonNullableProbes).toBeGreaterThan(20);
  });
});

describe("emit-zod — the mapping is covered, not assumed", () => {
  /**
   * The corpus cannot cover the mapping table: no declaration uses `datetime`,
   * and `uint32`/`int8`/`int16`/`int32` appear nowhere. A synthetic edge covers
   * every scalar, and this fails loudly if a scalar joins SCALAR_TYPES without
   * an emitter case.
   */
  it("agrees on a well-formed instance of an edge carrying every scalar type", async () => {
    const { edge, schema, source } = await everyScalar();
    const wellFormed = Object.fromEntries(
      SCALAR_TYPES.map((t) => [`f_${t}`, t === "bool" ? true : t === "utf8" || t === "datetime" ? "x" : 1]),
    );
    expect(enforced(edge, wellFormed).ok).toBe(true);
    expect(schema.safeParse(wellFormed).success).toBe(true);
    for (const type of SCALAR_TYPES) expect(source).toContain(`f_${type}`);
  });

  /**
   * A RECORDED DIVERGENCE, and the only one. The emitter is deliberately
   * stricter than the membrane here.
   *
   * `membrane.ts`'s `typeofFor` collapses every numeric type to `"number"`, and
   * `validationErrors` enforces only an explicit `validations: { min, max }` —
   * so a declared `uint8` accepts `-5`, `1e9` and `1.5`. The declared width is
   * decorative at runtime. Found by the agreement test above on its first run.
   *
   * The emitter keeps `.int().min().max()` rather than matching, because the two
   * divergence directions are not equally safe: stricter means an implementer
   * writes a value that satisfies the declared width and the membrane then
   * accepts it, while looser would let an implementer emit 999 for a `uint8`,
   * see a local green, see a gate green, and put it in the durable log.
   *
   * THIS TEST FAILS WHEN THE MEMBRANE IS FIXED. That is intended — closing the
   * gap should force deleting the exception rather than leaving a stale
   * allowance behind. See docs/open-questions/integer-widths-are-decorative.md.
   */
  it("is stricter than the membrane on integer width and integerness, and on nothing else", async () => {
    const { edge, schema } = await everyScalar();
    // Per-type bounds, because a violation for one width is legal for another:
    // -5 is a perfectly good int16 and 1e9 fits in an int32.
    const INTS: [string, number, number][] = [
      ["uint8", 0, 255],
      ["uint16", 0, 65535],
      ["uint32", 0, 4294967295],
      ["int8", -128, 127],
      ["int16", -32768, 32767],
      ["int32", -2147483648, 2147483647],
    ];
    const base = Object.fromEntries(
      SCALAR_TYPES.map((t) => [`f_${t}`, t === "bool" ? true : t === "utf8" || t === "datetime" ? "x" : 1]),
    );

    const unenforced: string[] = [];
    for (const [t, min, max] of INTS) {
      for (const [label, value] of [
        ["above max", max + 1],
        ["below min", min - 1],
        ["non-integer", 1.5],
      ] as [string, number][]) {
        const payload = { ...base, [`f_${t}`]: value };
        const membraneAccepts = enforced(edge, payload).ok;
        const schemaAccepts = schema.safeParse(payload).success;
        // The recorded gap: membrane accepts, emitted schema rejects.
        if (!(membraneAccepts && !schemaAccepts)) {
          unenforced.push(`${t} ${label} (${value}): membrane ${membraneAccepts}, schema ${schemaAccepts}`);
        }
      }
    }
    expect(unenforced).toEqual([]);

    // And the divergence stops there — a wrong scalar type is still rejected by
    // both, so this is a range/integerness gap and not a missing type check.
    for (const [t] of INTS) {
      const payload = { ...base, [`f_${t}`]: "not-a-number" };
      expect(enforced(edge, payload).ok).toBe(false);
      expect(schema.safeParse(payload).success).toBe(false);
    }
  });

  it("carries each field's description into .describe(), so the prose has a home at field level", async () => {
    const elaborated = await elaborate(join(REPO, "spikes/blue-ribbon-slice"));
    const node = elaborated.nodes.parcelCentroid as NodeDecl;
    const source = emitZodModule(node);
    expect(source).toContain(".describe(\"The parcel this point is inside\")");
    expect(source).toContain("WGS84 longitude");
  });
});

describe("emit-zod — the output shapes an implementer cannot guess", () => {
  /**
   * The agent that drafted `routeCounty` discovered the tagged `{edge, payload}`
   * shape by probing, because the sealed contract describes it only as a JSON
   * `oneOf`. A discriminated union states it.
   */
  it("emits a discriminated union for a oneOf output, accepting each branch and rejecting an unknown tag", async () => {
    const elaborated = await elaborate(join(REPO, "spikes/blue-ribbon-slice"));
    const node = elaborated.nodes.routeCounty as NodeDecl;
    const mod = await importEmitted("oneof", node);
    const out = mod.routeCountyOutput;

    expect(
      out.safeParse({
        edge: "DirectCountyQuery",
        payload: {
          pin: "10-003-013-20",
          county: "Osceola",
          endpoint: "https://example.test/FeatureServer/0/query",
        },
      }).success,
    ).toBe(true);

    expect(out.safeParse({ edge: "NotAnEdge", payload: {} }).success).toBe(false);
    // The untagged shape the agent first guessed at.
    expect(out.safeParse({ pin: "10-003-013-20", county: "Osceola" }).success).toBe(false);
  });

  it("emits an allOf input as a bag keyed by edge name", async () => {
    const elaborated = await elaborate(join(REPO, "spikes/blue-ribbon-slice"));
    const node = elaborated.nodes.resolveIdentity as NodeDecl;
    expect(node.input.kind).toBe("allOf");
    const source = emitZodModule(node);
    expect(source).toContain("export const resolveIdentityInput = z.object({");
    expect(source).toContain('"NormalizedParcel": NormalizedParcel,');
  });
});
