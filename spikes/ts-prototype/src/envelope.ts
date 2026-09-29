/**
 * Declared envelopes: metadata that rides with a token rather than over a wire
 * (docs/superpowers/specs/2026-09-29-the-declared-envelope.md).
 *
 * The problem this removes: cross-cutting metadata had to be a declared field
 * on **every intermediate edge on its path**, so a node with no use for a trust
 * value still had to declare four fields to carry it, and a parcel's PIN could
 * not reach a subgraph eleven nodes downstream without five edges about *soil*
 * growing a `pin`.
 *
 * Two things are deliberately separate here:
 *
 * - **Carrying is not reading.** A token carries its whole envelope through a
 *   node that can read none of it. Conflating them is exactly what forces every
 *   intermediate edge to declare the field again.
 * - **Propagation is not `Identity`'s.** `identity` is run-global — one value,
 *   supplied at the trigger, identical for every token. This is per-token and
 *   flows along lineage, because two parcels in one run have different PINs.
 */

import type { AnyEdgeDef, FieldDef } from "./types.js";

/** The envelope values riding on one token. */
export type Meta = Record<string, unknown>;

/** Every declared envelope field, by name, across all declared envelopes. */
export function envelopeFields(envelopes: Record<string, AnyEdgeDef>): Map<string, FieldDef> {
  const fields = new Map<string, FieldDef>();
  for (const envelope of Object.values(envelopes)) {
    for (const [key, field] of Object.entries(envelope.fields)) {
      fields.set(key, field as FieldDef);
    }
  }
  return fields;
}

/**
 * Merges several inputs' envelopes into the one a fan-in's output carries.
 *
 * Per field, by that field's declared `combine`, because the answer genuinely
 * differs per field: a trust value takes its weakest source, an integrity label
 * takes its strongest, and an identifier must simply agree. There is no default
 * (`parseEnvelopeFile` requires the key) because every wrong guess here is
 * silent — `meet` where `same` was meant merges two tokens about different
 * things without complaining, which is the cross-item join the whole lineage
 * design exists to prevent.
 *
 * Returns a `conflict` rather than throwing: a `same` violation is a statement
 * about the *data*, so it becomes `Failed<In>` by the membrane's ordinary path
 * rather than an exception that would take the run down.
 */
export function combineMeta(
  fields: Map<string, FieldDef>,
  metas: Meta[],
): { meta: Meta; conflict?: string } {
  const merged: Meta = {};
  for (const [key, field] of fields) {
    const present = metas.map((m) => m[key]).filter((v) => v !== undefined);
    if (present.length === 0) continue;
    if (present.length === 1) {
      merged[key] = present[0];
      continue;
    }

    if (field.combine === "same") {
      const first = present[0];
      const disagreeing = present.find((v) => v !== first);
      if (disagreeing !== undefined) {
        return {
          meta: merged,
          conflict:
            `envelope "${key}" is declared "combine: same" and the inputs disagree ` +
            `(${JSON.stringify(first)} vs ${JSON.stringify(disagreeing)}). Joining tokens that are ` +
            `about different things is what this rule exists to catch.`,
        };
      }
      merged[key] = first;
      continue;
    }

    // `meet` and `join` order by the field's own `enumValues`, weakest first —
    // which `parseEnvelopeFile` has already required `ordinal: true` and a
    // non-empty `enumValues` for, so neither can be missing here.
    const order = field.enumValues ?? [];
    const ranked = present.map((v) => order.indexOf(v as string));
    if (ranked.some((i) => i < 0)) {
      return {
        meta: merged,
        conflict: `envelope "${key}": a value is not among its declared enumValues, so it cannot be ordered.`,
      };
    }
    const pick = field.combine === "meet" ? Math.min(...ranked) : Math.max(...ranked);
    merged[key] = order[pick];
  }
  return { meta: merged };
}

/**
 * What a node may read, narrowed by its `scope`.
 *
 * The same mechanism `Identity` already uses — `membrane.ts`'s `narrowIdentity`
 * error says *"only `read:Identity:<field>` resolves to anything today"*, and
 * this is that `today` expiring. Reusing it is also what keeps adding an
 * envelope field from moving every contract hash in the program: `scope` is
 * fingerprinted, so only a node that **names** the new field is re-accepted.
 */
export function narrowMeta(
  scope: string[] | undefined,
  meta: Meta,
  envelopes: Record<string, AnyEdgeDef>,
): Meta {
  if (!scope || scope.length === 0) return {};
  const narrowed: Meta = {};
  for (const declaration of scope) {
    const [verb, envelopeName, field] = declaration.split(":");
    if (verb !== "read" || envelopeName === undefined || field === undefined) continue;
    const envelope = envelopes[envelopeName];
    if (envelope === undefined) continue; // Identity, or a typo the membrane reports.
    if (!(field in envelope.fields)) {
      throw new Error(`scope "${declaration}": envelope "${envelopeName}" has no field "${field}".`);
    }
    if (field in meta) narrowed[field] = meta[field];
  }
  return narrowed;
}
