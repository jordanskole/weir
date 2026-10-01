// GENERATED from the declarations by `weir emit-zod parcelCentroid` — do not edit.
// Re-run the emitter instead; this file is mechanical output.

import { z } from "zod";

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

/** Parcel Centroid */
export const ParcelCentroid = z.object({
  "pin": z.string().min(8).max(40).describe("The parcel this point is inside"),
  "lng": z.number().min(-180).max(180).describe("WGS84 longitude of the parcel's area-weighted centroid"),
  "lat": z.number().min(-90).max(90).describe("WGS84 latitude of the parcel's area-weighted centroid"),
});
export type ParcelCentroid = z.infer<typeof ParcelCentroid>;

/** What `parcelCentroid` receives, after the membrane has asserted it. */
export const parcelCentroidInput = NormalizedParcel;
export type parcelCentroidInput = z.infer<typeof parcelCentroidInput>;

/** What `parcelCentroid` must return. Throw to decline. */
export const parcelCentroidOutput = ParcelCentroid;
export type parcelCentroidOutput = z.infer<typeof parcelCentroidOutput>;

export type parcelCentroidFn = (p: parcelCentroidInput) => parcelCentroidOutput;
