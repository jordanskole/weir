// GENERATED from ParcelIdentity.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Parcel Identity */
export const ParcelIdentity = z.object({
  "provenance": z.enum(["verified", "inferred", "aggregator", "listing claim"]).describe("How much this value can be trusted, ranked verified > inferred > aggregator > listing claim. A value derived from several sources takes the weakest of them (combineProvenance in packages/schema/src/provenance.ts)."),
  "vintageAsOf": z.string().min(10).max(10).describe("ISO date this value was true as of"),
  "vintageSourceType": z.enum(["static", "periodic", "continuous", "manual-confirmation"]).describe("How often the underlying source changes"),
  "vintageNote": z.string().max(500).nullable().describe("Why this value is what it is, or why it is null"),
  "pin": z.string().min(8).max(40).describe("Canonical dash-separated parcel identification number"),
  "county": z.string().min(4).max(20).describe("The county this parcel is in"),
  "township": z.string().min(2).max(100).describe("The city or township containing the parcel"),
  "acres": z.number().min(0).max(100000).describe("Parcel area in acres"),
  "boundaryJson": z.string().min(2).max(2000000).describe("The parcel's polygon boundary, serialized GeoJSON"),
});
export type ParcelIdentity = z.infer<typeof ParcelIdentity>;
