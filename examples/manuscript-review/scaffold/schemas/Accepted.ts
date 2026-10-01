// GENERATED from Accepted.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Accepted */
export const Accepted = z.object({
  "id": z.string().min(1).max(100).describe("The manuscript's identifier"),
  "rounds": z.number().int().min(0).max(255).min(1).max(10).describe("How many rounds it took"),
});
export type Accepted = z.infer<typeof Accepted>;
