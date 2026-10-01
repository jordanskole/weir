// routeCounty: decide which trust path a parcel's county resolves through.
//
// Direct: Osceola, Manistee, Roscommon -> the county's own FeatureServer.
// Proxied: Iosco, Otsego -> transit app.fetchgis.com.
//
// NOTE (guess): only two of the five endpoint URLs appear anywhere in the
// contract (Osceola and Iosco, in the examples). Manistee, Roscommon and
// Otsego endpoints are fabricated by analogy with the two that are given.

const DIRECT: Record<string, string> = {
  Osceola:
    "https://services8.arcgis.com/FmKMwUEmDSC75SQm/arcgis/rest/services/OsceolaCountyParcels_view/FeatureServer/0/query",
  // GUESSED - not stated anywhere in the contract.
  Manistee:
    "https://services8.arcgis.com/FmKMwUEmDSC75SQm/arcgis/rest/services/ManisteeCountyParcels_view/FeatureServer/0/query",
  // GUESSED - not stated anywhere in the contract.
  Roscommon:
    "https://services8.arcgis.com/FmKMwUEmDSC75SQm/arcgis/rest/services/RoscommonCountyParcels_view/FeatureServer/0/query",
};

const PROXIED: Record<string, string> = {
  Iosco: "https://services3.arcgis.com/iosco/FeatureServer/0/query",
  // GUESSED - not stated anywhere in the contract.
  Otsego: "https://services3.arcgis.com/otsego/FeatureServer/0/query",
};

const PROXY_HOST = "app.fetchgis.com";

// The one Referer the contract shows is `?currentMap=iosco`, i.e. the county
// name lowercased. Otsego's is extrapolated from that single data point.
const REFERER: Record<string, string> = {
  Iosco: "https://app.fetchgis.com/?currentMap=iosco",
  Otsego: "https://app.fetchgis.com/?currentMap=otsego",
};

export default function routeCounty(p: any) {
  if (p === null || typeof p !== "object") {
    throw new Error("routeCounty: input must be a ParcelRequest object");
  }
  const pin = p.pin;
  const county = p.county;

  if (typeof pin !== "string") {
    throw new Error("routeCounty: pin must be a string, got " + typeof pin);
  }
  if (pin.length < 8 || pin.length > 40) {
    throw new Error(
      "routeCounty: pin must be 8..40 characters, got length " + pin.length,
    );
  }
  if (typeof county !== "string") {
    throw new Error(
      "routeCounty: county must be a string, got " + typeof county,
    );
  }

  if (Object.prototype.hasOwnProperty.call(DIRECT, county)) {
    return {
      edge: "DirectCountyQuery",
      payload: {
        pin: pin,
        county: county,
        endpoint: DIRECT[county],
      },
    };
  }

  if (Object.prototype.hasOwnProperty.call(PROXIED, county)) {
    return {
      edge: "ProxiedCountyQuery",
      payload: {
        pin: pin,
        county: county,
        endpoint: PROXIED[county],
        proxyHost: PROXY_HOST,
        referer: REFERER[county],
      },
    };
  }

  throw new Error(
    "routeCounty: no adapter for county " +
      JSON.stringify(county) +
      "; expected one of Osceola, Manistee, Roscommon, Iosco, Otsego",
  );
}
