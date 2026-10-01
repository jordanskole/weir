import type { reviseInput, reviseOutput } from "./schema.js";

// Revision's bounds, inlined: the acceptance gate loads this file on its own, so
// it cannot import ./schema.js at runtime (type-only imports are erased).
const MAX_ID = 100;
const MAX_TEXT = 2000;
const REVISED = " (revised)";

/** The loop runs three rounds; the third revision is the one accepted. */
const FINAL_ROUND = 3;

/**
 * revise — the loop's step and base case.
 *
 * Before the final round the manuscript comes back as the next revision
 * (`m-1-r1` -> `m-1-r2`, text marked "(revised)"). From the final round on it is
 * accepted under the revision's own id. Where the grown id or text would
 * overflow its bound we decline instead of truncating.
 */
export default function revise(p: reviseInput): reviseOutput {
  if (p.round >= FINAL_ROUND) {
    return { edge: "Accepted", payload: { id: p.id, rounds: p.round } };
  }
  const next = p.round + 1;
  const suffix = `-r${p.round}`;
  const stem = p.id.endsWith(suffix) ? p.id.slice(0, -suffix.length) : p.id;
  const id = `${stem}-r${next}`;
  const text = `${p.text}${REVISED}`;
  if (id.length > MAX_ID || text.length > MAX_TEXT) {
    throw new Error(`revise: round ${next} of "${p.id}" would overflow the Revision bounds`);
  }
  return { edge: "Revision", payload: { id, text, round: next } };
}
