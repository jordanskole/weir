// GENERATED from the declarations by `weir emit-zod normalizeParcel` — do not edit.
// Re-run the emitter instead; this file is mechanical output.

import { z } from "zod";

/** Raw Parcel Feature */
export const RawParcelFeature = z.object({
  "county": z.string().min(4).max(20).describe("Which county's adapter must interpret the payload below"),
  "sourceTrust": z.enum(["verified", "aggregator"]).describe("FRICTION (#5): this field exists only because the oneOf decision made by `routeCounty` is erased the moment both branches converge on this edge. weir's pitch is \"a decision becomes a type, so the consumer's input type IS the proof the decision was made\". That holds right up until two branches produce the same edge -- and converging is the normal case in ETL, because the point of an adapter is that downstream stops caring.\nTo keep it as a type I would need RawParcelFeatureDirect and RawParcelFeatureProxied, and then normalizeParcel takes anyOf of two edges, and every node below it does too. The type survives only by duplicating the rest of the graph.\nSo: back to a string field, checked by nobody, exactly as blue-ribbon has it today. weir gained me nothing here."),
  "featureJson": z.string().min(2).max(2000000).describe("The entire ArcGIS GeoJSON feature, serialized. See the edge description: this is a hole in the type system, deliberately marked."),
});
export type RawParcelFeature = z.infer<typeof RawParcelFeature>;

/** Normalized Parcel */
export const NormalizedParcel = z.object({
  "provenance": z.enum(["verified", "inferred", "aggregator", "listing claim"]).describe("How much this value can be trusted, ranked verified > inferred > aggregator > listing claim. A value derived from several sources takes the weakest of them (combineProvenance in packages/schema/src/provenance.ts)."),
  "vintageAsOf": z.string().min(10).max(10).describe("ISO date this value was true as of"),
  "vintageSourceType": z.enum(["static", "periodic", "continuous", "manual-confirmation"]).describe("How often the underlying source changes"),
  "vintageNote": z.string().max(500).nullable().describe("Why this value is what it is, or why it is null"),
  "pin": z.string().min(8).max(40).describe("Canonical dash-separated parcel identification number"),
  "county": z.string().min(4).max(20).describe("The county this parcel is in"),
  "townshipFromSource": z.string().max(100).nullable().describe("The township, IF this county's own layer carries one. Osceola derives it from its UNIT field; Iosco has no township field at all. Null here is not an error -- it is the signal that the statewide MCD lookup must run. \"A null is data\" (start-here.md rule 2)."),
  "acres": z.number().min(0).max(100000).describe("Parcel area. Rough passthrough only -- each adapter computes it differently (Manistee trusts its own ACRES field; Roscommon divides Shape__Area by 4046.8564224 because its Acres field truncates to integer), and index.ts overwrites it downstream with a DuckDB-verified figure. The spike found disagreeing acreage for one PIN, which is why blue-ribbon wraps it in Field<T> at all."),
  "boundaryJson": z.string().min(2).max(2000000).describe("The parcel's polygon boundary, serialized GeoJSON"),
});
export type NormalizedParcel = z.infer<typeof NormalizedParcel>;

/** What `normalizeParcel` receives, after the membrane has asserted it. */
export const normalizeParcelInput = RawParcelFeature;
export type normalizeParcelInput = z.infer<typeof normalizeParcelInput>;

/** What `normalizeParcel` must return. Throw to decline. */
export const normalizeParcelOutput = NormalizedParcel;
export type normalizeParcelOutput = z.infer<typeof normalizeParcelOutput>;

export type normalizeParcelFn = (p: normalizeParcelInput) => normalizeParcelOutput;
