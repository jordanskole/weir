// parcelCentroid: area-weighted (shoelace) centroid of the parcel's exterior
// ring, as WGS84 lng/lat.

function ringOf(geometry: any): number[][] {
  const type = geometry.type;
  const coords = geometry.coordinates;
  if (!Array.isArray(coords)) {
    throw new Error("parcelCentroid: geometry.coordinates must be an array");
  }
  // Polygon: coordinates[0] is the exterior ring.
  // MultiPolygon: coordinates[0][0] is the first polygon's exterior ring.
  let ring: any;
  if (type === "MultiPolygon") {
    ring = Array.isArray(coords[0]) ? coords[0][0] : undefined;
  } else if (type === "Polygon" || type === undefined) {
    ring = coords[0];
  } else if (type === "LineString") {
    ring = coords;
  } else {
    throw new Error(
      "parcelCentroid: geometry type " +
        JSON.stringify(type) +
        " has no exterior ring to take a centroid of",
    );
  }
  if (!Array.isArray(ring) || ring.length < 3) {
    throw new Error(
      "parcelCentroid: exterior ring needs at least 3 positions, got " +
        (Array.isArray(ring) ? ring.length : typeof ring),
    );
  }
  const out: number[][] = [];
  for (let i = 0; i < ring.length; i++) {
    const pt = ring[i];
    if (
      !Array.isArray(pt) ||
      typeof pt[0] !== "number" ||
      typeof pt[1] !== "number" ||
      !isFinite(pt[0]) ||
      !isFinite(pt[1])
    ) {
      throw new Error(
        "parcelCentroid: ring position " + i + " is not a finite [lng, lat] pair",
      );
    }
    out.push([pt[0], pt[1]]);
  }
  return out;
}

export default function parcelCentroid(p: any) {
  if (p === null || typeof p !== "object") {
    throw new Error("parcelCentroid: input must be a NormalizedParcel object");
  }
  const pin = p.pin;
  if (typeof pin !== "string" || pin.length < 8 || pin.length > 40) {
    throw new Error(
      "parcelCentroid: pin must be an 8..40 character string, got " +
        JSON.stringify(pin),
    );
  }
  if (typeof p.boundaryJson !== "string") {
    throw new Error(
      "parcelCentroid: boundaryJson must be a string, got " +
        typeof p.boundaryJson,
    );
  }

  let geometry: any;
  try {
    geometry = JSON.parse(p.boundaryJson);
  } catch (e) {
    throw new Error(
      "parcelCentroid: boundaryJson is not parseable JSON, so there is no " +
        "polygon to take a centroid of",
    );
  }
  if (geometry === null || typeof geometry !== "object") {
    throw new Error(
      "parcelCentroid: boundaryJson must decode to a GeoJSON geometry object",
    );
  }

  const ring = ringOf(geometry);

  // Drop a duplicated closing vertex; the shoelace loop closes the ring itself.
  const n =
    ring.length > 3 &&
    ring[0][0] === ring[ring.length - 1][0] &&
    ring[0][1] === ring[ring.length - 1][1]
      ? ring.length - 1
      : ring.length;

  let twiceArea = 0;
  let cx = 0;
  let cy = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const cross = a[0] * b[1] - b[0] * a[1];
    twiceArea += cross;
    cx += (a[0] + b[0]) * cross;
    cy += (a[1] + b[1]) * cross;
    if (a[0] < minX) minX = a[0];
    if (a[0] > maxX) maxX = a[0];
    if (a[1] < minY) minY = a[1];
    if (a[1] > maxY) maxY = a[1];
  }

  let lng: number;
  let lat: number;
  if (twiceArea === 0) {
    // Degenerate ring (all collinear, or zero area). The shoelace centroid is
    // undefined; the vertex mean is still inside the bounding box, which is
    // what the stated property asks for.
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += ring[i][0];
      sy += ring[i][1];
    }
    lng = sx / n;
    lat = sy / n;
  } else {
    // Sign cancels, so this is correct for both winding orders.
    lng = cx / (3 * twiceArea);
    lat = cy / (3 * twiceArea);
  }

  // Guard the stated property explicitly: float error can push the result a
  // hair outside the bounding box of a very thin ring.
  if (lng < minX) lng = minX;
  if (lng > maxX) lng = maxX;
  if (lat < minY) lat = minY;
  if (lat > maxY) lat = maxY;

  if (lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new Error(
      "parcelCentroid: centroid (" +
        lng +
        ", " +
        lat +
        ") is not a WGS84 coordinate; the boundary is not in lng/lat",
    );
  }

  return { pin: pin, lng: lng, lat: lat };
}
