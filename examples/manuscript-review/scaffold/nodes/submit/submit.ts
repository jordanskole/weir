import type { submitInput, submitOutput } from "./schema.js";

// Revision's bounds. Inlined rather than parsed through the schema: the
// acceptance gate loads this file on its own, so it cannot import ./schema.js
// at runtime (type-only imports are erased and are fine).
const MAX_ID = 100;

/**
 * submit — admits a draft as round 1.
 *
 * The revision id is derived from the draft id (`m-1` -> `m-1-r1`). A draft id
 * at the edge's 100-char bound has no room for the suffix, so we decline rather
 * than truncate an identifier.
 */
export default function submit(p: submitInput): submitOutput {
  const id = `${p.id}-r1`;
  if (id.length > MAX_ID) {
    throw new Error(`submit: "${p.id}" leaves no room for the -r1 suffix within ${MAX_ID} chars`);
  }
  return { id, text: p.text, round: 1 };
}
