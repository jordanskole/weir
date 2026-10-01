/**
 * Property-test generation (docs/design.md §6; docs/superpowers/specs/
 * 2026-09-10-generator-and-fuzz-harness.md) — a seeded, boundary-biased
 * per-field generator derived from FieldDef's own type/enumValues/
 * validations, the same "mechanically derivable from the same types" move
 * contract.ts and schema.ts already make off the same source.
 */

import { INTEGER_RANGES } from "./define.js";
import { isIntegerType } from "./types.js";
import type { AnyEdgeDef, FieldDef, InputSpec, LiteralFieldDef, ScalarType } from "./types.js";

export type Rng = () => number;

/**
 * mulberry32 — a small, deterministic, dependency-free PRNG. Same seed,
 * same sequence, always: what makes a generated batch reproducible across
 * runs rather than flaky.
 */
export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  return function rng(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomInt(rng: Rng, min: number, max: number): number {
  return Math.floor(rng() * (max - min + 1)) + min;
}

/** A pragmatic sampling range for f32/f64 fields — these have no representable-range check (INTEGER_RANGES has no entry for them), but generation still needs *some* concrete domain to sample uniform-random fill from. Not a spec requirement, an implementation default. */
const DEFAULT_FLOAT_BOUND = 1_000_000;

/** The length a `utf8` field gets when it declares no `maxLength`. */
const DEFAULT_MAX_LENGTH = 64;

/**
 * How far above `minLength` an ordinary generated string reaches, once the
 * boundary lengths have been emitted. Matches `DEFAULT_MAX_LENGTH`, so a field
 * with no declared bound behaves exactly as it did before this split existed.
 */
const ORDINARY_LENGTH_SPAN = 64;

function numericBounds(field: FieldDef): [number, number] {
  const v = field.validations as { min?: number; max?: number } | undefined;
  const range = INTEGER_RANGES[field.type];
  const min = v?.min ?? range?.[0] ?? -DEFAULT_FLOAT_BOUND;
  const max = v?.max ?? range?.[1] ?? DEFAULT_FLOAT_BOUND;
  return [min, max];
}

function generateNumericValue(field: FieldDef, rng: Rng, caseIndex: number): number {
  const [min, max] = numericBounds(field);
  const boundaries = Array.from(
    new Set(
      [
        min,
        max,
        min + 1 <= max ? min + 1 : undefined,
        max - 1 >= min ? max - 1 : undefined,
        min <= 0 && 0 <= max ? 0 : undefined,
      ].filter((v): v is number => v !== undefined),
    ),
  );
  if (caseIndex < boundaries.length) return boundaries[caseIndex];
  const raw = min + rng() * (max - min);
  return isIntegerType(field.type) ? Math.round(raw) : raw;
}

const MIN_DATETIME = Date.parse("2000-01-01T00:00:00.000Z");
const MAX_DATETIME = Date.parse("2030-01-01T00:00:00.000Z");

/** Every value `toISOString()` ever produces is exactly this many characters. */
const ISO_8601_LENGTH = "2000-01-01T00:00:00.000Z".length;

function generateDatetimeValue(fieldKey: string, field: FieldDef, rng: Rng, caseIndex: number): string {
  const v = field.validations as { minLength?: number; maxLength?: number } | undefined;
  if (
    (v?.minLength !== undefined && v.minLength > ISO_8601_LENGTH) ||
    (v?.maxLength !== undefined && v.maxLength < ISO_8601_LENGTH)
  ) {
    throw new Error(
      `generate: field "${fieldKey}" declares minLength/maxLength that a ${ISO_8601_LENGTH}-character ISO-8601 datetime can never satisfy (docs/superpowers/specs/2026-09-10-generator-and-fuzz-harness.md).`,
    );
  }
  const boundaries = [MIN_DATETIME, MAX_DATETIME];
  const millis = caseIndex < boundaries.length ? boundaries[caseIndex] : randomInt(rng, MIN_DATETIME, MAX_DATETIME);
  return new Date(millis).toISOString();
}

const PRINTABLE_CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ";

function generateStringValue(fieldKey: string, field: FieldDef, rng: Rng, caseIndex: number): string {
  const v = field.validations as { minLength?: number; maxLength?: number; pattern?: string } | undefined;
  if (v?.pattern !== undefined) {
    throw new Error(
      `generate: field "${fieldKey}" declares a pattern — generating strings that satisfy an arbitrary regex isn't supported (docs/superpowers/specs/2026-09-10-generator-and-fuzz-harness.md).`,
    );
  }
  const minLength = v?.minLength ?? 0;
  const maxLength = v?.maxLength ?? DEFAULT_MAX_LENGTH;

  /**
   * Boundary lengths first, then *ordinary* lengths — not uniform over the whole
   * range, which is the one place this differs from `generateNumericValue` and the
   * reason is that a uniform length is not free the way a uniform number is.
   *
   * blue-ribbon's `boundaryJson` is declared `maxLength: 2000000`. Sampling the
   * length uniformly gave, over the gate's real 100 cases, a median of 1,157,240
   * characters and **107,972,852 characters in total** — 108 MB of random text to
   * reach a verdict the first case already determined, and 95 of those cases were a
   * megabyte of noise testing exactly what 60 characters would have tested
   * (docs/open-questions/generated-strings-are-enormous.md).
   *
   * So: `minLength`, `minLength + 1`, `maxLength - 1` and `maxLength` are each
   * generated **once**, which is what a declared bound is owed — the declaration
   * promises to carry 2 MB, so something should carry 2 MB — and every remaining
   * case gets an ordinary length near the floor. Same boundary coverage, a
   * thousandth of the bytes.
   *
   * What this deliberately gives up: the range of lengths *between* the boundaries
   * and the ordinary span is no longer sampled. A bug that needs a 600,000-character
   * string specifically, and that neither 2,000,000 nor 66 provokes, is not reachable
   * from here. That is the trade, taken knowingly.
   */
  const boundaryLengths = Array.from(
    new Set(
      [minLength, minLength + 1, maxLength - 1, maxLength].filter(
        (n) => n >= minLength && n <= maxLength,
      ),
    ),
  );
  const ordinaryMax = Math.min(maxLength, minLength + ORDINARY_LENGTH_SPAN);
  const length =
    caseIndex < boundaryLengths.length
      ? boundaryLengths[caseIndex]
      : randomInt(rng, minLength, ordinaryMax);
  let result = "";
  for (let i = 0; i < length; i++) {
    result += PRINTABLE_CHARS[randomInt(rng, 0, PRINTABLE_CHARS.length - 1)];
  }
  return result;
}

/**
 * Generates one value for a single scalar or literal field. `caseIndex` is
 * this value's position within its batch — boundary values (numeric
 * min/max, string min/maxLength, every enumValues entry, bool
 * true-then-false) are front-loaded onto the earliest indices, uniform
 * random fills the rest, so a batch's first several cases are always the
 * cases a hand-written example set is least likely to include.
 */
export function generateFieldValue(
  fieldKey: string,
  field: FieldDef | LiteralFieldDef,
  rng: Rng,
  caseIndex: number,
): unknown {
  if ("literal" in field) return field.literal;

  if (field.enumValues !== undefined) {
    return field.enumValues[caseIndex % field.enumValues.length];
  }

  if (field.type === "bool") return caseIndex % 2 === 0;

  if (field.type === "datetime") {
    const v = field.validations as { pattern?: string } | undefined;
    if (v?.pattern !== undefined) {
      throw new Error(
        `generate: field "${fieldKey}" declares a pattern — generating strings that satisfy an arbitrary regex isn't supported (docs/superpowers/specs/2026-09-10-generator-and-fuzz-harness.md).`,
      );
    }
    return generateDatetimeValue(fieldKey, field, rng, caseIndex);
  }

  if (field.type === "utf8") return generateStringValue(fieldKey, field, rng, caseIndex);

  return generateNumericValue(field, rng, caseIndex);
}

function generateManyValue(edge: AnyEdgeDef, rng: Rng, caseIndex: number): Record<string, unknown> {
  if (edge.index === undefined) {
    throw new Error(`generate: "${edge.name}" is used as a many-collection but declares no index.`);
  }
  const count = randomInt(rng, 0, 3);
  const collection: Record<string, unknown> = {};
  for (let i = 0; i < count; i++) {
    const entry = generatePayload(edge, rng, caseIndex + i);
    const key = String(entry[edge.index]);
    collection[key] = entry;
  }
  return collection;
}

/**
 * Generates one full payload for `edge`, recursing into compound (nested
 * AnyEdgeDef) and many fields — the same three-way discriminant
 * assertPayload/hash.ts's fingerprint() already use ("many" in field /
 * "fields" in field / scalar-or-literal), applied here to generate rather
 * than validate.
 */
export function generatePayload(edge: AnyEdgeDef, rng: Rng, caseIndex: number): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, fieldDef] of Object.entries(edge.fields)) {
    if ("many" in fieldDef) {
      result[key] = generateManyValue(fieldDef.many, rng, caseIndex);
      continue;
    }
    if ("fields" in fieldDef) {
      result[key] = generatePayload(fieldDef, rng, caseIndex);
      continue;
    }
    result[key] = generateFieldValue(key, fieldDef, rng, caseIndex);
  }
  return result;
}

/**
 * The entry point a fuzz harness calls: `count` generated cases for a
 * node's declared InputSpec. `single` generates a payload per case;
 * `allOf` generates a bag keyed by edge name per case, matching
 * InputPayload's own allOf shape (types.ts).
 */
export function generateInputCases(input: InputSpec, seed: number, count: number): unknown[] {
  const rng = createRng(seed);
  const cases: unknown[] = [];
  for (let i = 0; i < count; i++) {
    if (input.kind === "single") {
      cases.push(generatePayload(input.edge, rng, i));
    } else if (input.kind === "gather") {
      // A keyed collection, keyed by each entry's own `index` — the shape a
      // gather actually receives. Size varies with `i` so the generated
      // cases include the empty collection, which is the case a gather is
      // most likely to get wrong (spec §5: traverse over empty yields
      // empty, never a hang).
      const collection: Record<string, unknown> = {};
      for (let n = 0; n < i % 3; n += 1) {
        const entry = generatePayload(input.edge, rng, i + n) as Record<string, unknown>;
        const key = input.edge.index === undefined ? String(n) : String(entry[input.edge.index]);
        collection[key] = entry;
      }
      cases.push(collection);
    } else {
      const bag: Record<string, unknown> = {};
      for (const edge of input.edges) {
        bag[edge.name] = generatePayload(edge, rng, i);
      }
      cases.push(bag);
    }
  }
  return cases;
}
