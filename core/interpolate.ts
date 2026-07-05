// Interpolation core (PROJECT_SPEC.md §6): turn RawVehicle predictions into
// VehicleState { dist, speed } positions along a track shape.
//
// Placement model (stateless, self-correcting each tick):
//   - resolve the trip's shape (static trips table, else route+direction fallback)
//   - toDist  = distance-along-shape of the predicted next stop
//   - fromDist = distance of the previous stop on that shape (ordered shapeStops)
//   - estimate when it left fromStop from a typical subway speed, giving a
//     fraction of the segment traveled by `now`
//   - speed is set so the frontend tween arrives at the next stop on time
// The frontend does the 60fps tween + correction easing between ticks.

import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  RawVehicle,
  VehicleState,
  Shape,
  Stop,
  RouteInfo,
  TripInfo,
} from "../shared/types.ts";
import { projectDist, distToLonLat } from "../shared/geo.ts";

const TYPICAL_SPEED = 12; // m/s between subway stops, for departTime estimate
const DEFAULT_SEGMENT = 800; // m, fallback when previous stop is unknown

interface StaticData {
  shapes: Record<string, Shape>;
  stops: Record<string, Stop>;
  routes: Record<string, RouteInfo>;
  trips: Record<string, TripInfo>;
  routeDirShape: Record<string, string>;
  shapeStops: Record<string, { id: string; dist: number }[]>;
  shapesByRouteDir: Record<string, string[]>;
}

export function loadStatic(dir: string): StaticData {
  const rd = (f: string) => JSON.parse(readFileSync(join(dir, f), "utf8"));
  return {
    shapes: rd("shapes.json"),
    stops: rd("stops.json"),
    routes: rd("routes.json"),
    trips: rd("trips.json"),
    routeDirShape: rd("routeDirShape.json"),
    shapeStops: rd("shapeStops.json"),
    shapesByRouteDir: rd("shapesByRouteDir.json"),
  };
}

export class Interpolator {
  private shapeStopSet = new Map<string, Set<string>>(); // shapeId -> its stop ids, cached

  constructor(private s: StaticData, private city: "nyc" = "nyc") {}

  private stopSetFor(shapeId: string): Set<string> {
    let set = this.shapeStopSet.get(shapeId);
    if (!set) {
      set = new Set((this.s.shapeStops[shapeId] ?? []).map((e) => e.id));
      this.shapeStopSet.set(shapeId, set);
    }
    return set;
  }

  /**
   * Resolve the train's TRUE track (express vs local share a route+direction
   * but ride different physical shapes). Realtime trip_ids don't match static
   * ones for NYC, so we score every shape variant for this route+direction by
   * how many of the train's own known stops (next stop + upcoming list) it
   * contains — express/local stop patterns differ enough that this cleanly
   * discriminates. Falls back to the single default shape when there's too
   * little stop data to score confidently (§6.6, prevents wrong-track guesses).
   */
  private resolveShapeId(v: RawVehicle): string | null {
    const t = this.s.trips[v.tripId];
    if (t?.shapeId && this.s.shapes[t.shapeId]) return t.shapeId;

    const stopRef = v.toStopId ?? v.atStopId ?? "";
    const dir = /[NS]$/.test(stopRef) ? stopRef.slice(-1) : "N";
    const key = `${v.routeId}|${dir}`;
    const candidates = this.s.shapesByRouteDir[key];
    const fallback = this.s.routeDirShape[key];

    if (!candidates || candidates.length <= 1) {
      return fallback && this.s.shapes[fallback] ? fallback : null;
    }

    const known = new Set<string>();
    if (v.atStopId) known.add(v.atStopId);
    if (v.toStopId) known.add(v.toStopId);
    for (const u of v.upcoming ?? []) known.add(u.stopId);
    if (known.size < 2) return fallback && this.s.shapes[fallback] ? fallback : null; // too little to score

    let best: string | null = null;
    let bestScore = 0;
    for (const shapeId of candidates) {
      if (!this.s.shapes[shapeId]) continue;
      const set = this.stopSetFor(shapeId);
      let score = 0;
      for (const id of known) if (set.has(id)) score++;
      if (score > bestScore) { bestScore = score; best = shapeId; }
    }
    if (best && bestScore >= 2) return best; // confident match on real track pattern
    return fallback && this.s.shapes[fallback] ? fallback : null;
  }

  /** distance-along-shape of a stop, via shapeStops cache or live projection. */
  private stopDist(shapeId: string, stopId: string): number | null {
    const list = this.s.shapeStops[shapeId];
    if (list) {
      const hit = list.find((e) => e.id === stopId);
      if (hit) return hit.dist;
    }
    const stop = this.s.stops[stopId];
    if (!stop) return null;
    return projectDist(this.s.shapes[shapeId], stop.pos[0], stop.pos[1]);
  }

  /** previous stop's distance on this shape, before `toDist`. */
  private prevStopDist(shapeId: string, toDist: number): number | null {
    const list = this.s.shapeStops[shapeId];
    if (!list) return null;
    let prev: number | null = null;
    for (const e of list) {
      if (e.dist >= toDist - 1) break;
      prev = e.dist;
    }
    return prev;
  }

  /** first stop after a given distance (for labeling trains with no feed next-stop). */
  private nextStopAfter(shapeId: string, dist: number): string | null {
    const list = this.s.shapeStops[shapeId];
    if (!list) return null;
    for (const e of list) if (e.dist > dist + 1) return e.id;
    return null;
  }

  /** distance of the first stop after a given distance. */
  private nextStopDist(shapeId: string, dist: number): number | null {
    const list = this.s.shapeStops[shapeId];
    if (!list) return null;
    for (const e of list) if (e.dist > dist + 30) return e.dist;
    return null;
  }

  update(raws: RawVehicle[], now = Math.floor(Date.now() / 1000)): VehicleState[] {
    const out: VehicleState[] = [];
    for (const v of raws) {
      const shapeId = this.resolveShapeId(v);
      if (!shapeId) continue; // straight-line fallback deferred (see NIGHTLY_LOG)
      const shape = this.s.shapes[shapeId];
      const route = this.s.routes[v.routeId];

      let dist: number;
      let speed = 0;
      const age = Math.max(0, now - v.feedTimestamp); // seconds since this feed
      const toDist = v.toStopId ? this.stopDist(shapeId, v.toStopId) : null;
      const atDist = v.atStopId ? this.stopDist(shapeId, v.atStopId) : null;

      if (toDist != null && v.arriveTime && v.arriveTime > now && v.currentStatus !== "STOPPED_AT") {
        // in transit with a live future arrival — pace to arrive on time
        const fromDist =
          (v.fromStopId ? this.stopDist(shapeId, v.fromStopId) : null) ??
          this.prevStopDist(shapeId, toDist) ?? toDist - DEFAULT_SEGMENT;
        const segLen = Math.max(1, toDist - fromDist);
        const travelTime = segLen / TYPICAL_SPEED;
        const departTime = v.arriveTime - travelTime;
        const frac = Math.max(0, Math.min(1, (now - departTime) / travelTime));
        dist = fromDist + frac * segLen;
        speed = Math.min(25, Math.max(2, (toDist - dist) / (v.arriveTime - now)));
      } else if (v.currentStatus === "STOPPED_AT" && atDist != null) {
        // at a station: brief dwell, then glide toward the next stop (feed-anchored,
        // so position advances at exactly `speed` — consistent, no jitter)
        const nextD = this.nextStopDist(shapeId, atDist) ?? atDist + DEFAULT_SEGMENT;
        dist = Math.min(nextD, atDist + TYPICAL_SPEED * 0.7 * Math.max(0, age - 4));
        speed = dist < nextD - 5 ? TYPICAL_SPEED * 0.7 : 0;
      } else if (toDist != null) {
        // late / no live ETA but heading to a stop: glide toward it (feed-anchored)
        const fromDist = this.prevStopDist(shapeId, toDist) ?? toDist - DEFAULT_SEGMENT;
        const start = fromDist + 0.4 * (toDist - fromDist);
        dist = Math.min(toDist, start + TYPICAL_SPEED * age);
        speed = dist < toDist - 5 ? TYPICAL_SPEED : 0;
      } else if (atDist != null) {
        dist = atDist; // only know which stop it's near
      } else {
        continue; // nothing to anchor to
      }

      // next-stop label: use the feed's if present, else derive from geometry
      const nextStopId = v.toStopId ?? this.nextStopAfter(shapeId, dist) ?? undefined;
      const stale = now - v.feedTimestamp > 120;
      out.push({
        id: `${this.city}:${v.tripId}`,
        city: this.city,
        mode: "subway",
        route: route?.shortName ?? v.routeId,
        color: route?.color ?? "#3FD8FF",
        shapeId,
        dist,
        speed,
        elevation: "underground", // per-segment refinement is a later task
        nextStop: nextStopId,
        nextStopName: nextStopId ? this.s.stops[nextStopId]?.name : undefined,
        stale,
      });
    }
    return out;
  }
}

// --- standalone verification against the live feed ---
const isMain =
  process.argv[1] &&
  resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1]);
if (isMain) {
  const { fetchNycVehicles } = await import("../ingest/nyc.ts");
  const dir = join(process.cwd(), "data", "nyc");
  const stat = loadStatic(dir);
  const interp = new Interpolator(stat);
  const raws = await fetchNycVehicles();
  const states = interp.update(raws);

  const matched = raws.filter((v) => stat.trips[v.tripId]).length;
  console.log(
    `[core] ${raws.length} raw -> ${states.length} placed ` +
      `(${matched} matched static trips, ${raws.length - matched} via route+dir fallback)`
  );

  // sanity: positions should sit inside NYC bounds
  let inBounds = 0;
  for (const st of states) {
    const [lon, lat] = distToLonLat(stat.shapes[st.shapeId!], st.dist);
    if (lon > -74.3 && lon < -73.6 && lat > 40.4 && lat < 41.0) inBounds++;
  }
  console.log(`[core] ${inBounds}/${states.length} positions within NYC bounds`);
  const moving = states.filter((s) => s.speed > 0.1).length;
  const withNext = states.filter((s) => s.nextStopName).length;
  console.log(`[core] moving (speed>0): ${moving}/${states.length}; with next-stop label: ${withNext}`);

  for (const st of states.slice(0, 8)) {
    const [lon, lat] = distToLonLat(stat.shapes[st.shapeId!], st.dist);
    console.log(
      `  ${st.route.padEnd(3)} ${st.color} @ ${st.dist.toFixed(0).padStart(6)}m ` +
        `[${lon.toFixed(4)}, ${lat.toFixed(4)}] ${st.speed.toFixed(1)}m/s -> ${st.nextStopName ?? "?"}`
    );
  }
}
