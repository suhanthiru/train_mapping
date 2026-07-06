// Backend server: polls the live feed on a timer, interpolates, broadcasts
// vehicle state to all WebSocket clients, records history, and serves the
// static geometry the frontend loads. PROJECT_SPEC.md §4.
//
// Run: npm run server   (PORT env optional, default 8080)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, extname, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { fetchNycVehicles } from "../ingest/nyc.ts";
import { fetchNycBuses } from "../ingest/nyc-bus.ts";
import { fetchNycAlerts } from "../ingest/nyc-alerts.ts";
import { Interpolator, loadStatic } from "../core/interpolate.ts";
import { History } from "../history/db.ts";
import { PredictionLedger } from "../history/ledger.ts";
import type { VehicleState, RawVehicle } from "../shared/types.ts";

const PORT = Number(process.env.PORT ?? 8080);
const POLL_MS = 30_000; // how often we hit the live feed
const PUSH_MS = 4_000; // how often we re-interpolate + broadcast fresh positions
const WEATHER_MS = 5 * 60_000; // how often we sample the weather severity scalar
const ALERTS_MS = 2 * 60_000; // how often we snapshot active service alerts
const ANALYTICS_PY = process.env.ANALYTICS_PY ?? "http://localhost:8091";
const KALMAN_RS = process.env.KALMAN_RS ?? "http://localhost:8092";
const ROOT = process.cwd();
const DATA_DIR = join(ROOT, "data");
const WEB_DIST = join(ROOT, "web", "dist");

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

let latest: VehicleState[] = [];
let lastRaws: RawVehicle[] = [];
let lastBuses: VehicleState[] = [];
let kalmanInFlight = false; // guard: never stack overlapping Kalman round-trips
let lastWeatherScore = 0; // reused by modelPredictTick so it doesn't need its own DB/HTTP round-trip

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
async function modelPredictTick(raws: RawVehicle[]): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const nowDate = new Date(now * 1000);
  const hour = nowDate.getHours();
  const dow = nowDate.getDay();

  interface HopReq { id: string; route_id: string; from_stop: string; to_stop: string; hour: number; dow: number; weather_score: number; occ_pct: number }
  interface VehHops { tripId: string; routeId: string; feedTimestamp: number; hopIds: string[]; targetStops: string[] }

  const hopReqs: HopReq[] = [];
  const vehHops: VehHops[] = [];

  for (const v of raws) {
    if (!v.upcoming?.length) continue;
    const anchor = v.atStopId ?? v.toStopId ?? v.fromStopId;
    if (!anchor) continue; // nothing to chain the first hop from — skip this tick
    const hopIds: string[] = [];
    const targetStops: string[] = [];
    for (let i = 0; i < v.upcoming.length; i++) {
      const to = v.upcoming[i].stopId;
      if (!to) continue;
      const from = i === 0 ? anchor : v.upcoming[i - 1].stopId;
      const id = `${v.tripId}|${i}`;
      hopReqs.push({
        id, route_id: v.routeId, from_stop: from, to_stop: to,
        hour, dow, weather_score: lastWeatherScore, occ_pct: v.occPct ?? 0,
      });
      hopIds.push(id);
      targetStops.push(to);
    }
    if (hopIds.length) vehHops.push({ tripId: v.tripId, routeId: v.routeId, feedTimestamp: v.feedTimestamp, hopIds, targetStops });
  }
  if (!hopReqs.length) return;

  try {
    const r = await fetch(`${ANALYTICS_PY}/predict-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(hopReqs),
      signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) return; // model not trained yet, or service down — skip quietly
    const preds = (await r.json()) as { id: string; predicted_travel_sec: number }[];
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
  } catch (e) {
    console.error("[server] model prediction skipped:", (e as Error).message);
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
  latest = [...trains, ...lastBuses];
  history.record(now, trains);
  logVehicleState(trains, now);
  broadcast({ type: "state", city: "nyc", ts: now, vehicles: latest });
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
    }
    if (rows.length) ledger.recordVehicleLog(rows);
  } catch (e) {
    console.error("[server] vehicle_log skipped:", (e as Error).message);
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
    res.writeHead(200).end(JSON.stringify({ ok: true, vehicles: latest.length }));
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

  // Backtest read-out: feed-prediction accuracy (MAE + bias) vs. lead time.
  if (url === "/api/prediction-accuracy") {
    const source = new URLSearchParams((req.url ?? "").split("?")[1] ?? "").get("source") ?? "gtfs-rt";
    const buckets = ledger.accuracyByLeadTime(source);
    res.writeHead(200, { "Content-Type": "application/json" }).end(
      JSON.stringify({ source, counts: ledger.counts(), buckets })
    );
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

  // /data/** -> generated geometry (shapes/stops/routes/…)
  // /**      -> web/dist build output
  let filePath: string;
  if (url.startsWith("/data/")) {
    filePath = join(DATA_DIR, normalize(url.slice("/data/".length)));
  } else {
    filePath = join(WEB_DIST, url === "/" ? "index.html" : normalize(url));
  }
  // contain path traversal
  if (!filePath.startsWith(DATA_DIR) && !filePath.startsWith(WEB_DIST)) {
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
const wss = new WebSocketServer({ server });
wss.on("connection", (ws: WebSocket) => {
  // full snapshot on connect (diffing is a later optimization)
  ws.send(JSON.stringify({ type: "snapshot", city: "nyc", vehicles: latest }));
});

function broadcast(msg: unknown) {
  const data = JSON.stringify(msg);
  for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) c.send(data);
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
    try { ledger.recordAccuracySnapshot("gtfs-rt"); ledger.recordAccuracySnapshot("model-v1"); }
    catch (e) { console.error("[server] accuracy snapshot failed:", (e as Error).message); }
  };
  snap();
  setInterval(snap, 10 * 60_000);
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
