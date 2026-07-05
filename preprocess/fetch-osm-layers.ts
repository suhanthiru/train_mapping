// One-time fetch of NYC subway way geometry + layer/tunnel/bridge tags from
// OpenStreetMap, via the public Overpass API. Standalone CLI tool, never
// imported by the running server — output is committed static data.
//
// Run: npm run preprocess:osm-layers

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";
const OUT_DIR = join(process.cwd(), "data", "nyc");

// NYC bbox (south, west, north, east) — covers all five boroughs plus SIRT.
const BBOX = "40.49,-74.26,40.92,-73.68";

const QUERY = `
[out:json][timeout:90];
(
  way["railway"="subway"](${BBOX});
  way["railway"="rail"]["service"="rail"](${BBOX});
);
out tags geom;
`;

interface OsmWay {
  id: number;
  tags: Record<string, string>;
  geometry: { lat: number; lon: number }[];
}

async function main() {
  mkdirSync(OUT_DIR, { recursive: true });
  console.log("[osm-layers] querying Overpass API for NYC subway ways...");
  const res = await fetch(OVERPASS_URL, {
    method: "POST",
    body: "data=" + encodeURIComponent(QUERY),
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "train-tracker-hobby-project/0.1 (offline one-time data prep)",
      Accept: "*/*",
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Overpass query failed: HTTP ${res.status} — ${body.slice(0, 500)}`);
  }
  const json = await res.json();
  const elements: any[] = json.elements ?? [];

  const ways: OsmWay[] = elements
    .filter((e) => e.type === "way" && Array.isArray(e.geometry))
    .map((e) => ({
      id: e.id,
      tags: e.tags ?? {},
      geometry: e.geometry,
    }));

  console.log(`[osm-layers] got ${ways.length} ways`);
  const tagged = ways.filter(
    (w) => w.tags.layer || w.tags.tunnel || w.tags.bridge || w.tags.level
  );
  console.log(
    `[osm-layers] ${tagged.length}/${ways.length} ways carry layer/tunnel/bridge/level tags`
  );

  const p = join(OUT_DIR, "osm-subway-ways.json");
  writeFileSync(p, JSON.stringify(ways));
  console.log(`[osm-layers] wrote ${p}`);
}

main().catch((e) => {
  console.error("[osm-layers] FETCH FAILED:", e);
  process.exit(1);
});
