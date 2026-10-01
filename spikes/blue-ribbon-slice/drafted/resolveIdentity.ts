// resolveIdentity: the fan-in. Join a NormalizedParcel with its resolved
// TownshipLookup, and combine their provenances (lattice meet).

// verified > inferred > aggregator > listing claim. The meet is the weakest,
// i.e. the largest rank index.
const PROVENANCE_RANK: Record<string, number> = {
  verified: 0,
  inferred: 1,
  aggregator: 2,
  "listing claim": 3,
};

// GUESS: the contract states no rule for combining vintageSourceType. The one
// example combines "continuous" (parcel) and "periodic" (township) into
// "continuous", i.e. the MORE volatile of the two wins -- a composite is stale
// as soon as its fastest-moving constituent moves. Ordered most volatile first.
const VOLATILITY_RANK: Record<string, number> = {
  continuous: 0,
  periodic: 1,
  "manual-confirmation": 2,
  static: 3,
};

function requireString(
  v: any,
  where: string,
  min: number,
  max: number,
): string {
  if (typeof v !== "string" || v.length < min || v.length > max) {
    throw new Error(
      "resolveIdentity: " +
        where +
        " must be a " +
        min +
        ".." +
        max +
        " character string, got " +
        JSON.stringify(v),
    );
  }
  return v;
}

function requireEnum(v: any, table: Record<string, number>, where: string): string {
  if (typeof v !== "string" || !Object.prototype.hasOwnProperty.call(table, v)) {
    throw new Error(
      "resolveIdentity: " + where + " is not a declared value: " + JSON.stringify(v),
    );
  }
  return v;
}

function noteOf(v: any, where: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") {
    throw new Error(
      "resolveIdentity: " + where + " must be a string or null, got " + typeof v,
    );
  }
  return v;
}

export default function resolveIdentity(p: any) {
  if (p === null || typeof p !== "object") {
    throw new Error(
      "resolveIdentity: input must be an object carrying NormalizedParcel and TownshipLookup",
    );
  }
  const parcel = p.NormalizedParcel;
  const lookup = p.TownshipLookup;
  if (parcel === null || typeof parcel !== "object") {
    throw new Error("resolveIdentity: input.NormalizedParcel is missing");
  }
  if (lookup === null || typeof lookup !== "object") {
    throw new Error("resolveIdentity: input.TownshipLookup is missing");
  }

  const parcelPin = requireString(parcel.pin, "NormalizedParcel.pin", 8, 40);
  const lookupPin = requireString(lookup.pin, "TownshipLookup.pin", 8, 40);
  // The declared property requires the output PIN to equal BOTH inputs' PINs.
  // Two different parcels cannot be joined, so decline rather than pick one.
  if (parcelPin !== lookupPin) {
    throw new Error(
      "resolveIdentity: refusing to join two different parcels -- " +
        "NormalizedParcel.pin is " +
        JSON.stringify(parcelPin) +
        " but TownshipLookup.pin is " +
        JSON.stringify(lookupPin),
    );
  }

  const county = requireString(parcel.county, "NormalizedParcel.county", 4, 20);
  const township = requireString(lookup.township, "TownshipLookup.township", 2, 100);
  const boundaryJson = requireString(
    parcel.boundaryJson,
    "NormalizedParcel.boundaryJson",
    2,
    2000000,
  );

  const acres = parcel.acres;
  if (typeof acres !== "number" || !isFinite(acres) || acres < 0 || acres > 100000) {
    throw new Error(
      "resolveIdentity: NormalizedParcel.acres must be a finite number in 0..100000, got " +
        JSON.stringify(acres),
    );
  }

  const parcelProv = requireEnum(
    parcel.provenance,
    PROVENANCE_RANK,
    "NormalizedParcel.provenance",
  );
  const lookupProv = requireEnum(
    lookup.provenance,
    PROVENANCE_RANK,
    "TownshipLookup.provenance",
  );
  const provenance =
    PROVENANCE_RANK[parcelProv] >= PROVENANCE_RANK[lookupProv]
      ? parcelProv
      : lookupProv;

  const parcelVol = requireEnum(
    parcel.vintageSourceType,
    VOLATILITY_RANK,
    "NormalizedParcel.vintageSourceType",
  );
  const lookupVol = requireEnum(
    lookup.vintageSourceType,
    VOLATILITY_RANK,
    "TownshipLookup.vintageSourceType",
  );
  const vintageSourceType =
    VOLATILITY_RANK[parcelVol] <= VOLATILITY_RANK[lookupVol] ? parcelVol : lookupVol;

  const parcelAsOf = requireString(
    parcel.vintageAsOf,
    "NormalizedParcel.vintageAsOf",
    10,
    10,
  );
  const lookupAsOf = requireString(
    lookup.vintageAsOf,
    "TownshipLookup.vintageAsOf",
    10,
    10,
  );
  // GUESS: the contract states no rule; both sides of the one example carry the
  // same date. A joined value is only true as of the OLDER of its parts, so the
  // lexicographically smaller ISO date wins.
  const vintageAsOf = parcelAsOf <= lookupAsOf ? parcelAsOf : lookupAsOf;

  // GUESS at the composition template, read off the single example:
  //   "parcel: <parcel note>; township: <township note>"
  const parcelNote = noteOf(parcel.vintageNote, "NormalizedParcel.vintageNote");
  const lookupNote = noteOf(lookup.vintageNote, "TownshipLookup.vintageNote");
  const parts: string[] = [];
  if (parcelNote !== null) parts.push("parcel: " + parcelNote);
  if (lookupNote !== null) parts.push("township: " + lookupNote);
  let vintageNote: string | null = parts.length === 0 ? null : parts.join("; ");
  if (vintageNote !== null && vintageNote.length > 500) {
    vintageNote = vintageNote.slice(0, 500);
  }

  return {
    provenance: provenance,
    vintageAsOf: vintageAsOf,
    vintageSourceType: vintageSourceType,
    vintageNote: vintageNote,
    pin: parcelPin,
    county: county,
    township: township,
    acres: acres,
    boundaryJson: boundaryJson,
  };
}
