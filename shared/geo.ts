// Geometry helpers for projecting stops onto track shapes and converting
// distance-along-shape <-> lon/lat. Used by preprocess and the interpolation core.

import type { Shape } from "./types.ts";

const M_PER_DEG_LAT = 111320;

/** Local equirectangular projection to meters around a reference latitude. */
function toXY(lon: number, lat: number, lat0: number): [number, number] {
  const k = Math.cos((lat0 * Math.PI) / 180);
  return [lon * k * M_PER_DEG_LAT, lat * M_PER_DEG_LAT];
}

export function haversine(a: [number, number], b: [number, number]): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[1] - a[1]);
  const dLon = toRad(b[0] - a[0]);
  const lat1 = toRad(a[1]);
  const lat2 = toRad(b[1]);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/**
 * Project a point onto a shape polyline; return the cumulative distance
 * (meters, in the shape's `cum` space) of the closest point on the line.
 */
export function projectDist(shape: Shape, lon: number, lat: number): number {
  const lat0 = lat;
  const P = toXY(lon, lat, lat0);
  const { pts, cum } = shape;
  let best = Infinity;
  let bestDist = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const A = toXY(pts[i][0], pts[i][1], lat0);
    const B = toXY(pts[i + 1][0], pts[i + 1][1], lat0);
    const abx = B[0] - A[0];
    const aby = B[1] - A[1];
    const len2 = abx * abx + aby * aby;
    let t = 0;
    if (len2 > 0) {
      t = ((P[0] - A[0]) * abx + (P[1] - A[1]) * aby) / len2;
      t = Math.max(0, Math.min(1, t));
    }
    const cx = A[0] + t * abx;
    const cy = A[1] + t * aby;
    const dx = P[0] - cx;
    const dy = P[1] - cy;
    const d2 = dx * dx + dy * dy;
    if (d2 < best) {
      best = d2;
      bestDist = cum[i] + t * (cum[i + 1] - cum[i]);
    }
  }
  return bestDist;
}

/** Convert a distance-along-shape (meters) back to [lon, lat]. */
export function distToLonLat(shape: Shape, dist: number): [number, number] {
  const { pts, cum } = shape;
  if (dist <= 0) return pts[0];
  const total = cum[cum.length - 1];
  if (dist >= total) return pts[pts.length - 1];
  // binary search for the segment containing `dist`
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

/** Approximate compass bearing (deg) at a distance along the shape. */
export function bearingAt(shape: Shape, dist: number): number {
  const a = distToLonLat(shape, Math.max(0, dist - 15));
  const b = distToLonLat(shape, dist + 15);
  const y = Math.sin(((b[0] - a[0]) * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180);
  const x =
    Math.cos((a[1] * Math.PI) / 180) * Math.sin((b[1] * Math.PI) / 180) -
    Math.sin((a[1] * Math.PI) / 180) *
      Math.cos((b[1] * Math.PI) / 180) *
      Math.cos(((b[0] - a[0]) * Math.PI) / 180);
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}
