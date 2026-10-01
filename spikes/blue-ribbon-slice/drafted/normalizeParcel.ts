// normalizeParcel: reduce one county's raw ArcGIS feature to NormalizedParcel.
//
// Everything below that is not a direct consequence of the two examples is a
// guess; the guesses are marked GUESS.

// Both examples divide the county's area field by exactly 43560 (square feet
// per acre): 163567.8 / 43560 = 3.755 and 370701 / 43560 = 8.510124...,
// matching the expected 3.755 and 8.51 once rounded to 3 decimals.
const SQFT_PER_ACRE = 43560;

// GUESS: the contract gives no as-of date derivable from the input, and both
// examples say 2026-08-30, so it is a constant. A pure function cannot read a
// clock, so a constant is the only option available anyway.
const VINTAGE_AS_OF = "2026-08-30";

// GUESS: both examples say "continuous"; nothing in the input determines it.
const VINTAGE_SOURCE_TYPE = "continuous";

const PROVENANCE_FOR_TRUST: Record<string, string> = {
  verified: "verified",
  aggregator: "aggregator",
};

// Per-county PIN field names, from the prose in the edge description.
const PIN_FIELDS = [
  "PIN",
  "TaxID",
  "parcelid",
  "BSA_PIN",
  "PARCELID",
  "Parcel_ID",
  "ParcelID",
  "TAXID",
  "pin",
];

// Area field names, in preference order. A precomputed acreage column wins
// outright (the prose says Manistee trusts its own ACRES field).
const ACRE_FIELDS = ["ACRES", "Acres", "acres"];
const AREA_FIELDS = ["Shape__Area", "Shape_Area", "SHAPE_Area", "Shape_area"];

// Suffixes stripped off a county "UNIT"-style township label. The one example
// turns "MIDDLE BRANCH TOWNSHIP" into "Middle Branch".
const TOWNSHIP_SUFFIXES = ["TOWNSHIP", "TWP.", "TWP", "CHARTER TOWNSHIP"];

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .split(" ")
    .filter(function (w) {
      return w.length > 0;
    })
    .map(function (w) {
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

function pickString(props: any, names: string[]): string | null {
  for (let i = 0; i < names.length; i++) {
    const v = props[names[i]];
    if (typeof v === "string" && v.trim().length > 0) return v.trim();
    if (typeof v === "number" && isFinite(v)) return String(v);
  }
  return null;
}

function pickNumber(props: any, names: string[]): number | null {
  for (let i = 0; i < names.length; i++) {
    const v = props[names[i]];
    if (typeof v === "number" && isFinite(v)) return v;
    if (typeof v === "string" && v.trim().length > 0 && isFinite(Number(v))) {
      return Number(v);
    }
  }
  return null;
}

// Canonical form: dash-separated. Source separators seen in the contract are
// spaces (Osceola) and dashes (Iosco); underscores and slashes are folded too.
function canonicalPin(raw: string): string {
  const pin = raw
    .trim()
    .replace(/[\s_/.]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (pin.length < 8 || pin.length > 40) {
    throw new Error(
      "normalizeParcel: canonical PIN " +
        JSON.stringify(pin) +
        " is " +
        pin.length +
        " characters, outside the declared 8..40",
    );
  }
  return pin;
}

function townshipFrom(props: any): string | null {
  const raw = pickString(props, ["UNIT", "Unit", "TOWNSHIP", "Township"]);
  if (raw === null) return null;
  let label = raw.toUpperCase().replace(/\s+/g, " ").trim();
  for (let i = 0; i < TOWNSHIP_SUFFIXES.length; i++) {
    const suffix = " " + TOWNSHIP_SUFFIXES[i];
    if (label.length > suffix.length && label.endsWith(suffix)) {
      label = label.slice(0, label.length - suffix.length).trim();
      break;
    }
  }
  if (label.length === 0) return null;
  const out = titleCase(label);
  return out.length > 100 ? out.slice(0, 100) : out;
}

export default function normalizeParcel(p: any) {
  if (p === null || typeof p !== "object") {
    throw new Error("normalizeParcel: input must be a RawParcelFeature object");
  }
  const county = p.county;
  const sourceTrust = p.sourceTrust;
  const featureJson = p.featureJson;

  if (typeof county !== "string" || county.length < 4 || county.length > 20) {
    throw new Error(
      "normalizeParcel: county must be a 4..20 character string, got " +
        JSON.stringify(county),
    );
  }
  if (!Object.prototype.hasOwnProperty.call(PROVENANCE_FOR_TRUST, sourceTrust)) {
    throw new Error(
      "normalizeParcel: sourceTrust must be 'verified' or 'aggregator', got " +
        JSON.stringify(sourceTrust),
    );
  }
  if (typeof featureJson !== "string") {
    throw new Error(
      "normalizeParcel: featureJson must be a string, got " + typeof featureJson,
    );
  }

  let feature: any;
  try {
    feature = JSON.parse(featureJson);
  } catch (e) {
    throw new Error(
      "normalizeParcel: featureJson is not parseable JSON; this node cannot " +
        "interpret an opaque payload it cannot decode",
    );
  }
  if (feature === null || typeof feature !== "object" || Array.isArray(feature)) {
    throw new Error(
      "normalizeParcel: featureJson must decode to an ArcGIS feature object",
    );
  }

  // ArcGIS/GeoJSON features carry attributes under `properties`; the ArcGIS
  // REST flavour uses `attributes`. Accept either, else treat the object
  // itself as the attribute bag.
  const props =
    feature.properties !== null && typeof feature.properties === "object"
      ? feature.properties
      : feature.attributes !== null && typeof feature.attributes === "object"
        ? feature.attributes
        : feature;

  const geometry = feature.geometry;
  if (geometry === null || typeof geometry !== "object") {
    throw new Error(
      "normalizeParcel: feature has no geometry; a parcel without a boundary " +
        "cannot produce a NormalizedParcel",
    );
  }

  const rawPin = pickString(props, PIN_FIELDS);
  if (rawPin === null) {
    throw new Error(
      "normalizeParcel: no recognised PIN field in the feature; looked for " +
        PIN_FIELDS.join(", "),
    );
  }
  const pin = canonicalPin(rawPin);

  let acres = pickNumber(props, ACRE_FIELDS);
  if (acres === null) {
    const area = pickNumber(props, AREA_FIELDS);
    if (area === null) {
      throw new Error(
        "normalizeParcel: no area field in the feature; looked for " +
          ACRE_FIELDS.concat(AREA_FIELDS).join(", "),
      );
    }
    acres = area / SQFT_PER_ACRE;
  }
  acres = round3(acres);
  // The declared property is `acres > 0`, and the schema caps it at 100000.
  // Either violation means the wrong units or the wrong spatial reference, so
  // decline rather than emit a value that is out of contract.
  if (!(acres > 0) || acres > 100000) {
    throw new Error(
      "normalizeParcel: computed acres " +
        acres +
        " is outside the declared (0, 100000]; the area field is in units " +
        "this node does not know how to convert",
    );
  }

  const boundaryJson = JSON.stringify(geometry);
  if (boundaryJson.length < 2 || boundaryJson.length > 2000000) {
    throw new Error(
      "normalizeParcel: serialized boundary is " +
        boundaryJson.length +
        " characters, outside the declared 2..2000000",
    );
  }

  // GUESS: the note text is reconstructed from the two examples -- "direct"
  // for verified, "via app.fetchgis.com proxy" for aggregator.
  const vintageNote =
    sourceTrust === "verified"
      ? county + " county FeatureServer, direct"
      : county + " county FeatureServer via app.fetchgis.com proxy";

  return {
    provenance: PROVENANCE_FOR_TRUST[sourceTrust],
    vintageAsOf: VINTAGE_AS_OF,
    vintageSourceType: VINTAGE_SOURCE_TYPE,
    vintageNote: vintageNote.length > 500 ? vintageNote.slice(0, 500) : vintageNote,
    pin: pin,
    county: county,
    townshipFromSource: townshipFrom(props),
    acres: acres,
    boundaryJson: boundaryJson,
  };
}
