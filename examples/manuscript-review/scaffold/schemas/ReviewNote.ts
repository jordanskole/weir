// GENERATED from ReviewNote.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Review Note */
export const ReviewNote = z.object({
  "revision_id": z.string().min(1).max(100).describe("The revision both reports were about"),
  "combined": z.string().min(1).max(1003).describe("The two findings together"),
});
export type ReviewNote = z.infer<typeof ReviewNote>;
