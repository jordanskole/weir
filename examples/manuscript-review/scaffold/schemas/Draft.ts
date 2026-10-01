// GENERATED from Draft.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Draft */
export const Draft = z.object({
  "id": z.string().min(1).max(100).describe("The manuscript's identifier"),
  "text": z.string().min(1).max(2000).describe("The manuscript body"),
});
export type Draft = z.infer<typeof Draft>;
