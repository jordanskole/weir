const METERS_PER_DEGREE = 111320.0;
const SQUARE_METERS_PER_ACRE = 4046.8564224;
export default function measureSoilPolygon(p) {
  const ring = Object.values(p.rings).find((r: any) => r.seq === 0) as any;
  const vs = Object.values(ring.vertices).sort((a: any, b: any) => a.seq - b.seq) as any[];
  let s = 0;
  for (let i = 0; i < vs.length - 1; i++) {
    s += vs[i].lng * vs[i + 1].lat - vs[i + 1].lng * vs[i].lat;
  }
  // abs(): SDA does not guarantee ring winding order, and a signed area is
  // negative for a clockwise ring. This is the property assertion's subject.
  const degSq = Math.abs(s) / 2;
  const n = vs.length - 1;
  const meanLat = vs.slice(0, n).reduce((a, v) => a + v.lat, 0) / n;
  const acres =
    (degSq * METERS_PER_DEGREE * METERS_PER_DEGREE * Math.cos((meanLat * Math.PI) / 180)) /
    SQUARE_METERS_PER_ACRE;
  return { polygonId: p.polygonId, mukey: p.mukey, acres: Math.round(acres * 1e6) / 1e6 };
}
