/**
 * Property-test generation (docs/design.md §6; docs/superpowers/specs/
 * 2026-09-10-generator-and-fuzz-harness.md) — a seeded, boundary-biased
 * per-field generator derived from FieldDef's own type/enumValues/
 * validations, the same "mechanically derivable from the same types" move
 * contract.ts and schema.ts already make off the same source.
 */

import { INTEGER_RANGES } from "./define.js";
import type { FieldDef, LiteralFieldDef, ScalarType } from "./types.js";

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

function isIntegerType(type: ScalarType): boolean {
  return type in INTEGER_RANGES;
}

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

function generateDatetimeValue(rng: Rng, caseIndex: number): string {
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
  const maxLength = v?.maxLength ?? 64;
  const boundaryLengths = Array.from(new Set([minLength, maxLength]));
  const length = caseIndex < boundaryLengths.length ? boundaryLengths[caseIndex] : randomInt(rng, minLength, maxLength);
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
    return generateDatetimeValue(rng, caseIndex);
  }

  if (field.type === "utf8") return generateStringValue(fieldKey, field, rng, caseIndex);

  return generateNumericValue(field, rng, caseIndex);
}
