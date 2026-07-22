// Backend server: polls the live feed on a timer, interpolates, broadcasts
// vehicle state to all WebSocket clients, records history, and serves the
// static geometry the frontend loads. PROJECT_SPEC.md §4.
//
// Run: npm run server   (PORT env optional, default 8088)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { fetchNycVehicles } from "../ingest/nyc.ts";
import { fetchNycBuses } from "../ingest/nyc-bus.ts";
import { fetchNycAlerts } from "../ingest/nyc-alerts.ts";
import { Interpolator, loadStatic } from "../core/interpolate.ts";
import { haversine } from "../shared/geo.ts";
import { History } from "../history/db.ts";
import { PredictionLedger } from "../history/ledger.ts";
import { PORTS, nodeServiceUrls } from "../shared/config.ts";
import { postJson, bridgeStatus } from "./bridge.ts";
import type { VehicleState, RawVehicle } from "../shared/types.ts";

const PORT = Number(process.env.PORT ?? PORTS.train_3d_map);
const POLL_MS = 30_000; // how often we hit the live feed
const PUSH_MS = 4_000; // how often we re-interpolate + broadcast fresh positions
const WEATHER_MS = 5 * 60_000; // how often we sample the weather severity scalar
const ALERTS_MS = 2 * 60_000; // how often we snapshot active service alerts
// URLs from shared/config.ts (single source; 127.0.0.1-not-localhost rationale
// documented there). Docker overrides via env.
const { analyticsPy: ANALYTICS_PY, kalmanRs: KALMAN_RS } = nodeServiceUrls(process.env);
const ROOT = process.cwd();
const DATA_DIR = join(ROOT, "data");
const WEB_DIST = join(ROOT, "web", "dist");
const DOCS_DIR = join(ROOT, "docs"); // hub + architecture/explainer info pages

const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".glb": "model/gltf-binary",
  ".svg": "image/svg+xml",
};

const stat = loadStatic(join(DATA_DIR, "nyc"));
const interp = new Interpolator(stat);
const history = new History(join(DATA_DIR, "history.db"));
const ledger = new PredictionLedger(join(DATA_DIR, "ledger.db"));

// Stop positions + per-stop elevation, for buildSegments feature enrichment (Phase 2).
const stopPos: Record<string, [number, number]> = {};
for (const [id, s] of Object.entries(stat.stops)) stopPos[id] = s.pos;
const stopElev: Record<string, string> = {};
try {
  const shapeElev = JSON.parse(
    readFileSync(join(DATA_DIR, "nyc", "shapeElevation.json"), "utf8")
  ) as Record<string, string>;
  for (const [shapeId, elev] of Object.entries(shapeElev)) {
    for (const st of stat.shapeStops[shapeId] ?? []) stopElev[st.id] = elev;
  }
} catch { /* elevation data optional */ }

// Graph topology (Phase 1 output of the graph-ETA plan): the FOLLOWS canonical
// stop ordering per route+direction and the SHARES_TRACK junction zones. Used
// to overlay the live graph structure on the map (the "how the graph thinks"
// toggle) — no model involved, just which trains the graph would connect + why.
// Optional: absent until `python analytics-py/graph_edges.py` has been run.
let followsOrder: Record<string, Record<string, number>> = {};
interface ShareZone { route_a: string; route_b: string; direction: string; stops: Set<string> }
let shareZones: ShareZone[] = [];
try {
  const gdir = join(DATA_DIR, "exports", "graph");
  followsOrder = JSON.parse(readFileSync(join(gdir, "follows_order.json"), "utf8"));
  const rawZones = JSON.parse(readFileSync(join(gdir, "shares_track.json"), "utf8")) as any[];
  // trust only the stop-id-run zones for the live overlay (geometric-fallback
  // zones are flagged for manual review in the plan, not auto-trusted)
  shareZones = rawZones
    .filter((z) => z.source === "stopseq")
    .map((z) => ({ route_a: z.route_a, route_b: z.route_b, direction: z.direction, stops: new Set<string>(z.stop_ids) }));
  console.log(`[server] graph topology: ${Object.keys(followsOrder).length} FOLLOWS spines, ${shareZones.length} SHARES_TRACK zones`);
} catch { /* graph topology optional — run analytics-py/graph_edges.py to generate */ }

interface GraphEdge { a: string; b: string; type: "follows" | "shares"; metric: string }

// Compute the live graph edges among currently-visible trains: FOLLOWS (each
// train -> the next train ahead on its own route+direction) and SHARES_TRACK
// (a train -> the nearest cross-route train sharing its track at a junction).
// Cheap: O(n log n) for the FOLLOWS sort + a bounded scan per share-zone.
function computeGraphEdges(trains: VehicleState[]): GraphEdge[] {
  if (!Object.keys(followsOrder).length) return [];
  interface TI { id: string; route: string; dir: string; toStop: string; spinePos: number; pos: [number, number] | undefined }
  const info: TI[] = [];
  for (const t of trains) {
    if (!t.shapeId) continue;
    const hop = interp.currentHop(t.shapeId, t.dist);
    if (!hop) continue;
    const dir = hop.toStop.slice(-1);
    if (dir !== "N" && dir !== "S") continue;
    const order = followsOrder[`${t.route}|${dir}`];
    if (!order) continue;
    // linear position along the canonical spine: index of the stop being
    // approached, minus the fraction still to travel (so a train 0.3 into the
    // hop from stop 4 -> 5 sits at 4.3, strictly between the two stops)
    const toIdx = order[hop.toStop];
    if (toIdx === undefined) continue;
    const fromIdx = order[hop.fromStop];
    const spinePos = fromIdx !== undefined ? fromIdx + hop.frac : toIdx - (1 - hop.frac);
    info.push({ id: t.id, route: t.route, dir, toStop: hop.toStop, spinePos, pos: stopPos[hop.toStop] });
  }

  const edges: GraphEdge[] = [];
  // FOLLOWS: sort each route+direction group by spine position, link adjacent
  const byRD = new Map<string, TI[]>();
  for (const x of info) {
    const k = `${x.route}|${x.dir}`;
    let arr = byRD.get(k);
    if (!arr) { arr = []; byRD.set(k, arr); }
    arr.push(x);
  }
  for (const arr of byRD.values()) {
    arr.sort((p, q) => p.spinePos - q.spinePos);
    for (let i = 0; i + 1 < arr.length; i++) {
      const gap = arr[i + 1].spinePos - arr[i].spinePos;
      edges.push({ a: arr[i].id, b: arr[i + 1].id, type: "follows", metric: `${gap.toFixed(1)} stops apart` });
    }
  }
  // SHARES_TRACK: within each junction zone, link each route_a train currently
  // in the zone to the geographically-nearest route_b train also in the zone
  for (const z of shareZones) {
    const inA = info.filter((x) => x.route === z.route_a && x.dir === z.direction && z.stops.has(x.toStop));
    const inB = info.filter((x) => x.route === z.route_b && x.dir === z.direction && z.stops.has(x.toStop));
    if (!inA.length || !inB.length) continue;
    for (const a of inA) {
      let best: TI | undefined;
      let bestD = Infinity;
      for (const b of inB) {
        if (!a.pos || !b.pos) continue;
        const d = haversine(a.pos, b.pos);
        if (d < bestD) { bestD = d; best = b; }
      }
      if (best) edges.push({ a: a.id, b: best.id, type: "shares", metric: `${z.route_a}/${z.route_b} shared track` });
    }
  }
  return edges;
}

let latest: VehicleState[] = [];
let lastRaws: RawVehicle[] = [];
let lastBuses: VehicleState[] = [];
let kalmanInFlight = false; // guard: never stack overlapping Kalman round-trips
let lastWeatherScore = 0; // reused by modelPredictTick so it doesn't need its own DB/HTTP round-trip

// Latest Kalman-derived hop state per trip (frac into current hop + speed +
// congestion), refreshed every 4s push tick by logVehicleState. model-v2 reads
// this so its "remaining time in the current hop" prediction uses the same
// numbers the forward-only vehicle_log trained on — measure and serve from one
// source, no re-derivation.
interface HopState { fromStop: string; toStop: string; frac: number; speed: number; ahead: number; ts: number }
const lastHopState = new Map<string, HopState>();
// P4 anomaly detection: when each trip ENTERED its current hop (elapsed = now -
// entry.ts), and the latest flagged anomalies (tripId -> scored row) for the
// /api/anomalies endpoint + the WS anomaly flag on the map.
interface HopEntry { toStop: string; route: string; ts: number }
const hopEntry = new Map<string, HopEntry>();
interface ScoredAnomaly {
  id: string; route_id: string; from_stop: string; to_stop: string;
  observed_sec: number; scheduled_sec: number | null; deviation_sec: number | null;
  is_anomaly: boolean; alert_active: boolean;
  likely_cause: { cause: string; incidents_per_month: number } | null;
}
let currentAnomalies = new Map<string, ScoredAnomaly>();
let lastFeedOkTs = 0; // epoch s of the last successful feed poll (observability)
// /api/prediction-accuracy memo (per source) — see the handler for why.
const accCache = new Map<string, { at: number; body: string }>();

// Poll the live feeds (slow): just refreshes raw predictions/GPS. Does NOT
// call interp.update() — that would silently advance the same continuity
// state pushTick's clamp depends on, letting stacked "invisible" advances
// between broadcasts add up to more distance than any single broadcast
// interval should allow (verified live: this caused ~29 m/s implied jumps
// between consecutive pushes despite each individual step being clamped).
async function fetchTick() {
  try {
    const [raws, buses] = await Promise.all([fetchNycVehicles(), fetchNycBuses()]);
    lastRaws = raws;
    lastBuses = buses;
    lastFeedOkTs = Math.floor(Date.now() / 1000); // observability: feed freshness
    console.log(`[server] feed: ${lastRaws.length} trains + ${lastBuses.length} buses -> ${wss.clients.size} clients`);
    // Prediction ledger (bitemporal): log the feed's evolving ETAs + ground
    // truth on the 30s poll grain. Isolated in try/catch so a ledger hiccup
    // never disrupts the live feed / broadcast path.
    try {
      ledger.recordPredictions(lastRaws);
      ledger.recordActuals(lastRaws);
    } catch (e) {
      console.error("[server] ledger error:", (e as Error).message);
    }
    await modelPredictTick(lastRaws);
  } catch (e) {
    console.error("[server] feed error:", (e as Error).message);
  }
}

// Slow weather sampler: pull the 0-100 severity scalar from the Python service
// into the ledger as an ETA-model feature. Degrades to a gap (never a crash) if
// the Python service is down.
async function weatherTick() {
  try {
    const r = await fetch(`${ANALYTICS_PY}/weather-score`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const w = (await r.json()) as { severity?: number; tempF?: number; precipitating?: boolean; conditions?: string };
    lastWeatherScore = w.severity ?? 0;
    ledger.recordConditions(
      Math.floor(Date.now() / 1000),
      w.severity ?? null,
      w.tempF ?? null,
      Boolean(w.precipitating),
      w.conditions ?? null
    );
  } catch (e) {
    console.error("[server] weather sample skipped:", (e as Error).message);
  }
}

// Forward-only logger (Phase 1): snapshot active service alerts (which lines are
// slow/delayed/rerouted right now). Degrades to a gap if the feed is down.
async function alertsTick() {
  try {
    const alerts = await fetchNycAlerts();
    ledger.recordAlerts(Math.floor(Date.now() / 1000), alerts);
  } catch (e) {
    console.error("[server] alerts sample skipped:", (e as Error).message);
  }
}

// Bridge the ETA model's per-segment duration predictions into arrival-time
// predictions, logged as source='model-v1' in the SAME ledger table the feed's
// predictions use — so accuracyByLeadTime()/accuracyTrend() grade both
// identically for the feed-vs-model head-to-head. For each vehicle, chain the
// model's hop-by-hop duration guesses (anchor -> upcoming[0] -> upcoming[1]...)
// into cumulative arrival times, in one batched call (mirrors kalman-rs's
// POST /filter batch shape) so a tick with hundreds of trains is one request.

// Cap how many upcoming hops model-v1 chains + logs per train per tick. A train
// can have ~30 upcoming stops; logging a chained ETA for every one of them every
// tick is what made model-v1 74% of the ledger (24M rows), and those far-future
// chained hops are the high-bias, low-value ones (see I10). Short-lead accuracy
// is what matters, and capping here also shrinks the /predict-batch payload sent
// to analytics-py. Retention stays 30 days — this only reduces write volume,
// never deletes existing history.
const MODEL_V1_MAX_HOPS = 3;
async function modelPredictTick(raws: RawVehicle[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const nowDate = new Date(now * 1000);
  const hour = nowDate.getHours();
  const dow = nowDate.getDay();

  interface HopReq { id: string; route_id: string; from_stop: string; to_stop: string; hour: number; dow: number; weather_score: number; distance_m: number; elevation: string }
  interface VehHops { tripId: string; routeId: string; feedTimestamp: number; hopIds: string[]; targetStops: string[] }

  const hopReqs: HopReq[] = [];
  const vehHops: VehHops[] = [];

  for (const v of raws) {
    if (!v.upcoming?.length) continue;
    const anchor = v.atStopId ?? v.toStopId ?? v.fromStopId;
    if (!anchor) continue; // nothing to chain the first hop from — skip this tick
    const hopIds: string[] = [];
    const targetStops: string[] = [];
    const maxHops = Math.min(v.upcoming.length, MODEL_V1_MAX_HOPS);
    for (let i = 0; i < maxHops; i++) {
      const to = v.upcoming[i].stopId;
      if (!to) continue;
      const from = i === 0 ? anchor : v.upcoming[i - 1].stopId;
      const id = `${v.tripId}|${i}`;
      // distance + elevation must match how buildSegments computes them (Phase 2)
      const pf = stopPos[from];
      const pt = stopPos[to];
      const distance_m = pf && pt ? Math.round(haversine(pf, pt)) : 0;
      const elevation = stopElev[to] ?? stopElev[from] ?? "underground";
      hopReqs.push({
        id, route_id: v.routeId, from_stop: from, to_stop: to,
        hour, dow, weather_score: lastWeatherScore, distance_m, elevation,
      });
      hopIds.push(id);
      targetStops.push(to);
    }
    if (hopIds.length) vehHops.push({ tripId: v.tripId, routeId: v.routeId, feedTimestamp: v.feedTimestamp, hopIds, targetStops });
  }
  if (!hopReqs.length) return;

  try {
    // via the circuit-breaker bridge (P3): a down analytics-py costs one open
    // circuit instead of a 5s abort on every 30s tick.
    const preds = await postJson<{ id: string; predicted_travel_sec: number }[]>(
      `${ANALYTICS_PY}/predict-batch`, hopReqs, { name: "predict-batch" });
    if (!preds) return; // model not trained / service down / circuit open — skip quietly
    const byId = new Map(preds.map((p) => [p.id, p.predicted_travel_sec]));

    const rows: { tripId: string; stopId: string; routeId: string; predArrival: number; observedAt: number }[] = [];
    for (const veh of vehHops) {
      let cumulative = 0;
      for (let i = 0; i < veh.hopIds.length; i++) {
        const d = byId.get(veh.hopIds[i]);
        if (d == null) break; // missing prediction — stop chaining further stops for this trip
        cumulative += d;
        rows.push({
          tripId: veh.tripId, stopId: veh.targetStops[i], routeId: veh.routeId,
          predArrival: now + Math.round(cumulative), observedAt: veh.feedTimestamp,
        });
      }
    }
    ledger.recordModelPredictions(rows);

    // ---- model-v2 (the late-bias fix): the v1 chain above adds the FULL
    // duration of the hop the train is already inside — a train 70% through a
    // 120s hop still gets all 120s, so every downstream arrival lands ~84s
    // late (measured: 85-130s late bias at short leads). v2 asks the
    // remaining-time model "given frac_hop/speed/congestion, how many seconds
    // REMAIN in the current hop?", then chains v1's full durations for the
    // not-yet-started hops. Both sources log side by side (source column) so
    // accuracyByLeadTime grades the A/B with zero backtest changes. ----
    await modelV2Tick(now, hour, dow, vehHops, byId);
  } catch (e) {
    console.error("[server] model prediction skipped:", (e as Error).message);
  }
}

interface VehHopsT { tripId: string; routeId: string; feedTimestamp: number; hopIds: string[]; targetStops: string[] }

async function modelV2Tick(
  now: number, hour: number, dow: number,
  vehHops: VehHopsT[], v1ById: Map<string, number>
): Promise<void> {
  try {
    // One remaining-time request per vehicle whose live hop state matches the
    // hop we're chaining from (guards against stale/reroute mismatches). No
    // match -> no v2 row for that vehicle: honest gaps beat fabricated ones.
    interface RemReq {
      id: string; route_id: string; from_stop: string; to_stop: string;
      hour: number; dow: number; weather_score: number; distance_m: number;
      elevation: string; frac_hop: number; kalman_speed: number; trains_ahead: number;
    }
    const reqs: RemReq[] = [];
    const eligible: VehHopsT[] = [];
    for (const veh of vehHops) {
      const hs = lastHopState.get(veh.tripId);
      if (!hs || now - hs.ts > 30) continue; // no fresh Kalman hop state
      if (hs.toStop !== veh.targetStops[0]) continue; // hop mismatch (reroute/lag)
      const pf = stopPos[hs.fromStop];
      const pt = stopPos[hs.toStop];
      reqs.push({
        id: veh.tripId, route_id: veh.routeId,
        from_stop: hs.fromStop, to_stop: hs.toStop, hour, dow,
        weather_score: lastWeatherScore,
        distance_m: pf && pt ? Math.round(haversine(pf, pt)) : 0,
        elevation: stopElev[hs.toStop] ?? stopElev[hs.fromStop] ?? "underground",
        frac_hop: hs.frac, kalman_speed: hs.speed, trains_ahead: hs.ahead,
      });
      eligible.push(veh);
    }
    if (!reqs.length) return;

    const rem = await postJson<{ id: string; remaining_sec: number }[]>(
      `${ANALYTICS_PY}/predict-remaining`, reqs, { name: "predict-remaining" });
    if (!rem) return; // v2 not trained yet / circuit open — quiet skip
    const remById = new Map(rem.map((p) => [p.id, p.remaining_sec]));

    const rows: { tripId: string; stopId: string; routeId: string; predArrival: number; observedAt: number }[] = [];
    for (const veh of eligible) {
      const r0 = remById.get(veh.tripId);
      if (r0 == null) continue;
      let cumulative = Math.max(0, r0); // remaining time in the CURRENT hop
      rows.push({
        tripId: veh.tripId, stopId: veh.targetStops[0], routeId: veh.routeId,
        predArrival: now + Math.round(cumulative), observedAt: veh.feedTimestamp,
      });
      for (let i = 1; i < veh.hopIds.length; i++) {
        const d = v1ById.get(veh.hopIds[i]); // future hops: full durations (v1)
        if (d == null) break;
        cumulative += d;
        rows.push({
          tripId: veh.tripId, stopId: veh.targetStops[i], routeId: veh.routeId,
          predArrival: now + Math.round(cumulative), observedAt: veh.feedTimestamp,
        });
      }
    }
    if (rows.length) ledger.recordModelPredictions(rows, "model-v2");
  } catch (e) {
    console.error("[server] model-v2 skipped:", (e as Error).message);
  }
}

// Single source of truth: re-interpolate + broadcast + record history from
// the SAME computation, so continuity is judged only against what viewers
// actually see. The Kalman sidecar (Phase 2) refines the clamp output with a
// principled estimate + uncertainty; if it's down/slow the clamp output stands.
async function pushTick() {
  const now = Math.floor(Date.now() / 1000);
  const trains = interp.update(lastRaws, now);
  await applyKalman(trains, now);
  // P4: flag currently-anomalous trips so the map can highlight them live
  for (const t of trains) t.anomaly = currentAnomalies.has(t.id.replace(/^nyc:/, "")) || undefined;
  latest = [...trains, ...lastBuses];
  history.record(now, trains);
  logVehicleState(trains, now);
  broadcast({ type: "state", city: "nyc", ts: now, vehicles: latest, graphEdges: computeGraphEdges(trains) });
}

const CONGEST_WINDOW_M = 1200; // same-shape trains within this many meters ahead = congestion

// Forward-only logger (Phase 1): Kalman progress into the current hop + live
// congestion, per subway train. Change-detected inside the ledger. try/catch
// so a logging hiccup never disrupts the broadcast.
function logVehicleState(trains: VehicleState[], now: number): void {
  try {
    const byShape = new Map<string, VehicleState[]>();
    for (const t of trains) {
      if (!t.shapeId) continue;
      let arr = byShape.get(t.shapeId);
      if (!arr) { arr = []; byShape.set(t.shapeId, arr); }
      arr.push(t);
    }
    const rows = [];
    for (const t of trains) {
      if (!t.shapeId) continue;
      const hop = interp.currentHop(t.shapeId, t.dist);
      if (!hop) continue;
      const peers = byShape.get(t.shapeId)!;
      let ahead = 0;
      for (const p of peers) if (p !== t && p.dist > t.dist && p.dist <= t.dist + CONGEST_WINDOW_M) ahead++;
      rows.push({
        ts: now,
        tripId: t.id.replace(/^nyc:/, ""),
        route: t.route,
        fromStop: hop.fromStop,
        toStop: hop.toStop,
        fracHop: hop.frac,
        kalmanSpeed: t.speed,
        uncertainty: t.uncertainty ?? 0,
        trainsAhead: ahead,
      });
      const tid = t.id.replace(/^nyc:/, "");
      lastHopState.set(tid, {
        fromStop: hop.fromStop, toStop: hop.toStop, frac: hop.frac,
        speed: t.speed, ahead, ts: now,
      });
      // hop-entry tracking (P4 anomaly detection): first tick we see this trip
      // on this hop = the hop's start; observed_sec = now - entry.
      const entry = hopEntry.get(tid);
      if (!entry || entry.toStop !== hop.toStop) {
        hopEntry.set(tid, { toStop: hop.toStop, route: t.route, ts: now });
      }
    }
    if (rows.length) ledger.recordVehicleLog(rows);
  } catch (e) {
    console.error("[server] vehicle_log skipped:", (e as Error).message);
  }
}

// Plain-English framing for a live anomaly: states that something's
// happening right now, why (likely cause), and — the P4.1 addition — how
// long it should take based on past episodes of the same (route, cause).
// The ONE place duration stats become a sentence a non-technical rider can
// act on; mirrors dashboard/app.js's Simple-mode phrasing convention.
function anomalySummary(
  a: ScoredAnomaly,
  typical: { medianSec: number; n: number; scope: "route" | "cause" } | null
): string {
  const route = a.route_id ?? "a train";
  const where = a.from_stop && a.to_stop ? ` near ${a.from_stop}→${a.to_stop}` : "";
  const why = a.likely_cause?.cause ? ` — likely ${a.likely_cause.cause}` : "";
  const base = `${route} is running slower than scheduled${where}${why}.`;
  if (!typical) return `${base} Not enough similar past incidents yet to estimate how long this will take.`;
  const mins = Math.max(1, Math.round(typical.medianSec / 60));
  const basis = typical.scope === "route" ? `${typical.n} similar incidents on route ${route}` : `${typical.n} similar incidents (any route)`;
  return `${base} Based on ${basis} in the last 30 days, this typically clears within ~${mins} min.`;
}

// P4: score in-progress hops against historical schedule baselines
// (analytics-py /anomaly/hop — deviation vs scheduled hop time, alert
// cross-reference, likely cause). Only hops slow enough to possibly flag are
// sent (observed >= 90s; the scorer's floor is ratio 1.5x AND +45s). Flagged
// episodes persist to anomalies_log; the current set feeds /api/anomalies and
// the map's anomaly highlight. Goes through the P3 circuit-breaker bridge, so
// a down analytics-py costs nothing.
async function anomalyTick(): Promise<void> {
  try {
    const now = Math.floor(Date.now() / 1000);
    const reqs: { id: string; route_id: string; from_stop: string; to_stop: string; ts: number; observed_sec: number }[] = [];
    for (const [tid, entry] of hopEntry) {
      const hs = lastHopState.get(tid);
      if (!hs || now - hs.ts > 60) { hopEntry.delete(tid); continue; } // trip gone — drop entry
      const observed = now - entry.ts;
      if (observed < 90) continue; // can't flag yet (scorer floor) — skip the wire
      reqs.push({
        id: tid, route_id: entry.route, from_stop: hs.fromStop,
        to_stop: hs.toStop, ts: now, observed_sec: observed,
      });
    }
    if (!reqs.length) {
      currentAnomalies = new Map();
      try { ledger.resolveAnomalies(new Set(), now); } // nothing tracked -> close everything open
      catch (e) { console.error("[anomaly] resolve skipped:", (e as Error).message); }
      return;
    }

    const scored = await postJson<ScoredAnomaly[]>(
      `${ANALYTICS_PY}/anomaly/hop`, reqs, { name: "anomaly-hop" });
    if (!scored) return; // warming / circuit open — keep previous set, don't resolve (state unknown)

    const next = new Map<string, ScoredAnomaly>();
    for (const s of scored) if (s.is_anomaly) next.set(s.id, s);
    currentAnomalies = next;

    // close out episodes that dropped off the active set this tick — that's
    // what gives typicalDurationSec() real "how long did it take" samples.
    const activeKeys = new Set([...next.values()].map((s) => `${s.id}|${s.to_stop ?? ""}`));
    try { ledger.resolveAnomalies(activeKeys, now); }
    catch (e) { console.error("[anomaly] resolve skipped:", (e as Error).message); }

    if (next.size) {
      const logged = ledger.recordAnomalies([...next.values()].map((s) => ({
        ts: now, tripId: s.id, routeId: s.route_id, fromStop: s.from_stop,
        toStop: s.to_stop, observedSec: Math.round(s.observed_sec),
        scheduledSec: s.scheduled_sec != null ? Math.round(s.scheduled_sec) : null,
        deviationSec: s.deviation_sec != null ? Math.round(s.deviation_sec) : null,
        alertActive: s.alert_active, cause: s.likely_cause?.cause ?? null,
      })));
      if (logged) console.log(`[anomaly] ${next.size} active (${logged} new episodes logged)`);
    }
  } catch (e) {
    console.error("[anomaly] tick skipped:", (e as Error).message);
  }
}

// Send the raw (pre-clamp) measured positions to the Rust Kalman service and
// overwrite dist/speed with the filtered estimate + attach uncertainty. Any
// failure (service down, timeout, in-flight) leaves the clamp output untouched.
async function applyKalman(trains: VehicleState[], now: number): Promise<void> {
  if (kalmanInFlight) return;
  const meas = trains
    .filter((t) => t.measuredDist != null)
    .map((t) => ({ id: t.id, measuredDist: t.measuredDist, ts: now }));
  if (!meas.length) return;
  kalmanInFlight = true;
  try {
    const r = await fetch(`${KALMAN_RS}/filter`, {
      method: "POST",
      body: JSON.stringify(meas),
      signal: AbortSignal.timeout(1500),
    });
    if (!r.ok) return;
    const filtered = (await r.json()) as {
      id: string;
      filteredDist: number;
      velocity: number;
      variance: number;
    }[];
    const byId = new Map(filtered.map((f) => [f.id, f]));
    for (const t of trains) {
      const f = byId.get(t.id);
      if (!f) continue;
      t.dist = f.filteredDist;
      t.speed = f.velocity;
      t.uncertainty = Math.sqrt(Math.max(0, f.variance));
    }
  } catch {
    // Kalman down/slow -> keep the clamp output (graceful degrade)
  } finally {
    kalmanInFlight = false;
  }
}

// --- HTTP: static geometry + built frontend ---
const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (url === "/health") {
    res.writeHead(200).end(JSON.stringify({ ok: true, vehicles: latest.length, bridge: bridgeStatus() }));
    return;
  }

  // P4: schedule-deviation anomalies — current flagged trips + recent episode
  // history (anomalies_log). The dashboard's anomaly panel + ops row read this;
  // complementary to analytics-go :8090/anomalies (live headway bunching/gaps).
  if (url === "/api/anomalies") {
    const current = [...currentAnomalies.values()].map((a) => {
      let typical: ReturnType<typeof ledger.typicalDurationSec> = null;
      try { typical = ledger.typicalDurationSec(a.route_id, a.likely_cause?.cause ?? null); }
      catch (e) { console.error("[anomaly] duration lookup failed:", (e as Error).message); }
      return { ...a, typical_duration: typical, summary: anomalySummary(a, typical) };
    });
    let recent: Record<string, unknown>[] = [];
    try { recent = ledger.recentAnomalies(); }
    catch (e) { console.error("[anomaly] recent query failed:", (e as Error).message); }
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ current, recent })
    );
    return;
  }

  // A single train's upcoming stops + ETAs (for the click-a-train journey panel).
  if (url === "/api/trip") {
    const id = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("id") ?? "";
    const tripId = id.replace(/^nyc:/, "");
    const now = Math.floor(Date.now() / 1000);
    const v = lastRaws.find((r) => r.tripId === tripId);
    const stops = (v?.upcoming ?? [])
      .map((u) => ({ name: stat.stops[u.stopId]?.name ?? u.stopId, etaSec: u.time - now }))
      .filter((s) => s.etaSec > -45);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        route: v ? stat.routes[v.routeId]?.shortName ?? v.routeId : "?",
        color: v ? stat.routes[v.routeId]?.color ?? "#3FD8FF" : "#3FD8FF",
        dest: stops.length ? stops[stops.length - 1].name : undefined,
        stops,
      })
    );
    return;
  }

  // Offline graph-ETA experiment results (Baseline/Graph A/B/C residual GNN).
  // Served straight from the Parquet-adjacent JSON the experiment writes; the
  // experiment itself never touches the live ledger, so this is read-only glass
  // onto a frozen result. Absent until analytics-py/graph_experiment.py has run.
  if (url === "/api/graph-experiment") {
    try {
      const body = readFileSync(join(DATA_DIR, "exports", "graph", "experiment_report.json"), "utf8");
      res.writeHead(200, { "Content-Type": "application/json" }).end(body);
    } catch {
      res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ available: false }));
    }
    return;
  }

  // Hourly throughput — uptime at a glance: a live/collecting hour has nonzero
  // feed + vehicleLog; a zero hour means the pipeline wasn't running or the
  // feed was unreachable, not that no trains moved.
  if (url === "/api/throughput") {
    const hours = Number(new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("hours")) || 24;
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ hours: ledger.hourlyThroughput(Math.min(hours, 168)) })
    );
    return;
  }

  // Backtest read-out: feed-prediction accuracy (MAE + bias) vs. lead time.
  // 60s memo: the dashboard polls this for 3 sources every 15s (Simple mode
  // doubles that), and both accuracyByLeadTime and counts() are synchronous
  // multi-hundred-ms scans on node:sqlite — without the memo they stack up
  // and starve the event loop (observed live; see fixed_errors.md I8).
  if (url === "/api/prediction-accuracy") {
    const source = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("source") ?? "gtfs-rt";
    const nowMs = Date.now();
    const hit = accCache.get(source);
    if (hit && nowMs - hit.at < 60_000) {
      res.writeHead(200, { "Content-Type": "application/json" }).end(hit.body);
      return;
    }
    const body = JSON.stringify({ source, counts: ledger.counts(), buckets: ledger.accuracyByLeadTime(source) });
    accCache.set(source, { at: nowMs, body });
    res.writeHead(200, { "Content-Type": "application/json" }).end(body);
    return;
  }

  // --- dashboard (Phase 4) read endpoints over the ledger ---
  if (url === "/api/accuracy-trend") {
    const source = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("source") ?? "gtfs-rt";
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ source, points: ledger.accuracyTrend(source) })
    );
    return;
  }
  if (url === "/api/system-health") {
    // Observability: everything you need to know the pipeline is alive, in one
    // read — feed freshness, write rates, live counts. A silent stall shows up
    // here in minutes instead of weeks.
    const now = Math.floor(Date.now() / 1000);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        now,
        feedAgeSec: lastFeedOkTs ? now - lastFeedOkTs : null,
        trains: lastRaws.length,
        buses: lastBuses.length,
        wsClients: wss.clients.size,
        writeRates: ledger.writeRates(now),
        counts: ledger.counts(),
      })
    );
    return;
  }
  if (url === "/api/feature-stats") {
    const feature = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("feature") ?? "route_id";
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ feature, stats: ledger.featureStats(feature) })
    );
    return;
  }
  if (url === "/api/trip-history") {
    const id = (new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("id") ?? "").replace(/^nyc:/, "");
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ tripId: id, ...ledger.tripHistory(id) })
    );
    return;
  }
  // Per-arrival drill-down: recent arrivals with feed vs model vs actual (Phase 6).
  if (url === "/api/recent-arrivals") {
    const rows = ledger.recentArrivalComparisons(30).map((r) => ({
      ...r,
      route: stat.routes[r.routeId]?.shortName ?? r.routeId,
      station: stat.stops[r.stopId]?.name ?? stat.stops[String(r.stopId).replace(/[NS]$/, "")]?.name ?? r.stopId,
    }));
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ rows }));
    return;
  }

  // Live arrivals board for a station (matches both direction platforms).
  if (url === "/api/arrivals") {
    const stop = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("stop") ?? "";
    const base = stop.replace(/[NS]$/, "");
    const now = Math.floor(Date.now() / 1000);
    const rows: { route: string; color: string; dir: string; etaSec: number }[] = [];
    for (const v of lastRaws) {
      if (!v.upcoming) continue;
      for (const u of v.upcoming) {
        if (u.stopId.replace(/[NS]$/, "") === base) {
          rows.push({
            route: stat.routes[v.routeId]?.shortName ?? v.routeId,
            color: stat.routes[v.routeId]?.color ?? "#3FD8FF",
            dir: u.stopId.slice(-1),
            etaSec: u.time - now,
          });
          break;
        }
      }
    }
    rows.sort((a, b) => a.etaSec - b.etaSec);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({
        stop: base,
        name: stat.stops[base]?.name ?? stat.stops[stop]?.name ?? base,
        arrivals: rows.filter((r) => r.etaSec > -30).slice(0, 10),
      })
    );
    return;
  }

  // /hub + /docs/** -> in-repo info pages (service hub, architecture, explainer)
  // /data/**        -> generated geometry (shapes/stops/routes/…)
  // /**             -> web/dist build output
  let filePath: string;
  if (url === "/hub") {
    filePath = join(DOCS_DIR, "hub.html");
  } else if (url.startsWith("/docs/")) {
    filePath = join(DOCS_DIR, normalize(url.slice("/docs/".length)));
  } else if (url.startsWith("/data/")) {
    filePath = join(DATA_DIR, normalize(url.slice("/data/".length)));
  } else {
    filePath = join(WEB_DIST, url === "/" ? "index.html" : normalize(url));
  }
  // contain path traversal
  if (!filePath.startsWith(DATA_DIR) && !filePath.startsWith(WEB_DIST) && !filePath.startsWith(DOCS_DIR)) {
    res.writeHead(403).end("forbidden");
    return;
  }
  try {
    const body = await readFile(filePath);
    res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

// --- WebSocket: push state to viewers ---
// Two protocols (P5): legacy full-state every tick (default — analytics-go and
// any older client depend on it), and OPT-IN deltas (`?proto=delta`, used by
// the web map): full snapshot on connect + every RESYNC_EVERY ticks, compact
// position tuples in between. Measured: full state ≈ 172 KB per 4s tick
// (~148 MB/h/client); the delta cuts the steady-state stream ~80%.
const wss = new WebSocketServer({ server });
const deltaClients = new WeakSet<WebSocket>();
wss.on("connection", (ws: WebSocket, req) => {
  if ((req?.url ?? "").includes("proto=delta")) deltaClients.add(ws);
  ws.send(JSON.stringify({ type: "snapshot", city: "nyc", vehicles: latest }));
});

// meta-hash per vehicle: when it changes (route/next-stop/shape/color/...),
// the delta carries the full object for that vehicle instead of a tuple.
const lastMeta = new Map<string, string>();
const RESYNC_EVERY = 15; // ~60s: periodic full snapshot to delta clients (drift/miss safety)
let pushCount = 0;

// nextStopName and stale are deliberately NOT in the hash — nextStop advances
// constantly as trains progress and stale flips in batches between feed polls
// (measured: together ~60-130 full objects per tick). Both ride in the tuple:
// nextStopName in slot 8 (null when unchanged), stale as flags bit 1.
function metaHash(v: VehicleState): string {
  return `${v.route}|${v.shapeId ?? ""}|${v.color}|${v.elevation}`;
}
const lastNextStop = new Map<string, string>();

/** Compact per-tick tuple: [id, dist, speed, uncertainty, flags, lon, lat,
 *  nextStopName-if-changed]. flags: bit0=anomaly, bit1=stale.
 *  (lon/lat only for pos-positioned vehicles/buses.) */
type DeltaTuple = [string, number | null, number, number | null, number, number | null, number | null, string | null];

function buildDelta(ts: number, graphEdges: unknown) {
  const up: DeltaTuple[] = [];
  const meta: VehicleState[] = [];
  const seen = new Set<string>();
  for (const v of latest) {
    seen.add(v.id);
    const h = metaHash(v);
    if (lastMeta.get(v.id) !== h) {
      lastMeta.set(v.id, h);
      lastNextStop.set(v.id, v.nextStopName ?? "");
      meta.push(v); // new vehicle or structural change — send full object
    } else {
      const ns = v.nextStopName ?? "";
      const nsChanged = lastNextStop.get(v.id) !== ns;
      if (nsChanged) lastNextStop.set(v.id, ns);
      up.push([v.id, v.shapeId ? Math.round(v.dist * 10) / 10 : null,
               Math.round(v.speed * 100) / 100,
               v.uncertainty != null ? Math.round(v.uncertainty * 10) / 10 : null,
               (v.anomaly ? 1 : 0) | (v.stale ? 2 : 0),
               v.pos ? v.pos[0] : null, v.pos ? v.pos[1] : null,
               nsChanged ? ns : null]);
    }
  }
  const rm: string[] = [];
  for (const id of lastMeta.keys()) if (!seen.has(id)) { rm.push(id); lastMeta.delete(id); lastNextStop.delete(id); }
  return { type: "delta", city: "nyc", ts, up, meta, rm, graphEdges };
}

function broadcast(msg: { type: string; ts?: number; graphEdges?: unknown; [k: string]: unknown }) {
  const full = JSON.stringify(msg);
  pushCount++;
  const resync = pushCount % RESYNC_EVERY === 0;
  let delta: string | null = null;
  for (const c of wss.clients) {
    if (c.readyState !== WebSocket.OPEN) continue;
    if (deltaClients.has(c) && msg.type === "state" && !resync) {
      delta ??= JSON.stringify(buildDelta(msg.ts ?? 0, msg.graphEdges));
      c.send(delta);
    } else {
      c.send(full);
    }
  }
}

server.listen(PORT, () => {
  console.log(`[server] http+ws on :${PORT}  (data + ws)`);
  fetchTick().then(pushTick); // fetch immediately, then push so first client gets data fast
  setInterval(fetchTick, POLL_MS);
  setInterval(pushTick, PUSH_MS);
  weatherTick(); // sample once at boot, then on a slow timer
  setInterval(weatherTick, WEATHER_MS);
  alertsTick(); // snapshot service alerts at boot, then on a slow timer
  setInterval(alertsTick, ALERTS_MS);
  // Accuracy snapshots (Phase 4): trend the backtest over time for the dashboard.
  const snap = () => {
    try { ledger.recordAccuracySnapshot("gtfs-rt"); ledger.recordAccuracySnapshot("model-v1"); ledger.recordAccuracySnapshot("model-v2"); }
    catch (e) { console.error("[server] accuracy snapshot failed:", (e as Error).message); }
  };
  snap();
  setInterval(snap, 10 * 60_000);
  // Anomaly scoring (P4): every 30s, score in-progress hops against the
  // historical schedule baselines via analytics-py; persist flagged episodes.
  setInterval(anomalyTick, 30_000);
  setInterval(() => {
    const removed = history.prune();
    if (removed) console.log(`[server] pruned ${removed} old history rows`);
    const ledgerRemoved = ledger.prune();
    if (ledgerRemoved) console.log(`[server] pruned ${ledgerRemoved} old ledger rows`);
    // rebuild the segment-traversal table (graph edges + ML training rows)
    try {
      const segs = ledger.buildSegments(stopPos, stopElev);
      console.log(`[server] rebuilt ${segs} segment traversals`);
    } catch (e) {
      console.error("[server] buildSegments failed:", (e as Error).message);
    }
  }, 3600_000);
});
