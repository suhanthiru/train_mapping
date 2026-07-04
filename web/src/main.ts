// Live 3D transit scene: glowing subway network + real trains gliding along the
// track geometry, driven by the backend WebSocket feed. PROJECT_SPEC.md §8.

import { Deck, MapView, type PickingInfo } from "@deck.gl/core";
import { PathLayer, ScatterplotLayer } from "@deck.gl/layers";
import { SimpleMeshLayer } from "@deck.gl/mesh-layers";
import { distToLonLat, bearingAt, type Shape } from "./geo.ts";
import { trainMesh } from "./mesh.ts";

const HOST = location.hostname || "localhost";
const HTTP = `http://${HOST}:8080`;
const WS = `ws://${HOST}:8080`;

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

const routeOfShape = (shapeId: string) => shapeId.split("..")[0];
const shapeColor = (shapeId: string): [number, number, number] => {
  const r = routes[routeOfShape(shapeId)];
  return r ? hex2rgb(r.color) : [63, 216, 255];
};

const deck = new Deck({
  canvas: "deck-canvas",
  views: new MapView({ repeat: false }),
  initialViewState: { longitude: -73.97, latitude: 40.75, zoom: 11, pitch: 55, bearing: 20 },
  controller: true,
  onHover: onHover,
});

function buildStaticLayers() {
  const linePaths = Object.values(shapes).map((s) => ({
    path: s.pts,
    color: shapeColor(s.id),
  }));
  return [
    new PathLayer({
      id: "lines",
      data: linePaths,
      getPath: (d: any) => d.path,
      getColor: (d: any) => [...d.color, 180],
      getWidth: 2,
      widthMinPixels: 1.5,
      widthMaxPixels: 6,
      capRounded: true,
      jointRounded: true,
      parameters: { depthTest: false },
    }),
  ];
}

let stationLayer: ScatterplotLayer | null = null;
function buildStationLayer(stops: Record<string, Stop>) {
  const pts = Object.values(stops).filter((s) => s.pos && s.pos[0]);
  stationLayer = new ScatterplotLayer({
    id: "stations",
    data: pts,
    getPosition: (d: any) => d.pos,
    getFillColor: [140, 220, 255, 90],
    getRadius: 30,
    radiusMinPixels: 1,
    radiusMaxPixels: 4,
    parameters: { depthTest: false },
  });
}

function trainLayer() {
  return new SimpleMeshLayer({
    id: "trains",
    data: [...vehicles.values()],
    mesh: MESH as any,
    getPosition: (d: Vehicle) => d.position,
    getColor: (d: Vehicle) => d.color,
    getOrientation: (d: Vehicle) => [0, 90 - d.angle, 90],
    sizeScale: 2.4,
    pickable: true,
    material: { ambient: 0.7, diffuse: 0.6, shininess: 40 },
    parameters: { depthTest: true },
  });
}

function render() {
  deck.setProps({
    layers: [...buildStaticLayers(), stationLayer, trainLayer()].filter(Boolean),
  });
}

// --- animation: dead-reckon the anchor forward + ease render toward it ---
let lastT = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  const k = 1 - Math.exp(-dt / 0.4); // correction easing time-constant
  for (const v of vehicles.values()) {
    const shape = shapes[v.shapeId];
    if (!shape) continue;
    const total = shape.cum[shape.cum.length - 1];
    v.targetDist = Math.max(0, Math.min(total, v.targetDist + v.speed * dt));
    v.dist += (v.targetDist - v.dist) * k;
    const [lon, lat] = distToLonLat(shape, v.dist);
    v.position = [lon, lat, 0];
    v.angle = bearingAt(shape, v.dist);
  }
  render();
  drawBloom();
  requestAnimationFrame(frame);
}

// --- dual-canvas bloom (reference technique), defensive ---
const bloom = document.getElementById("bloom-canvas") as HTMLCanvasElement;
const bctx = bloom.getContext("2d");
const deckCanvas = document.getElementById("deck-canvas") as HTMLCanvasElement;
function drawBloom() {
  if (!bctx) return;
  try {
    if (bloom.width !== deckCanvas.width) { bloom.width = deckCanvas.width; bloom.height = deckCanvas.height; }
    bctx.clearRect(0, 0, bloom.width, bloom.height);
    bctx.drawImage(deckCanvas, 0, 0);
  } catch { /* ignore if canvas not readable */ }
}

function onHover(info: PickingInfo) {
  const v = info.object as Vehicle | undefined;
  if (v && info.layer?.id === "trains") {
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

function applyState(list: any[]) {
  const seen = new Set<string>();
  for (const s of list) {
    if (!s.shapeId || !shapes[s.shapeId]) continue;
    seen.add(s.id);
    const ex = vehicles.get(s.id);
    if (ex) {
      ex.targetDist = s.dist; ex.speed = s.speed;
      ex.route = s.route; ex.nextStopName = s.nextStopName;
    } else {
      vehicles.set(s.id, {
        id: s.id, shapeId: s.shapeId,
        dist: s.dist, targetDist: s.dist, speed: s.speed,
        color: hex2rgb(s.color), route: s.route, nextStopName: s.nextStopName,
        position: [...distToLonLat(shapes[s.shapeId], s.dist), 0] as [number, number, number],
        angle: bearingAt(shapes[s.shapeId], s.dist),
      });
    }
  }
  for (const id of [...vehicles.keys()]) if (!seen.has(id)) vehicles.delete(id);
  statEl.textContent = `${vehicles.size} trains live · NYC subway`;
}

function connect() {
  const ws = new WebSocket(WS);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === "snapshot" || m.type === "state") applyState(m.vehicles ?? []);
  };
  ws.onclose = () => { statEl.textContent = "reconnecting…"; setTimeout(connect, 2000); };
  ws.onerror = () => ws.close();
}

async function main() {
  const [sh, ro, st] = await Promise.all([
    fetch(`${HTTP}/data/nyc/shapes.json`).then((r) => r.json()),
    fetch(`${HTTP}/data/nyc/routes.json`).then((r) => r.json()),
    fetch(`${HTTP}/data/nyc/stops.json`).then((r) => r.json()),
  ]);
  shapes = sh; routes = ro;
  buildStationLayer(st);
  render();
  connect();
  requestAnimationFrame(frame);
}

main().catch((e) => { statEl.textContent = "load error: " + e.message; console.error(e); });
