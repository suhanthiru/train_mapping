// Preprocess NYC static GTFS -> compact geometry/lookup JSON (PROJECT_SPEC.md §4).
// Downloads the official subway GTFS zip, parses shapes/stops/routes/trips,
// precomputes cumulative distance along each shape, writes data/nyc/*.json.
//
// Run: npm run preprocess:nyc

import AdmZip from "adm-zip";
import { parse } from "csv-parse/sync";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Shape, Stop, RouteInfo, TripInfo } from "../shared/types.ts";
import { projectDist } from "../shared/geo.ts";

const GTFS_URL = "https://rrgtfsfeeds.s3.amazonaws.com/gtfs_subway.zip";
const OUT_DIR = join(process.cwd(), "data", "nyc");

// Haversine distance in meters between two [lon,lat] points.
function haversine(a: [number, number], b: [number, number]): number {
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

function normColor(hex: string | undefined, fallback: string): string {
  if (!hex) return fallback;
  const h = hex.trim().replace(/^#/, "");
  return /^[0-9a-fA-F]{6}$/.test(h) ? `#${h.toUpperCase()}` : fallback;
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log(`[nyc] downloading ${GTFS_URL} ...`);
  const res = await fetch(GTFS_URL);
  if (!res.ok) throw new Error(`GTFS download failed: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  console.log(`[nyc] downloaded ${(buf.length / 1e6).toFixed(2)} MB, unzipping...`);
  const zip = new AdmZip(buf);

  const read = (name: string): Record<string, string>[] => {
    const entry = zip.getEntry(name);
    if (!entry) throw new Error(`missing ${name} in GTFS zip`);
    return parse(entry.getData().toString("utf8"), {
      columns: true,
      skip_empty_lines: true,
      relax_column_count: true,
    });
  };

  // ---- routes.txt -> color/name table (real official MTA colors) ----
  const routesRaw = read("routes.txt");
  const routes: Record<string, RouteInfo> = {};
  for (const r of routesRaw) {
    routes[r.route_id] = {
      id: r.route_id,
      color: normColor(r.route_color, "#3FD8FF"),
      textColor: normColor(r.route_text_color, "#FFFFFF"),
      shortName: r.route_short_name || r.route_id,
      longName: r.route_long_name || "",
    };
  }
  console.log(`[nyc] routes: ${Object.keys(routes).length}`);

  // ---- shapes.txt -> polylines with cumulative distance ----
  const shapesRaw = read("shapes.txt");
  const byShape: Record<string, { seq: number; pt: [number, number] }[]> = {};
  for (const s of shapesRaw) {
    (byShape[s.shape_id] ??= []).push({
      seq: Number(s.shape_pt_sequence),
      pt: [Number(s.shape_pt_lon), Number(s.shape_pt_lat)],
    });
  }
  const shapes: Record<string, Shape> = {};
  for (const [id, arr] of Object.entries(byShape)) {
    arr.sort((a, b) => a.seq - b.seq);
    const pts = arr.map((x) => x.pt);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    }
    shapes[id] = { id, pts, cum };
  }
  console.log(`[nyc] shapes: ${Object.keys(shapes).length}`);

  // ---- stops.txt ----
  const stopsRaw = read("stops.txt");
  const stops: Record<string, Stop> = {};
  for (const s of stopsRaw) {
    stops[s.stop_id] = {
      id: s.stop_id,
      name: s.stop_name || s.stop_id,
      pos: [Number(s.stop_lon), Number(s.stop_lat)],
      parent: s.parent_station || undefined,
      connectedRoutes: [], // filled in a later pass (see NIGHTLY_LOG)
    };
  }
  console.log(`[nyc] stops: ${Object.keys(stops).length}`);

  // ---- trips.txt -> trip_id -> {routeId, shapeId, directionId} ----
  const tripsRaw = read("trips.txt");
  const trips: Record<string, TripInfo> = {};
  // Also build route_id + directionId -> representative shape for realtime
  // matching fallback (realtime trip_ids don't always match static ones).
  const routeDirShape: Record<string, string> = {};
  for (const t of tripsRaw) {
    if (!t.shape_id) continue;
    trips[t.trip_id] = {
      routeId: t.route_id,
      shapeId: t.shape_id,
      directionId: Number(t.direction_id ?? 0),
    };
    // Key by direction LETTER (N/S) parsed from the shape_id (e.g. "1..N03R"),
    // because realtime stop_ids carry the same N/S suffix — lets us resolve a
    // shape for realtime trips that aren't in the static trips table.
    const m = String(t.shape_id).match(/\.\.?([NS])/);
    const dir = m ? m[1] : Number(t.direction_id ?? 0) === 1 ? "S" : "N";
    const key = `${t.route_id}|${dir}`;
    if (!routeDirShape[key]) routeDirShape[key] = t.shape_id;
  }
  console.log(`[nyc] trips: ${Object.keys(trips).length}`);

  // ---- shapeStops: ordered [{id, dist}] per shape (for interpolation §6) ----
  // Pick one representative trip per shape, read its stop sequence from
  // stop_times.txt, project each stop onto the shape to get distance-along.
  const repTripForShape: Record<string, string> = {}; // shapeId -> trip_id
  const shapeOfTrip: Record<string, string> = {}; // trip_id -> shapeId (rep only)
  for (const t of tripsRaw) {
    if (!t.shape_id) continue;
    if (!repTripForShape[t.shape_id]) {
      repTripForShape[t.shape_id] = t.trip_id;
      shapeOfTrip[t.trip_id] = t.shape_id;
    }
  }
  console.log(`[nyc] reading stop_times.txt (filtering to ${Object.keys(repTripForShape).length} rep trips)...`);
  const stopTimesRaw = read("stop_times.txt");
  const seqByShape: Record<string, { stopId: string; seq: number }[]> = {};
  for (const st of stopTimesRaw) {
    const shapeId = shapeOfTrip[st.trip_id];
    if (!shapeId) continue; // not a representative trip
    (seqByShape[shapeId] ??= []).push({
      stopId: st.stop_id,
      seq: Number(st.stop_sequence),
    });
  }
  const shapeStops: Record<string, { id: string; dist: number }[]> = {};
  for (const [shapeId, seq] of Object.entries(seqByShape)) {
    seq.sort((a, b) => a.seq - b.seq);
    const shape = shapes[shapeId];
    if (!shape) continue;
    shapeStops[shapeId] = seq
      .map(({ stopId }) => {
        const stop = stops[stopId];
        if (!stop) return null;
        return { id: stopId, dist: projectDist(shape, stop.pos[0], stop.pos[1]) };
      })
      .filter((x): x is { id: string; dist: number } => x !== null);
  }
  console.log(`[nyc] shapeStops: ${Object.keys(shapeStops).length} shapes with ordered stops`);

  // ---- write outputs ----
  const write = (name: string, obj: unknown) => {
    const p = join(OUT_DIR, name);
    writeFileSync(p, JSON.stringify(obj));
    console.log(`[nyc] wrote ${name}`);
  };
  write("routes.json", routes);
  write("shapes.json", shapes);
  write("stops.json", stops);
  write("trips.json", trips);
  write("routeDirShape.json", routeDirShape);
  write("shapeStops.json", shapeStops);
  write("meta.json", {
    city: "nyc",
    generated: new Date().toISOString(),
    counts: {
      routes: Object.keys(routes).length,
      shapes: Object.keys(shapes).length,
      stops: Object.keys(stops).length,
      trips: Object.keys(trips).length,
    },
  });

  // sanity sample
  const sampleShapeId = Object.keys(shapes)[0];
  const ss = shapes[sampleShapeId];
  console.log(
    `[nyc] DONE. sample shape ${sampleShapeId}: ${ss.pts.length} pts, ` +
      `length ${(ss.cum[ss.cum.length - 1] / 1000).toFixed(2)} km`
  );
}

main().catch((e) => {
  console.error("[nyc] PREPROCESS FAILED:", e);
  process.exit(1);
});
