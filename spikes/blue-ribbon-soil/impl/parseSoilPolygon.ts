export default function parseSoilPolygon(p) {
  const m = p.wkt.match(/^POLYGON\s*\(\((.*)\)\)$/);
  if (!m) throw new Error(`not a WKT POLYGON: ${p.wkt.slice(0, 40)}`);
  const vertices = {};
  m[1].split(",").forEach((pair, i) => {
    const [lng, lat] = pair.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
      throw new Error(`bad vertex "${pair}" at ${i}`);
    }
    vertices[String(i)] = { seq: i, lng, lat };
  });
  return { polygonId: p.polygonId, mukey: p.mukey, rings: { "0": { seq: 0, vertices } } };
}
