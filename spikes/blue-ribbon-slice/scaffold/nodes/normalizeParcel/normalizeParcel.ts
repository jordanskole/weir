import type { normalizeParcelInput, normalizeParcelOutput } from "./schema.js";

/**
 * normalizeParcel
 *
 * The membrane asserts the input against the schema before this runs, so `p` is
 * already structurally valid — the type is backed by a runtime assertion rather
 * than being a promise.
 *
 * Decline by throwing. The membrane turns a throw into a `Failed` record
 * carrying the payload it was given and the reason, which is the right answer for input this
 * cannot handle — but note that the acceptance gate reports a candidate that
 * declines *every* generated input as `vacuous`, which is a failing verdict.
 * If you believe every generated input is undeclinable-but-unusable, say so
 * rather than inventing a plausible value to get past the gate.
 */
export default function normalizeParcel(p: normalizeParcelInput): normalizeParcelOutput {
  throw new Error("normalizeParcel: not implemented");
}
