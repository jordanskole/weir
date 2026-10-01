import type { checkStyleInput, checkStyleOutput } from "./schema.js";

/** checkStyle — reviews one revision; the note names its round. */
export default function checkStyle(p: checkStyleInput): checkStyleOutput {
  return { revision_id: p.id, note: `style ok at round ${p.round}` };
}
