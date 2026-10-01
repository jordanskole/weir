// GENERATED from the declarations by `weir emit-zod resolveIdentity` — do not edit.
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

/** Township Lookup */
export const TownshipLookup = z.object({
  "provenance": z.enum(["verified", "inferred", "aggregator", "listing claim"]).describe("How much this value can be trusted, ranked verified > inferred > aggregator > listing claim. A value derived from several sources takes the weakest of them (combineProvenance in packages/schema/src/provenance.ts)."),
  "vintageAsOf": z.string().min(10).max(10).describe("ISO date this value was true as of"),
  "vintageSourceType": z.enum(["static", "periodic", "continuous", "manual-confirmation"]).describe("How often the underlying source changes"),
  "vintageNote": z.string().max(500).nullable().describe("Why this value is what it is, or why it is null"),
  "pin": z.string().min(8).max(40).describe("The parcel this township was resolved for"),
  "township": z.string().min(2).max(100).describe("The Minor Civil Division name containing the parcel's centroid.\nCORRECTED 2026-09-29 -- read this before the paragraph under it.\nI CLAIMED nested readiness conditions make the null case inexpressible and force \"an extra node whose only job is to flatten two branches\". Wrong. The idiomatic version IS expressible: `lookupTownship` outputs `oneOf: [TownshipLookup, TownshipUnknown]`, and a SECOND join node `resolveIdentityUnresolved: allOf [NormalizedParcel, TownshipUnknown]` also produces ParcelIdentity, with both as terminals. I built it at /tmp/nulltest: it elaborates (10 edges, 8 nodes) and RUNS, producing the right answer with township \"UNKNOWN\" and the reason carried through.\nIT IS WORSE THAN I SAID, NOT BETTER. That run reports:\n\n  residue [{ node: \"resolveIdentity\", edge: \"NormalizedParcel\", waiting: 1 }]\n\nThe single NormalizedParcel token is consumed by whichever join fires; the other join waits forever for a token that no longer exists. So the run produces correct output AND reports a stall, and `weir run` exits non-zero. The idiomatic answer to \"a null is data\" makes every such run red. That is now tracked as its own open question.\nTHE ORIGINAL CLAIM, PRESERVED AND WRONG:\nFRICTION (#3, the null-is-data problem): this is `nullable: false`, and it should not be. blue-ribbon's rule 2 says a null is data -- a parcel in a county with no digital layer legitimately has no township, and that is a FACT to record, not a failure to retry. But in weir, if this edge never arrives, `resolveIdentity`'s allOf never becomes ready, the run reaches quiescence with residue, and `weir run` exits non-zero naming the node. A legitimate null becomes a stalled run.\nThe fix weir offers is `oneOf: [TownshipLookup, TownshipUnavailable]` and routing both. But then resolveIdentity needs `allOf: [NormalizedParcel, anyOf: [TownshipLookup, TownshipUnavailable]]` and NESTED READINESS CONDITIONS ARE NOT EXPRESSIBLE -- input is `allOf` OR `anyOf` OR `gather`, never a composition of them. So I need an extra node whose only job is to flatten two branches back into one nullable edge. A node that exists to work around the type system is ceremony, and in a domain where ragged coverage IS the subject matter I would be writing that node constantly."),
});
export type TownshipLookup = z.infer<typeof TownshipLookup>;

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

/** What `resolveIdentity` receives, after the membrane has asserted it. */
export const resolveIdentityInput = z.object({
  "NormalizedParcel": NormalizedParcel,
  "TownshipLookup": TownshipLookup,
});
export type resolveIdentityInput = z.infer<typeof resolveIdentityInput>;

/** What `resolveIdentity` must return. Throw to decline. */
export const resolveIdentityOutput = ParcelIdentity;
export type resolveIdentityOutput = z.infer<typeof resolveIdentityOutput>;

export type resolveIdentityFn = (p: resolveIdentityInput) => resolveIdentityOutput;
