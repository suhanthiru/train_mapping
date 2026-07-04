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
import { trainMesh } from "./mesh.ts";

const HOST = location.hostname || "localhost";
const HTTP = `http://${HOST}:8080`;
const WS = `ws://${HOST}:8080`;
const SPEED_BOOST = 5; // exaggerate real m/s so motion is visible at city zoom

interface RouteInfo { id: string; color: string; textColor: string; shortName: string }
interface Stop { id: string; name: string; pos: [number, number] }
interface Vehicle {
  id: string; shapeId: string;
  dist: number; targetDist: number; speed: number;
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
const MESH = trainMesh();
const statEl = document.getElementById("stat")!;
const tipEl = document.getElementById("tooltip")!;

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

const overlay = new MapboxOverlay({ interleaved: true, layers: [], onHover });
map.addControl(overlay as any);

// warm/cool lighting on the extrusions
map.on("style.load", () => {
  try { map.setLight({ anchor: "viewport", color: "#9fb8d8", intensity: 0.35, position: [1.2, 200, 40] }); } catch {}
});

// --- deck layers (subway network + trains), rebuilt each frame ---
let linePaths: { path: [number, number][]; color: [number, number, number] }[] = [];
let stationPts: Stop[] = [];

function layers() {
  const data = [...vehicles.values()];
  return [
    new PathLayer({
      id: "lines", data: linePaths,
      getPath: (d: any) => d.path, getColor: (d: any) => [...d.color, 200],
      getWidth: 2, widthMinPixels: 1.5, widthMaxPixels: 6,
      capRounded: true, jointRounded: true, parameters: { depthTest: false },
    }),
    new ScatterplotLayer({
      id: "stations", data: stationPts,
      getPosition: (d: any) => d.pos, getFillColor: [150, 220, 255, 110],
      getRadius: 24, radiusMinPixels: 1, radiusMaxPixels: 4, parameters: { depthTest: false },
    }),
    new ScatterplotLayer({
      id: "train-glow", data,
      getPosition: (d: Vehicle) => d.position,
      getFillColor: (d: Vehicle) => [...d.color, 235] as [number, number, number, number],
      getRadius: 45, radiusMinPixels: 3, radiusMaxPixels: 11, pickable: true,
      parameters: { depthTest: false },
    }),
    new SimpleMeshLayer({
      id: "trains", data, mesh: MESH as any,
      getPosition: (d: Vehicle) => d.position,
      getColor: (d: Vehicle) => d.color,
      getOrientation: (d: Vehicle) => [0, 90 - d.angle, 90],
      sizeScale: 1.6, pickable: true, material: false,
      parameters: { depthTest: false },
    }),
  ];
}

function updateLayers() { overlay.setProps({ layers: layers() }); }

// --- animation: dead-reckon anchor forward (boosted) + ease render toward it ---
let lastT = performance.now();
function frame(now: number) {
  try {
    const dt = Math.min(0.1, (now - lastT) / 1000);
    lastT = now;
    const k = 1 - Math.exp(-dt / 0.4);
    for (const v of vehicles.values()) {
      try {
        const shape = shapes[v.shapeId];
        if (!shape || !shape.cum?.length) continue;
        const total = shape.cum[shape.cum.length - 1];
        v.targetDist = Math.max(0, Math.min(total, v.targetDist + v.speed * SPEED_BOOST * dt));
        v.dist += (v.targetDist - v.dist) * k;
        const [lon, lat] = distToLonLat(shape, v.dist);
        v.position = [lon, lat, 0];
        v.angle = bearingAt(shape, v.dist);
      } catch { /* skip one bad vehicle */ }
    }
    updateLayers();
    drawBloom();
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
    const src = map.getCanvas();
    if (bloom.width !== src.width) { bloom.width = src.width; bloom.height = src.height; }
    bctx.clearRect(0, 0, bloom.width, bloom.height);
    bctx.drawImage(src, 0, 0);
  } catch { /* ignore */ }
}

function onHover(info: PickingInfo) {
  const v = info.object as Vehicle | undefined;
  if (v && (info.layer?.id === "trains" || info.layer?.id === "train-glow")) {
    const c = routes[routeOfShape(v.shapeId)];
    tipEl.style.display = "block";
    tipEl.style.left = info.x + 14 + "px";
    tipEl.style.top = info.y + 14 + "px";
    tipEl.innerHTML =
      `<span class="route-badge" style="background:${c?.color ?? "#3fd8ff"}">${v.route}</span>` +
      `<b>${v.route} train</b><br>` +
      (v.nextStopName ? `→ ${v.nextStopName}` : "en route") +
      `<br><span style="opacity:.6">${(v.speed * 2.237).toFixed(0)} mph</span>`;
  } else {
    tipEl.style.display = "none";
  }
}

let loggedFirst = false;
function applyState(list: any[]) {
  const seen = new Set<string>();
  for (const s of list) {
    if (!s.shapeId || !shapes[s.shapeId]) continue;
    seen.add(s.id);
    const ex = vehicles.get(s.id);
    if (ex) {
      ex.targetDist = s.dist; ex.speed = s.speed; ex.route = s.route; ex.nextStopName = s.nextStopName;
    } else {
      vehicles.set(s.id, {
        id: s.id, shapeId: s.shapeId, dist: s.dist, targetDist: s.dist, speed: s.speed,
        color: hex2rgb(s.color), route: s.route, nextStopName: s.nextStopName,
        position: [...distToLonLat(shapes[s.shapeId], s.dist), 0] as [number, number, number],
        angle: bearingAt(shapes[s.shapeId], s.dist),
      });
    }
  }
  for (const id of [...vehicles.keys()]) if (!seen.has(id)) vehicles.delete(id);
  statEl.textContent = `${vehicles.size} trains live · NYC subway`;
  (window as any).__tt = { vehicles, shapes, map, overlay };
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
  console.log(`[init] ${linePaths.length} lines, ${stationPts.length} stations`);
  connect();
  requestAnimationFrame(frame);
}

main().catch((e) => { statEl.textContent = "load error: " + e.message; console.error(e); });
