// GENERATED from StyleReport.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** StyleReport */
export const StyleReport = z.object({
  "revision_id": z.string().min(1).max(100).describe("The revision this report is about"),
  "note": z.string().min(1).max(500).describe("What the style check found"),
});
export type StyleReport = z.infer<typeof StyleReport>;
