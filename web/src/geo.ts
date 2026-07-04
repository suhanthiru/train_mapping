// Client-side distance-along-shape <-> lon/lat (mirror of shared/geo.ts, kept
// local so the web bundle has no cross-package import).

export interface Shape {
  id: string;
  pts: [number, number][];
  cum: number[];
}

export function distToLonLat(shape: Shape, dist: number): [number, number] {
  const { pts, cum } = shape;
  if (dist <= 0) return pts[0];
  const total = cum[cum.length - 1];
  if (dist >= total) return pts[pts.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] <= dist) lo = mid;
    else hi = mid;
  }
  const seg = cum[hi] - cum[lo] || 1;
  const t = (dist - cum[lo]) / seg;
  return [
    pts[lo][0] + t * (pts[hi][0] - pts[lo][0]),
    pts[lo][1] + t * (pts[hi][1] - pts[lo][1]),
  ];
}

/** Compass-ish heading (deg) at a distance along the shape. */
export function bearingAt(shape: Shape, dist: number): number {
  const a = distToLonLat(shape, Math.max(0, dist - 20));
  const b = distToLonLat(shape, dist + 20);
  const dLon = ((b[0] - a[0]) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((b[1] * Math.PI) / 180);
  const x =
    Math.cos((a[1] * Math.PI) / 180) * Math.sin((b[1] * Math.PI) / 180) -
    Math.sin((a[1] * Math.PI) / 180) *
      Math.cos((b[1] * Math.PI) / 180) *
      Math.cos(dLon);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}
