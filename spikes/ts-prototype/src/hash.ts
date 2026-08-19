/**
 * Schema hashing for drift detection.
 *
 * Produces a deterministic SHA-256 fingerprint of an EdgeDef's structural
 * shape. Only structural fields are included — changes to description, unit,
 * or sourceKey do not affect the hash. Every edge instance in the log carries
 * the schema hash of the definition it was written under (docs/design.md §5);
 * replay compares recorded hash to current definition and either migrates
 * through a declared rule or refuses.
 *
 * Ported from @bankql/schema's hashDataset — see docs/design-history.md,
 * "Prior art: bankql already proves the edge half."
 *
 * Uses the Web Crypto API so the same implementation runs in both Node
 * (>=20) and modern browsers.
 */

import type { EdgeDef, FieldDef } from "./types.js";

interface FieldFingerprint {
  type: string;
  measure?: string;
  format?: string;
  enumValues?: string[];
  relation?: { edge: string; field: string; cardinality: string };
}

interface EdgeFingerprint {
  name: string;
  index?: string;
  fields: Record<string, FieldFingerprint>;
}

function fingerprint(edge: EdgeDef): EdgeFingerprint {
  const fields: Record<string, FieldFingerprint> = {};

  for (const key of Object.keys(edge.fields).sort()) {
    const f = edge.fields[key] as FieldDef;
    const entry: FieldFingerprint = { type: f.type };
    if (f.measure !== undefined) entry.measure = f.measure;
    if (f.format !== undefined) entry.format = f.format;
    if (f.enumValues !== undefined) entry.enumValues = [...f.enumValues].sort();
    if (f.relation !== undefined) {
      entry.relation = {
        edge: f.relation.edge,
        field: f.relation.field,
        cardinality: f.relation.cardinality,
      };
    }
    fields[key] = entry;
  }

  return {
    name: edge.name,
    ...(edge.index !== undefined && { index: edge.index }),
    fields,
  };
}

export interface SchemaHash {
  /** Full 64-character SHA-256 hex digest. */
  hash: string;
  /** First 8 characters — suitable for envelopes, filenames, logs, and display. */
  short: string;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hashEdge(edge: EdgeDef): Promise<SchemaHash> {
  const json = JSON.stringify(fingerprint(edge));
  const bytes = new TextEncoder().encode(json);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hash = toHex(digest);
  return { hash, short: hash.slice(0, 8) };
}

export async function hashEdges(edges: EdgeDef[]): Promise<Record<string, SchemaHash>> {
  const entries = await Promise.all(
    edges.map(async (e) => [e.name, await hashEdge(e)] as const),
  );
  return Object.fromEntries(entries);
}

/**
 * Assert that an edge matches an expected hash.
 * Throws if the hash has changed — useful in tests or replay to catch
 * accidental schema drift.
 */
export async function assertEdgeHash(edge: EdgeDef, expectedShort: string): Promise<void> {
  const { short, hash } = await hashEdge(edge);
  if (short !== expectedShort) {
    throw new Error(
      `Schema drift detected for edge "${edge.name}": ` +
        `expected hash "${expectedShort}", got "${short}" (full: ${hash}). ` +
        `Update the expected hash or roll back the schema change.`,
    );
  }
}
