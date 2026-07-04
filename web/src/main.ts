// Live 3D transit scene: real 3D building city (MapLibre + free OpenFreeMap
// vector tiles) with subway trains gliding along the track geometry on top
// (deck.gl interleaved overlay). PROJECT_SPEC.md §8.

import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { MapboxOverlay } from "@deck.gl/mapbox";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import type { PickingInfo } from "@deck.gl/core";
import { distToLonLat, bearingAt, type Shape } from "./geo.ts";
import { trainCarMesh, busMesh } from "./mesh.ts";

const HOST = location.hostname || "localhost";
const HTTP = `http://${HOST}:8080`;
const WS = `ws://${HOST}:8080`;
const SPEED_BOOST = 1.0; // real rate — no overshoot, so no snap-back/reversing

interface RouteInfo { id: string; color: string; textColor: string; shortName: string }
interface Stop { id: string; name: string; pos: [number, number] }
interface Vehicle {
  id: string; shapeId: string;
  dist: number; correct: number; speed: number; // correct = pending drift to absorb
  color: [number, number, number];
  route: string; nextStopName?: string;
  position: [number, number, number]; angle: number;
}

const hex2rgb = (h: string): [number, number, number] => {
  const n = parseInt(h.replace("#", ""), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

let shapes: Record<string, Shape> = {};
let routes: Record<string, RouteInfo> = {};
const vehicles = new Map<string, Vehicle>();
interface Bus { id: string; lon: number; lat: number; tLon: number; tLat: number; bearing: number; speed: number; route: string; color: [number, number, number]; }
const buses = new Map<string, Bus>();
const CAR_MESH = trainCarMesh();
const BUS_MESH = busMesh();
const CARS_PER_TRAIN = 5;
const CAR_SPACING = 26; // meters between subway car centers along the track
const statEl = document.getElementById("stat")!;
const tipEl = document.getElementById("tooltip")!;

// --- live calibration/diagnostics (temporary): press 1-4 to cycle bus yaw
// formulas, B to toggle 3D buildings, G to toggle bloom. FPS shown in the HUD.
// Mode 4 (yaw = bearing) verified correct by user calibration — OBA publishes
// math-convention bearings (CCW from east), not GTFS-spec compass degrees.
// Key 5 = mode 4 flipped 180° in case noses read backward.
let busYawMode = 3;
const busYaw = (b: number) => [90 - b, b - 90, -b, b, b + 180][busYawMode];
let bloomOn = true;
let statBase = "connecting…";
let fpsCount = 0, fpsLast = performance.now(), fpsVal = 0;
window.addEventListener("keydown", (e) => {
  if (e.key >= "1" && e.key <= "5") { busYawMode = +e.key - 1; console.log("[cal] bus yaw mode", e.key); }
  else if (e.key === "b" || e.key === "B") {
    const vis = map.getLayoutProperty("buildings", "visibility");
    map.setLayoutProperty("buildings", "visibility", vis === "none" ? "visible" : "none");
  } else if (e.key === "g" || e.key === "G") {
    bloomOn = !bloomOn;
    (document.getElementById("bloom-canvas") as HTMLCanvasElement).style.display = bloomOn ? "" : "none";
  }
});

const routeOfShape = (id: string) => id.split("..")[0];
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
  antialias: true,
  maxPitch: 75,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

const overlay = new MapboxOverlay({ interleaved: true, pickingRadius: 8, layers: [], onHover, onClick });
map.addControl(overlay as any);

// warm/cool lighting on the extrusions
map.on("style.load", () => {
  try { map.setLight({ anchor: "viewport", color: "#9fb8d8", intensity: 0.35, position: [1.2, 200, 40] }); } catch {}
});

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

function onClick(info: PickingInfo) {
  const id = info.layer?.id;
  if (info.object && (id === "trains" || id === "train-glow")) {
    showJourney((id === "trains" ? (info.object as Car).v : info.object) as Vehicle);
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
interface Car { position: [number, number]; angle: number; color: [number, number, number]; v: Vehicle; }
function trainLayers() {
  const heads = [...vehicles.values()];
  const cars: Car[] = [];
  for (const v of heads) {
    const shape = shapes[v.shapeId];
    if (!shape) continue;
    for (let i = 0; i < CARS_PER_TRAIN; i++) {
      const d = v.dist - i * CAR_SPACING;
      if (d < 0) break;
      const p = distToLonLat(shape, d);
      cars.push({ position: [p[0], p[1]], angle: bearingAt(shape, d), color: v.color, v });
    }
  }
  return [
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
      getOrientation: (d: Bus) => [0, busYaw(d.bearing), 0], // yaw formula selectable via keys 1-4
      sizeScale: 1.7, material: false, pickable: true,
      updateTriggers: { getPosition: performance.now(), getOrientation: performance.now() },
      parameters: { depthTest: true, depthMask: true }, // occluded by 3D buildings (no clipping through)
    }),
  ];
}

function updateLayers() { overlay.setProps({ layers: [...staticLayers, ...trainLayers(), ...busLayers()] }); }

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
        v.dist += v.speed * SPEED_BOOST * dt; // continuous glide, never freezes mid-track
        if (v.correct) {
          const step = v.correct * Math.min(1, dt / 1.2); // absorb drift over ~1.2s
          v.dist += step; v.correct -= step;
        }
        if (v.dist > total) v.dist = total;
        else if (v.dist < 0) v.dist = 0;
        const [lon, lat] = distToLonLat(shape, v.dist);
        v.position = [lon, lat, 0];
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
    if (now - lastLayerPush > 100) {
      lastLayerPush = now;
      updateLayers();
      if (bloomOn) drawBloom();
    }
    fpsCount++;
    if (now - fpsLast > 500) {
      fpsVal = Math.round((fpsCount * 1000) / (now - fpsLast));
      fpsCount = 0; fpsLast = now;
      statEl.textContent = `${statBase} · ${fpsVal} fps · bus-dir ${busYawMode + 1} [1-4] · [B]ldgs [G]low`;
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
  } else {
    tipEl.style.display = "none";
  }
}

let loggedFirst = false;
function applyState(list: any[]) {
  const seen = new Set<string>();
  const busSeen = new Set<string>();
  for (const s of list) {
    if (s.mode === "bus" && s.pos) {
      busSeen.add(s.id);
      const eb = buses.get(s.id);
      if (eb) {
        // ease toward the reported GPS (which is on the road); don't dead-reckon
        // along heading — that cuts across curves and drifts off the street
        eb.tLon = s.pos[0]; eb.tLat = s.pos[1];
        eb.bearing = s.bearing ?? eb.bearing; eb.speed = s.speed ?? eb.speed;
        if (Math.abs(eb.tLon - eb.lon) > 0.02 || Math.abs(eb.tLat - eb.lat) > 0.02) { eb.lon = eb.tLon; eb.lat = eb.tLat; } // snap big jumps
      } else {
        buses.set(s.id, { id: s.id, lon: s.pos[0], lat: s.pos[1], tLon: s.pos[0], tLat: s.pos[1], bearing: s.bearing ?? 0, speed: s.speed ?? 7, route: s.route, color: hex2rgb(s.color) });
      }
      continue;
    }
    if (!s.shapeId || !shapes[s.shapeId]) continue;
    seen.add(s.id);
    const ex = vehicles.get(s.id);
    if (ex) {
      ex.route = s.route; ex.nextStopName = s.nextStopName;
      const drift = s.dist - ex.dist;
      if (Math.abs(drift) > 1500) { ex.dist = s.dist; ex.correct = 0; ex.speed = s.speed; } // big desync: snap
      else if (drift >= 0) { ex.correct = drift; ex.speed = s.speed; } // behind truth: catch up smoothly
      else { ex.correct = 0; ex.speed = 0; } // ahead of truth: HOLD (trains never move backward)
    } else {
      vehicles.set(s.id, {
        id: s.id, shapeId: s.shapeId, dist: s.dist, correct: 0, speed: s.speed,
        color: hex2rgb(s.color), route: s.route, nextStopName: s.nextStopName,
        position: [...distToLonLat(shapes[s.shapeId], s.dist), 0] as [number, number, number],
        angle: bearingAt(shapes[s.shapeId], s.dist),
      });
    }
  }
  for (const id of [...vehicles.keys()]) if (!seen.has(id)) vehicles.delete(id);
  for (const id of [...buses.keys()]) if (!busSeen.has(id)) buses.delete(id);
  statBase = `${vehicles.size} trains · ${buses.size} buses live · NYC`;
  (window as any).__tt = { vehicles, buses, shapes, map, overlay };
}

function connect() {
  const ws = new WebSocket(WS);
  ws.onopen = () => console.log("[ws] connected", WS);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "snapshot" || m.type === "state") {
      applyState(m.vehicles ?? []);
      if (!loggedFirst) {
        loggedFirst = true;
        console.log(`[ws] ${m.type}: ${m.vehicles?.length ?? 0} -> ${vehicles.size} rendered`);
      }
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
  stationPts = (Object.values(st) as Stop[]).filter((s) => s.pos && s.pos[0]);
  buildStatic();
  console.log(`[init] ${linePaths.length} lines, ${stationPts.length} stations`);
  connect();
  requestAnimationFrame(frame);
}

main().catch((e) => { statEl.textContent = "load error: " + e.message; console.error(e); });
