// Backend server: polls the live feed on a timer, interpolates, broadcasts
// vehicle state to all WebSocket clients, records history, and serves the
// static geometry the frontend loads. PROJECT_SPEC.md §4.
//
// Run: npm run server   (PORT env optional, default 8080)

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import { fetchNycVehicles } from "../ingest/nyc.ts";
import { fetchNycBuses } from "../ingest/nyc-bus.ts";
import { Interpolator, loadStatic } from "../core/interpolate.ts";
import { History } from "../history/db.ts";
import type { VehicleState, RawVehicle } from "../shared/types.ts";

const PORT = Number(process.env.PORT ?? 8080);
const POLL_MS = 30_000; // how often we hit the live feed
const PUSH_MS = 4_000; // how often we re-interpolate + broadcast fresh positions
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

let latest: VehicleState[] = [];
let lastRaws: RawVehicle[] = [];
let lastBuses: VehicleState[] = [];

// Poll the live feeds (slow): subway predictions + bus GPS; record history.
async function fetchTick() {
  try {
    const [raws, buses] = await Promise.all([fetchNycVehicles(), fetchNycBuses()]);
    lastRaws = raws;
    lastBuses = buses;
    const now = Math.floor(Date.now() / 1000);
    history.record(now, interp.update(lastRaws, now));
    console.log(`[server] feed: ${lastRaws.length} trains + ${lastBuses.length} buses -> ${wss.clients.size} clients`);
  } catch (e) {
    console.error("[server] feed error:", (e as Error).message);
  }
}

// Re-interpolate trains with a fresh clock (fast) + merge buses + broadcast.
function pushTick() {
  const now = Math.floor(Date.now() / 1000);
  latest = [...interp.update(lastRaws, now), ...lastBuses];
  broadcast({ type: "state", city: "nyc", ts: now, vehicles: latest });
}

// --- HTTP: static geometry + built frontend ---
const server = createServer(async (req, res) => {
  const url = (req.url ?? "/").split("?")[0];
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (url === "/health") {
    res.writeHead(200).end(JSON.stringify({ ok: true, vehicles: latest.length }));
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
  setInterval(() => {
    const removed = history.prune();
    if (removed) console.log(`[server] pruned ${removed} old history rows`);
  }, 3600_000);
});
