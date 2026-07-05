// Offline matcher: assigns each GTFS shape an Elevation ("underground" |
// "surface" | "elevated") by sampling points along the shape and finding the
// nearest tagged OSM way (from osm-subway-ways.json), majority-voting across
// samples. Standalone CLI tool — output is committed static data, consumed
// optionally at server boot (core/interpolate.ts). Never run at runtime.
//
// Run: npm run preprocess:osm-match (after preprocess:nyc and preprocess:osm-layers)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Shape, Elevation } from "../shared/types.ts";

const DATA_DIR = join(process.cwd(), "data", "nyc");
const SAMPLE_SPACING_M = 150;
const MAX_MATCH_DIST_M = 40;
const MIN_MATCH_FRACTION = 0.4;

const M_PER_DEG_LAT = 111320;
function toXY(lon: number, lat: number, lat0: number): [number, number] {
  const k = Math.cos((lat0 * Math.PI) / 180);
  return [lon * k * M_PER_DEG_LAT, lat * M_PER_DEG_LAT];
}

interface OsmWay {
  id: number;
  tags: Record<string, string>;
  geometry: { lat: number; lon: number }[];
}

function wayElevation(tags: Record<string, string>): Elevation {
  const layer = tags.layer ? Number(tags.layer) : 0;
  if (tags.tunnel === "yes" || layer <= -1) return "underground";
  if (tags.bridge === "yes" || layer >= 1) return "elevated";
  return "surface";
}

/** distance in meters from point P to segment AB (all in local XY meters). */
function pointToSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const abx = bx - ax;
  const aby = by - ay;
  const len2 = abx * abx + aby * aby;
  let t = 0;
  if (len2 > 0) {
    t = ((px - ax) * abx + (py - ay) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
  }
  const cx = ax + t * abx;
  const cy = ay + t * aby;
  const dx = px - cx;
  const dy = py - cy;
  return Math.sqrt(dx * dx + dy * dy);
}

function main() {
  console.log("[osm-match] loading shapes.json + osm-subway-ways.json...");
  const shapes: Record<string, Shape> = JSON.parse(
    readFileSync(join(DATA_DIR, "shapes.json"), "utf8")
  );
  const ways: OsmWay[] = JSON.parse(
    readFileSync(join(DATA_DIR, "osm-subway-ways.json"), "utf8")
  );

  // Only ways carrying a usable tag are worth matching against.
  const taggedWays = ways
    .filter((w) => w.tags.layer || w.tags.tunnel || w.tags.bridge || w.tags.level)
    .map((w) => ({
      elevation: wayElevation(w.tags),
      // precompute a bbox for a cheap prefilter
      pts: w.geometry.map((g) => [g.lon, g.lat] as [number, number]),
    }))
    .map((w) => {
      const lons = w.pts.map((p) => p[0]);
      const lats = w.pts.map((p) => p[1]);
      return {
        ...w,
        minLon: Math.min(...lons),
        maxLon: Math.max(...lons),
        minLat: Math.min(...lats),
        maxLat: Math.max(...lats),
      };
    });
  console.log(`[osm-match] ${taggedWays.length} tagged OSM ways available for matching`);

  const BBOX_PAD_DEG = MAX_MATCH_DIST_M / M_PER_DEG_LAT + 0.001;

  function nearestWayElevation(lon: number, lat: number): Elevation | null {
    let best = Infinity;
    let bestElev: Elevation | null = null;
    for (const w of taggedWays) {
      if (
        lon < w.minLon - BBOX_PAD_DEG ||
        lon > w.maxLon + BBOX_PAD_DEG ||
        lat < w.minLat - BBOX_PAD_DEG ||
        lat > w.maxLat + BBOX_PAD_DEG
      ) {
        continue; // bbox prefilter
      }
      const P = toXY(lon, lat, lat);
      for (let i = 0; i < w.pts.length - 1; i++) {
        const A = toXY(w.pts[i][0], w.pts[i][1], lat);
        const B = toXY(w.pts[i + 1][0], w.pts[i + 1][1], lat);
        const d = pointToSegDist(P[0], P[1], A[0], A[1], B[0], B[1]);
        if (d < best) {
          best = d;
          bestElev = w.elevation;
        }
      }
    }
    return best <= MAX_MATCH_DIST_M ? bestElev : null;
  }

  const shapeElevation: Record<string, Elevation> = {};
  const counts: Record<Elevation, number> = { underground: 0, surface: 0, elevated: 0 };
  let matchedShapes = 0;

  const shapeIds = Object.keys(shapes);
  for (let i = 0; i < shapeIds.length; i++) {
    const shape = shapes[shapeIds[i]];
    const total = shape.cum[shape.cum.length - 1] ?? 0;
    const nSamples = Math.max(2, Math.round(total / SAMPLE_SPACING_M));
    const votes: Record<Elevation, number> = { underground: 0, surface: 0, elevated: 0 };
    let matched = 0;
    for (let s = 0; s <= nSamples; s++) {
      const d = (s / nSamples) * total;
      // find point at distance d (linear scan is fine offline, shapes are short)
      let lo = 0;
      while (lo < shape.cum.length - 1 && shape.cum[lo + 1] < d) lo++;
      const hi = Math.min(lo + 1, shape.pts.length - 1);
      const seg = shape.cum[hi] - shape.cum[lo] || 1;
      const t = (d - shape.cum[lo]) / seg;
      const lon = shape.pts[lo][0] + t * (shape.pts[hi][0] - shape.pts[lo][0]);
      const lat = shape.pts[lo][1] + t * (shape.pts[hi][1] - shape.pts[lo][1]);
      const elev = nearestWayElevation(lon, lat);
      if (elev) {
        votes[elev]++;
        matched++;
      }
    }
    if (matched / (nSamples + 1) >= MIN_MATCH_FRACTION) {
      const winner = (Object.keys(votes) as Elevation[]).reduce((a, b) =>
        votes[a] >= votes[b] ? a : b
      );
      shapeElevation[shapeIds[i]] = winner;
      counts[winner]++;
      matchedShapes++;
    }
    if ((i + 1) % 100 === 0) {
      console.log(`[osm-match] processed ${i + 1}/${shapeIds.length} shapes...`);
    }
  }

  const pct = ((matchedShapes / shapeIds.length) * 100).toFixed(1);
  console.log(
    `[osm-match] DONE. ${matchedShapes}/${shapeIds.length} shapes matched (${pct}%) — ` +
      `underground=${counts.underground} elevated=${counts.elevated} surface=${counts.surface}`
  );

  const p = join(DATA_DIR, "shapeElevation.json");
  writeFileSync(p, JSON.stringify(shapeElevation));
  console.log(`[osm-match] wrote ${p}`);
}

main();
