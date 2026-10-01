// GENERATED from RawParcelFeature.edge — do not edit. Re-run the scaffold.

import { z } from "zod";

/** Raw Parcel Feature */
export const RawParcelFeature = z.object({
  "county": z.string().min(4).max(20).describe("Which county's adapter must interpret the payload below"),
  "sourceTrust": z.enum(["verified", "aggregator"]).describe("FRICTION (#5): this field exists only because the oneOf decision made by `routeCounty` is erased the moment both branches converge on this edge. weir's pitch is \"a decision becomes a type, so the consumer's input type IS the proof the decision was made\". That holds right up until two branches produce the same edge -- and converging is the normal case in ETL, because the point of an adapter is that downstream stops caring.\nTo keep it as a type I would need RawParcelFeatureDirect and RawParcelFeatureProxied, and then normalizeParcel takes anyOf of two edges, and every node below it does too. The type survives only by duplicating the rest of the graph.\nSo: back to a string field, checked by nobody, exactly as blue-ribbon has it today. weir gained me nothing here."),
  "featureJson": z.string().min(2).max(2000000).describe("The entire ArcGIS GeoJSON feature, serialized. See the edge description: this is a hole in the type system, deliberately marked."),
});
export type RawParcelFeature = z.infer<typeof RawParcelFeature>;
