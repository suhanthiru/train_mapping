// Live 3D transit scene: real 3D building city (MapLibre + free OpenFreeMap
// vector tiles) with subway trains gliding along the track geometry on top
// (deck.gl interleaved overlay). PROJECT_SPEC.md §8.

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer, ArcLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import type { PickingInfo } from "@deck.gl/core";
import { distToLonLat, bearingAt, type Shape } from "./geo.ts";
import { trainCarMesh, busMesh } from "./mesh.ts";
import { PORTS, routeFromShapeId } from "../../shared/config.ts";

// Same-origin by default — this bundle is served BY the backend, so same-origin
// naturally follows the page wherever it's reached from (direct port, or a
// TLS-terminating reverse proxy on 80/443 with no port at all). The explicit
// backend port is used ONLY under `vite dev`, which has no dev proxy
// configured, so the API has to be reached across ports there.
// Ports come from shared/config.ts — the single source (roadmap P3).
const HOST = location.hostname || "localhost";
const onViteDev = location.port === String(PORTS.webDev);
const HTTP_PROTO = location.protocol === "https:" ? "https:" : "http:";
const WS_PROTO = location.protocol === "https:" ? "wss:" : "ws:";
const HTTP = onViteDev ? `${HTTP_PROTO}//${HOST}:${PORTS.backend}` : `${HTTP_PROTO}//${location.host}`;
const WS = onViteDev ? `${WS_PROTO}//${HOST}:${PORTS.backend}` : `${WS_PROTO}//${location.host}`;
// Go streaming-analytics service (separate microservice) is never same-origin
// with anything — reachable only where its port is exposed (local dev, or a
// VPS with the port open). Behind a TLS proxy that doesn't forward it, this
// degrades gracefully: the anomalies panel just shows nothing.
const ANALYTICS = `${HTTP_PROTO}//${HOST}:${PORTS.analyticsGo}`;
const SPEED_BOOST = 1.0; // real rate — no overshoot, so no snap-back/reversing

interface RouteInfo { id: string; color: string; textColor: string; shortName: string }
interface Stop { id: string; name: string; pos: [number, number]; parent?: string }
type Elevation = "underground" | "surface" | "elevated";
interface Vehicle {
  id: string; shapeId: string;
  dist: number; correct: number; speed: number; // correct = pending drift to absorb
  color: [number, number, number];
  route: string; nextStopName?: string;
  position: [number, number, number]; angle: number;
  elevation: Elevation;
  uncertainty?: number; // √variance (m) from the Kalman sidecar; drives the K halo
  anomaly?: boolean; // P4: flagged as running anomalously slow vs schedule (amber pulse)
}

const hex2rgb = (h: string): [number, number, number] => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

// Synthetic depth (meters) per elevation category — OSM `layer` is ordinal,
// not a real height, so these are tuned to be visible at the default camera
// pitch without pushing trains through the basemap/buildings. Only applied
// when depthMode is on (E toggle) — see keydown handler below.
const ELEVATION_Z: Record<Elevation, number> = {
  underground: -18,
  surface: 0,
  elevated: 14,
};

let shapes: Record<string, Shape> = {};
let routes: Record<string, RouteInfo> = {};
const vehicles = new Map<string, Vehicle>();
interface Bus { id: string; lon: number; lat: number; tLon: number; tLat: number; heading: number; speed: number; route: string; color: [number, number, number]; }

// NOTE: GTFS-rt occupancy was REMOVED (not merely hidden) — NYC's MTA feed sends
// it as a placeholder (EMPTY for 100% of trains; no passenger-counting hardware),
// so it was dead weight end to end. The real crowding signal is station-hourly
// ridership (analytics-py/mta_ridership.py), a model feature rather than a per-
// train UI badge.
interface AnomalySummary {
  routeId: string; direction: string; mode: string; color: string;
  gapSeconds: number; zscore: number; kind: "bunching" | "gap"; why: string;
}
const buses = new Map<string, Bus>();
// Live graph edges from the backend (Y toggle): which trains the graph connects
// and why. Populated from each WS state message; endpoints resolved from the
// rendered train positions at draw time.
let graphEdges: { a: string; b: string; type: "follows" | "shares"; metric: string }[] = [];
const CAR_MESH = trainCarMesh();
const BUS_MESH = busMesh();
const CARS_PER_TRAIN = 5;
const CAR_SPACING = 26; // meters between subway car centers along the track
const statEl = document.getElementById("stat")!;
const tipEl = document.getElementById("tooltip")!;

// --- perf diagnostics: B buildings, G bloom, T trains, V buses, P pause data
// pushes (map stays interactive). FPS shown in the HUD.
let bloomOn = true;
let showTrains = true;
let showBuses = true;
let pausePush = false;
let depthMode = false; // E: real elevation-driven z vs flat (z=0, today's look)
let showUncertainty = false; // K: Kalman position-uncertainty halos (default off)
let showGraph = false; // Y: graph overlay — FOLLOWS + SHARES_TRACK edges between trains
let statBase = "connecting…";
let fpsCount = 0, fpsLast = performance.now(), fpsVal = 0;
// P4 deep-link from the dashboard's anomaly panel: /?trip=<tripId> flies to
// that train when it first appears in the stream. Consumed once.
let deepLinkTrip: string | null = new URLSearchParams(location.search).get("trip");
window.addEventListener("keydown", (e) => {
  const k = e.key.toLowerCase();
  if (k === "b") {
    const vis = map.getLayoutProperty("buildings", "visibility");
    map.setLayoutProperty("buildings", "visibility", vis === "none" ? "visible" : "none");
  } else if (k === "g") {
    bloomOn = !bloomOn;
    (document.getElementById("bloom-canvas") as HTMLCanvasElement).style.display = bloomOn ? "" : "none";
  } else if (k === "t") showTrains = !showTrains;
  else if (k === "v") showBuses = !showBuses;
  else if (k === "p") pausePush = !pausePush;
  else if (k === "e") depthMode = !depthMode;
  else if (k === "k") showUncertainty = !showUncertainty;
  else if (k === "y") showGraph = !showGraph;
});

const routeOfShape = routeFromShapeId; // shared/config.ts — one parsing definition
const shapeColor = (id: string): [number, number, number] => {
  const r = routes[routeOfShape(id)];
  return r ? hex2rgb(r.color) : [63, 216, 255];
};

// --- dark "diorama at night" basemap style over free OpenFreeMap vector tiles ---
const OFM = "https://tiles.openfreemap.org/planet";
const darkStyle: any = {
  version: 8,
  glyphs: "https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf",
  sources: { omt: { type: "vector", url: OFM } },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#000103" } },
    { id: "water", type: "fill", source: "omt", "source-layer": "water",
      paint: { "fill-color": "#04141d" } },
    { id: "waterway", type: "line", source: "omt", "source-layer": "waterway",
      paint: { "line-color": "#06202b", "line-width": 1.2 } },
    { id: "roads", type: "line", source: "omt", "source-layer": "transportation", minzoom: 11,
      paint: {
        "line-color": "#0b2a37",
        "line-width": ["interpolate", ["linear"], ["zoom"], 11, 0.4, 16, 2.5],
      } },
    { id: "buildings", type: "fill-extrusion", source: "omt", "source-layer": "building", minzoom: 12,
      paint: {
        // warm amber-dark buildings (contrast against cool cyan trains)
        "fill-extrusion-color": [
          "interpolate", ["linear"], ["coalesce", ["get", "render_height"], 10],
          0, "#160f09", 30, "#241811", 120, "#3a2817", 300, "#4a3420",
        ],
        "fill-extrusion-height": ["coalesce", ["get", "render_height"], 10],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.92,
      } },
  ],
};

const map = new maplibregl.Map({
  container: "map",
  style: darkStyle,
  center: [-73.984, 40.752],
  zoom: 13,
  pitch: 58,
  bearing: 18,
  antialias: false, // deck AA's its own layers; extrusion AA is brutal on integrated GPUs
  pixelRatio: Math.min(window.devicePixelRatio || 1, 1.25), // cap fill-rate on high-DPI displays
  preserveDrawingBuffer: true, // bloom reads this canvas; without it reads catch a cleared buffer (screen blink)
  maxPitch: 75,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

const overlay = new MapboxOverlay({ interleaved: true, pickingRadius: 5, layers: [], onHover, onClick });
map.addControl(overlay as any);

// warm/cool lighting on the extrusions
map.on("style.load", () => {
  try { map.setLight({ anchor: "viewport", color: "#9fb8d8", intensity: 0.35, position: [1.2, 200, 40] }); } catch {}
});

// Copy the bloom overlay inside MapLibre's own render event: the WebGL buffer is
// always fresh/valid here, and the bloom stays perfectly in sync with camera
// motion (fixes both the dark screen-blink and the lagging-blur ghosting).
map.on("render", () => { if (bloomOn) drawBloom(); });

// --- click handling via deck picking: train -> journey timeline, station -> arrivals ---
const arrivalsEl = document.getElementById("arrivals")!;
const journeyEl = document.getElementById("journey")!;
const rgbCss = (c: [number, number, number]) => `rgb(${c[0]},${c[1]},${c[2]})`;
const fmtEta = (s: number) => (s < 45 ? "now" : `${Math.round(s / 60)} min`);

async function showArrivals(stop: Stop) {
  journeyEl.style.display = "none";
  arrivalsEl.style.display = "block";
  arrivalsEl.innerHTML = `<b>${stop.name}</b><br><span style="opacity:.6">loading…</span>`;
  try {
    const data = await fetch(`${HTTP}/api/arrivals?stop=${encodeURIComponent(stop.id)}`).then((r) => r.json());
    const rows = (data.arrivals || []).map((a: any) =>
      `<div class="row"><span class="route-badge" style="background:${a.color}">${a.route}</span>` +
      `<span style="flex:1;opacity:.7">${a.dir === "N" ? "▲ uptown" : "▼ downtown"}</span><span>${fmtEta(a.etaSec)}</span></div>`
    ).join("");
    arrivalsEl.innerHTML = `<span class="close" onclick="document.getElementById('arrivals').style.display='none'">✕</span>` +
      `<b>${data.name}</b>${rows || '<br><span style="opacity:.6">no trains inbound</span>'}`;
  } catch {
    arrivalsEl.innerHTML = `<b>${stop.name}</b><br><span style="opacity:.6">arrivals unavailable</span>`;
  }
}

async function showJourney(v: Vehicle) {
  arrivalsEl.style.display = "none";
  journeyEl.style.display = "block";
  journeyEl.style.setProperty("--line", rgbCss(v.color));
  journeyEl.innerHTML = `<span style="opacity:.6">loading…</span>`;
  try {
    const data = await fetch(`${HTTP}/api/trip?id=${encodeURIComponent(v.id)}`).then((r) => r.json());
    journeyEl.style.setProperty("--line", data.color || rgbCss(v.color));
    const rows = ((data.stops || []) as { name: string; etaSec: number }[]).map((s, i) =>
      `<div class="j-stop${i === 0 ? " next" : ""}"><span class="j-dot"></span>` +
      `<span class="j-name">${s.name}</span><span class="j-eta">${fmtEta(s.etaSec)}</span></div>`
    ).join("");
    journeyEl.innerHTML =
      `<span class="close" onclick="document.getElementById('journey').style.display='none'">✕</span>` +
      `<div class="j-head"><span class="route-badge" style="background:${data.color}">${data.route}</span>` +
      `<div><b>${data.route} train</b>${data.dest ? `<br><span class="j-dest">toward ${data.dest}</span>` : ""}</div></div>` +
      `<div class="j-stops">${rows || '<span style="opacity:.6">no upcoming stops in feed</span>'}</div>`;
  } catch {
    journeyEl.innerHTML = `<span class="close" onclick="document.getElementById('journey').style.display='none'">✕</span>` +
      `<span style="opacity:.6">journey unavailable</span>`;
  }
}

function showBusInfo(b: Bus) {
  arrivalsEl.style.display = "none";
  journeyEl.style.display = "block";
  journeyEl.style.setProperty("--line", "#F0A830");
  journeyEl.innerHTML =
    `<span class="close" onclick="document.getElementById('journey').style.display='none'">✕</span>` +
    `<div class="j-head"><span class="route-badge" style="background:#F0A830">${b.route}</span>` +
    `<div><b>${b.route} bus</b><br><span class="j-dest">${(b.speed * 2.237).toFixed(0)} mph</span></div></div>`;
}

function onClick(info: PickingInfo) {
  const id = info.layer?.id;
  if (info.object && (id === "trains" || id === "train-glow")) {
    showJourney((id === "trains" ? (info.object as Car).v : info.object) as Vehicle);
  } else if (info.object && (id === "buses" || id === "bus-glow")) {
    showBusInfo(info.object as Bus);
  } else if (info.object && id === "stations") {
    showArrivals(info.object as Stop);
  } else {
    arrivalsEl.style.display = "none";
    journeyEl.style.display = "none";
  }
}

// --- deck layers (subway network + trains), rebuilt each frame ---
let linePaths: { path: [number, number][]; color: [number, number, number] }[] = [];
let stationPts: Stop[] = [];

// static layers (subway network + stations) — built once, never rebuilt per frame
let staticLayers: any[] = [];
function buildStatic() {
  staticLayers = [
    new PathLayer({
      id: "lines", data: linePaths,
      getPath: (d: any) => d.path, getColor: (d: any) => [...d.color, 200],
      getWidth: 2, widthMinPixels: 1.5, widthMaxPixels: 6,
      capRounded: true, jointRounded: true, parameters: { depthTest: false },
    }),
    new ScatterplotLayer({
      id: "stations", data: stationPts, pickable: true,
      getPosition: (d: any) => d.pos,
      getFillColor: [8, 18, 26, 230],
      stroked: true, getLineColor: [130, 235, 255, 255], lineWidthMinPixels: 1.5, getLineWidth: 2,
      getRadius: 34, radiusMinPixels: 3, radiusMaxPixels: 9,
      parameters: { depthTest: false },
    }),
  ];
}

// dynamic train layers — each train drawn as CARS_PER_TRAIN cars placed along
// the track shape, so it articulates around curves. Rebuilt each frame.
interface Car { position: [number, number, number]; angle: number; color: [number, number, number]; v: Vehicle; }
function trainLayers() {
  if (!showTrains) return [];
  const heads = [...vehicles.values()];
  const cars: Car[] = [];
  for (const v of heads) {
    const shape = shapes[v.shapeId];
    if (!shape) continue;
    const z = depthMode ? ELEVATION_Z[v.elevation] ?? 0 : 0;
    for (let i = 0; i < CARS_PER_TRAIN; i++) {
      const d = v.dist - i * CAR_SPACING;
      if (d < 0) break;
      const p = distToLonLat(shape, d);
      cars.push({ position: [p[0], p[1], z], angle: bearingAt(shape, d), color: v.color, v });
    }
  }
  const anomalous = heads.filter((v) => v.anomaly);
  // pulse phase shared per frame (rebuilt each frame anyway)
  const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
  return [
    // P4: anomaly pulse — amber breathing halo on trains flagged as running
    // anomalously slow vs schedule (always on; it IS the alert).
    ...(anomalous.length
      ? [
          new ScatterplotLayer({
            id: "train-anomaly", data: anomalous,
            getPosition: (d: Vehicle) => d.position,
            getFillColor: [240, 168, 48, Math.round(40 + 70 * pulse)] as [number, number, number, number],
            stroked: true, getLineColor: [240, 168, 48, 235], lineWidthMinPixels: 2,
            getRadius: 60 + 45 * pulse, radiusMinPixels: 10, radiusMaxPixels: 42,
            pickable: false,
            updateTriggers: { getPosition: performance.now(), getRadius: performance.now(), getFillColor: performance.now() },
            parameters: { depthTest: false },
          }),
        ]
      : []),
    // Kalman position-uncertainty halo (K toggle): radius = √variance in meters,
    // so it tightens on confident tracks and swells when the filter is unsure.
    ...(showUncertainty
      ? [
          new ScatterplotLayer({
            id: "train-uncertainty", data: heads,
            getPosition: (d: Vehicle) => d.position,
            getFillColor: (d: Vehicle) => [d.color[0], d.color[1], d.color[2], 55] as [number, number, number, number],
            getRadius: (d: Vehicle) => d.uncertainty ?? 0, // meters
            radiusMinPixels: 4, radiusMaxPixels: 90, pickable: false,
            updateTriggers: { getPosition: performance.now(), getRadius: performance.now() },
            parameters: { depthTest: false },
          }),
        ]
      : []),
    new ScatterplotLayer({
      id: "train-glow", data: heads,
      getPosition: (d: Vehicle) => d.position,
      getFillColor: (d: Vehicle) => [...d.color, 210] as [number, number, number, number],
      getRadius: 26, radiusMinPixels: 2, radiusMaxPixels: 7, pickable: true,
      updateTriggers: { getPosition: performance.now() },
      parameters: { depthTest: false },
    }),
    new SimpleMeshLayer({
      id: "trains", data: cars, mesh: CAR_MESH as any,
      getPosition: (d: Car) => d.position,
      getColor: (d: Car) => d.color,
      getOrientation: (d: Car) => [0, 90 - d.angle, 0], // roll 0: sits flat on track
      sizeScale: 1.3, pickable: true, material: false,
      updateTriggers: { getPosition: performance.now(), getOrientation: performance.now() },
      parameters: { depthTest: false },
    }),
  ];
}

function busLayers() {
  if (!showBuses) return [];
  const data = [...buses.values()];
  return [
    new ScatterplotLayer({
      id: "bus-glow", data,
      getPosition: (d: Bus) => [d.lon, d.lat],
      getFillColor: (d: Bus) => [...d.color, 220] as [number, number, number, number],
      getRadius: 20, radiusMinPixels: 2, radiusMaxPixels: 7, pickable: true,
      updateTriggers: { getPosition: performance.now() },
      parameters: { depthTest: false },
    }),
    new SimpleMeshLayer({
      id: "buses", data, mesh: BUS_MESH as any,
      getPosition: (d: Bus) => [d.lon, d.lat],
      getColor: (d: Bus) => d.color,
      getOrientation: (d: Bus) => [0, 90 - d.heading, 0], // movement-derived compass heading, same formula as trains
      sizeScale: 1.7, material: false, pickable: true,
      updateTriggers: { getPosition: performance.now(), getOrientation: performance.now() },
      parameters: { depthTest: true, depthMask: true }, // occluded by 3D buildings (no clipping through)
    }),
  ];
}

// --- anomalies panel: fetched from the Go analytics microservice (:8090) ---
const anomaliesEl = document.getElementById("anomalies")!;
async function pollAnomalies() {
  try {
    const anomalies: AnomalySummary[] = await fetch(`${ANALYTICS}/anomalies`).then((r) => r.json());
    if (!Array.isArray(anomalies)) return;
    if (anomalies.length === 0) {
      anomaliesEl.style.display = "none";
      return;
    }
    anomaliesEl.style.display = "block";
    const items = anomalies
      .slice(0, 12)
      .map((a) => {
        const label = a.mode === "bus" ? `${a.routeId} bus` : `${a.routeId} train ${a.direction}`.trim();
        return `<div class="a-item ${a.kind}">` +
          `<div class="a-row"><span class="route-badge" style="background:${a.color}">${a.routeId}</span>` +
          `<b style="font-size:12.5px">${label}</b></div>` +
          `<div class="a-kind">${a.kind}</div>` +
          `<div class="a-why">${a.why}</div></div>`;
      })
      .join("");
    anomaliesEl.innerHTML = `<div class="a-head">Live anomalies (${anomalies.length})</div>${items}`;
  } catch { /* Go service may not be running yet — fail quietly */ }
}
setInterval(pollAnomalies, 5000);
pollAnomalies();

// Graph overlay (Y toggle): draw each backend graph edge as an arc between the
// two trains' live rendered positions. FOLLOWS = cyan (same line, headway),
// SHARES_TRACK = orange (cross-route junction). Endpoints resolved from the
// vehicles map by id; edges whose trains have scrolled off are skipped.
function graphLayers() {
  if (!showGraph || !graphEdges.length) return [];
  const data = graphEdges
    .map((e) => {
      const from = vehicles.get(e.a)?.position;
      const to = vehicles.get(e.b)?.position;
      return from && to ? { ...e, from, to } : null;
    })
    .filter((e): e is NonNullable<typeof e> => e !== null);
  const color = (d: { type: string }): [number, number, number] =>
    d.type === "follows" ? [80, 200, 255] : [255, 130, 60];
  return [
    new ArcLayer({
      id: "graph-edges",
      data,
      getSourcePosition: (d: any) => d.from,
      getTargetPosition: (d: any) => d.to,
      getSourceColor: color,
      getTargetColor: color,
      getWidth: 2.5,
      getHeight: 0.3,
      pickable: true,
      parameters: { depthTest: false },
    }),
  ];
}

function updateLayers() { overlay.setProps({ layers: [...staticLayers, ...trainLayers(), ...busLayers(), ...graphLayers()] }); }

// --- animation: dead-reckon anchor forward (boosted) + ease render toward it ---
let lastT = performance.now();
let lastLayerPush = 0;
function frame(now: number) {
  try {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    for (const v of vehicles.values()) {
      try {
        const shape = shapes[v.shapeId];
        if (!shape || !shape.cum?.length) continue;
        const total = shape.cum[shape.cum.length - 1];
        // Converging motion: base speed + drift absorbed over ~2s as a gentle
        // speed-up/slow-down. Forward-only per frame — no sprint-freeze sawtooth,
        // no backward glide.
        const catchup = v.correct * Math.min(1, dt / 2);
        const step = Math.max(0, v.speed * SPEED_BOOST * dt + catchup);
        v.dist += step;
        v.correct -= catchup;
        if (v.dist > total) v.dist = total;
        const [lon, lat] = distToLonLat(shape, v.dist);
        v.position = [lon, lat, depthMode ? ELEVATION_Z[v.elevation] ?? 0 : 0];
        v.angle = bearingAt(shape, v.dist);
      } catch { /* skip one bad vehicle */ }
    }
    for (const b of buses.values()) {
      const k = Math.min(1, dt / 1.5); // ease toward the on-road GPS point
      b.lon += (b.tLon - b.lon) * k;
      b.lat += (b.tLat - b.lat) * k;
    }
    // integrate every frame (cheap math), but push layer data ~10Hz — rebuilding
    // deck layers + re-uploading instance attributes every frame was the real
    // lag source (data churn), not vehicle count / GPU.
    if (!pausePush && now - lastLayerPush > 100) {
      lastLayerPush = now;
      updateLayers();
    }
    fpsCount++;
    if (now - fpsLast > 500) {
      fpsVal = Math.round((fpsCount * 1000) / (now - fpsLast));
      fpsCount = 0; fpsLast = now;
      statEl.textContent = `${statBase} · ${fpsVal} fps · [B]ldg [G]low [T]rain [V]bus [P]ause [E]levation [K]alman [Y]graph`;
    }
  } catch (e) {
    console.error("[frame] error (loop continues):", e);
  } finally {
    requestAnimationFrame(frame);
  }
}

// --- dual-canvas bloom over the MapLibre canvas ---
const bloom = document.getElementById("bloom-canvas") as HTMLCanvasElement;
const bctx = bloom.getContext("2d");
function drawBloom() {
  if (!bctx) return;
  try {
    // Quarter-resolution backing buffer: the CSS blur completely hides the
    // downscale, and the copy + filter get ~16x cheaper. Look is unchanged.
    const src = map.getCanvas();
    const bw = Math.max(1, src.width >> 2);
    const bh = Math.max(1, src.height >> 2);
    if (bloom.width !== bw || bloom.height !== bh) { bloom.width = bw; bloom.height = bh; }
    bctx.clearRect(0, 0, bw, bh);
    bctx.drawImage(src, 0, 0, bw, bh);
  } catch { /* ignore */ }
}

function onHover(info: PickingInfo) {
  const id = info.layer?.id;
  if (info.object && (id === "trains" || id === "train-glow")) {
    const v = (id === "trains" ? (info.object as Car).v : info.object) as Vehicle;
    const c = routes[routeOfShape(v.shapeId)];
    tipEl.style.display = "block";
    tipEl.style.left = info.x + 14 + "px";
    tipEl.style.top = info.y + 14 + "px";
    tipEl.innerHTML =
      `<span class="route-badge" style="background:${c?.color ?? "#3fd8ff"}">${v.route}</span>` +
      `<b>${v.route} train</b><br>` +
      (v.nextStopName ? `→ ${v.nextStopName}` : "en route") +
      `<br><span style="opacity:.6">${(v.speed * 2.237).toFixed(0)} mph</span>`;
  } else if (info.object && (id === "buses" || id === "bus-glow")) {
    const b = info.object as Bus;
    tipEl.style.display = "block";
    tipEl.style.left = info.x + 14 + "px";
    tipEl.style.top = info.y + 14 + "px";
    tipEl.innerHTML =
      `<span class="route-badge" style="background:#F0A830">${b.route}</span>` +
      `<b>${b.route} bus</b><br><span style="opacity:.6">${(b.speed * 2.237).toFixed(0)} mph</span>`;
  } else if (info.object && id === "stations") {
    const s = info.object as Stop;
    tipEl.style.display = "block";
    tipEl.style.left = info.x + 14 + "px";
    tipEl.style.top = info.y + 14 + "px";
    tipEl.innerHTML = `<b>${s.name}</b><br><span style="opacity:.6">station · click for arrivals</span>`;
  } else if (info.object && id === "graph-edges") {
    const e = info.object as { type: string; metric: string };
    tipEl.style.display = "block";
    tipEl.style.left = info.x + 14 + "px";
    tipEl.style.top = info.y + 14 + "px";
    const label = e.type === "follows" ? "FOLLOWS (same line)" : "SHARES_TRACK (junction)";
    tipEl.innerHTML = `<b>${label}</b><br><span style="opacity:.6">${e.metric}</span>`;
  } else {
    tipEl.style.display = "none";
  }
}

let loggedFirst = false;
// prune=false when called from applyDelta with a partial (meta-only) list —
// absent vehicles are then NOT departures, just unchanged.
function applyState(list: any[], prune = true) {
  const seen = new Set<string>();
  const busSeen = new Set<string>();
  for (const s of list) {
    if (s.mode === "bus" && s.pos) {
      busSeen.add(s.id);
      const eb = buses.get(s.id);
      if (eb) {
        // Heading from actual GPS movement (unambiguous, compass convention) —
        // the feed's bearing field is stale/junk when buses idle at stops.
        const mx = (s.pos[0] - eb.tLon) * 111320 * Math.cos((s.pos[1] * Math.PI) / 180);
        const my = (s.pos[1] - eb.tLat) * 111320;
        if (Math.hypot(mx, my) > 15) eb.heading = ((Math.atan2(mx, my) * 180) / Math.PI + 360) % 360;
        // ease toward the reported GPS (which is on the road); don't dead-reckon
        // along heading — that cuts across curves and drifts off the street
        eb.tLon = s.pos[0]; eb.tLat = s.pos[1];
        eb.speed = s.speed ?? eb.speed;
        if (Math.abs(eb.tLon - eb.lon) > 0.02 || Math.abs(eb.tLat - eb.lat) > 0.02) { eb.lon = eb.tLon; eb.lat = eb.tLat; } // snap big jumps
      } else {
        // initial heading: convert feed bearing via the user-calibrated mode (compass = 90 - b)
        buses.set(s.id, { id: s.id, lon: s.pos[0], lat: s.pos[1], tLon: s.pos[0], tLat: s.pos[1], heading: ((90 - (s.bearing ?? 0)) + 360) % 360, speed: s.speed ?? 7, route: s.route, color: hex2rgb(s.color) });
      }
      continue;
    }
    if (!s.shapeId || !shapes[s.shapeId]) continue;
    seen.add(s.id);
    const ex = vehicles.get(s.id);
    if (ex) {
      ex.route = s.route; ex.nextStopName = s.nextStopName;
      ex.elevation = s.elevation ?? "underground"; // can change if shape resolution reroutes (express/local)
      ex.uncertainty = s.uncertainty;
      ex.anomaly = s.anomaly ?? false;
      const drift = s.dist - ex.dist;
      if (Math.abs(drift) > 1500) { ex.dist = s.dist; ex.correct = 0; }
      else ex.correct = drift; // signed; absorbed as gentle speed-up/slow-down in frame()
      ex.speed = s.speed;
    } else {
      vehicles.set(s.id, {
        id: s.id, shapeId: s.shapeId, dist: s.dist, correct: 0, speed: s.speed,
        color: hex2rgb(s.color), route: s.route, nextStopName: s.nextStopName,
        position: [...distToLonLat(shapes[s.shapeId], s.dist), 0] as [number, number, number],
        angle: bearingAt(shapes[s.shapeId], s.dist),
        elevation: s.elevation ?? "underground",
        uncertainty: s.uncertainty,
        anomaly: s.anomaly ?? false,
      });
    }
    // Deep-link (?trip=<id>): first time the linked trip appears, fly to it.
    if (deepLinkTrip && s.id.endsWith(deepLinkTrip)) {
      const v = vehicles.get(s.id);
      if (v) {
        map.flyTo({ center: [v.position[0], v.position[1]], zoom: 14 });
        deepLinkTrip = null; // once
      }
    }
  }
  if (prune) {
    for (const id of [...vehicles.keys()]) if (!seen.has(id)) vehicles.delete(id);
    for (const id of [...buses.keys()]) if (!busSeen.has(id)) buses.delete(id);
  }
  statBase = `${vehicles.size} trains · ${buses.size} buses live · NYC`;
  (window as any).__tt = { vehicles, buses, shapes, map, overlay };
}

// P5 delta protocol: compact per-tick tuples for unchanged-meta vehicles
// ([id, dist, speed, uncertainty, anomaly01, lon, lat]), full objects only for
// new/meta-changed ones, rm for departures. Snapshot on connect + periodic
// resync stays authoritative — a missed delta self-heals within ~60s.
function applyDelta(m: any) {
  for (const s of m.meta ?? []) applyState([s], /*prune*/ false);
  for (const t of m.up ?? []) {
    const [id, dist, speed, unc, flags, lon, lat, nextStop] = t as [string, number | null, number, number | null, number, number | null, number | null, string | null];
    const ex = vehicles.get(id);
    if (ex && dist != null) {
      const drift = dist - ex.dist;
      if (Math.abs(drift) > 1500) { ex.dist = dist; ex.correct = 0; }
      else ex.correct = drift;
      ex.speed = speed;
      ex.uncertainty = unc ?? undefined;
      ex.anomaly = (flags & 1) === 1; // bit1 (stale) currently unused by the renderer
      if (nextStop != null) ex.nextStopName = nextStop;
      continue;
    }
    const eb = buses.get(id);
    if (eb && lon != null && lat != null) {
      const mx = (lon - eb.tLon) * 111320 * Math.cos((lat * Math.PI) / 180);
      const my = (lat - eb.tLat) * 111320;
      if (Math.hypot(mx, my) > 15) eb.heading = ((Math.atan2(mx, my) * 180) / Math.PI + 360) % 360;
      eb.tLon = lon; eb.tLat = lat; eb.speed = speed;
      if (Math.abs(eb.tLon - eb.lon) > 0.02 || Math.abs(eb.tLat - eb.lat) > 0.02) { eb.lon = eb.tLon; eb.lat = eb.tLat; }
    }
    // unknown id (missed its meta message) — the next resync snapshot heals it
  }
  for (const id of m.rm ?? []) { vehicles.delete(id); buses.delete(id); }
  statBase = `${vehicles.size} trains · ${buses.size} buses live · NYC`;
}

function connect() {
  const ws = new WebSocket(`${WS}/?proto=delta`);
  ws.onopen = () => console.log("[ws] connected (delta protocol)", WS);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "snapshot" || m.type === "state") {
      applyState(m.vehicles ?? []);
      graphEdges = m.graphEdges ?? [];
      if (!loggedFirst) {
        loggedFirst = true;
        console.log(`[ws] ${m.type}: ${m.vehicles?.length ?? 0} -> ${vehicles.size} rendered`);
      }
    } else if (m.type === "delta") {
      applyDelta(m);
      graphEdges = m.graphEdges ?? [];
    }
  };
  ws.onclose = () => { statEl.textContent = "reconnecting…"; setTimeout(connect, 2000); };
  ws.onerror = (err) => { console.error("[ws] error", err); ws.close(); };
}

async function main() {
  const [sh, ro, st] = await Promise.all([
    fetch(`${HTTP}/data/nyc/shapes.json`).then((r) => r.json()),
    fetch(`${HTTP}/data/nyc/routes.json`).then((r) => r.json()),
    fetch(`${HTTP}/data/nyc/stops.json`).then((r) => r.json()),
  ]);
  shapes = sh; routes = ro;
  linePaths = Object.values(shapes).map((s) => ({ path: s.pts, color: shapeColor(s.id) }));
  // dedupe: keep only parent-level stations (992/1488 records were child
  // platform stops stacked at the exact same coordinates as their parent —
  // that made clicking pick a random one of up to 3 overlapping dots)
  stationPts = (Object.values(st) as Stop[]).filter((s) => s.pos && s.pos[0] && !s.parent);
  buildStatic();
  console.log(`[init] ${linePaths.length} lines, ${stationPts.length} stations`);
  connect();
  requestAnimationFrame(frame);
}

main().catch((e) => { statEl.textContent = "load error: " + e.message; console.error(e); });
