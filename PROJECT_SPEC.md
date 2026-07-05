# Live 3D Transit Tracker — Project Spec

NYC / Atlanta (MARTA) / Paris (IDFM), driven by live GTFS-realtime feeds, rendered as a
real 3D "model city at night" diorama. This document is the single source of truth for
the build — architecture, data model, algorithms, and every locked design decision.

---

## 1. What this is

A live, public, browser-based 3D map where real subway/metro/rail (and later bus/tram)
vehicles glide along their actual track geometry, reconstructed from each agency's live
GTFS-realtime feed. Trains are real 3D models (not flat dots), rendered in a stylized
"model railway diorama at night" aesthetic, with correct elevation so underground trains
are visibly *underneath* surface trains and buildings when you tilt the camera. Hovering
anything (trains, streets, stations, buildings) shows rich live info; clicking a train
highlights its full route and dims everything else; a history DB backs a scrub/rewind
timeline; a search bar flies the camera to any line or station.

Cost: **$0/month**, fully free stack end to end (Part 3).

---

## 2. End-to-end data flow (a single train, feed to screen)

1. Agency publishes a GTFS-realtime protobuf feed (~every 30s): "trip 12345 on the A line
   is in transit to Jay St, predicted arrival 14:32:10."
2. **Ingest adapter** (Node/TS, on the backend VM) fetches + decodes protobuf into a
   normalized `RawVehicle`.
3. **Interpolation core** matches the trip to its static-GTFS `shape` (the real track
   polyline), computes `distanceAlong(now)` and `speed` from the predicted-arrival math
   (Section 6), and writes a snapshot to SQLite (rolling 7-day retention).
4. **WebSocket fan-out** pushes a diff of changed vehicles (~every 1-2s) to all connected
   browsers.
5. **Browser** receives `{dist, speed}` per vehicle and runs a 60fps animation loop that
   tweens the 3D model continuously along the shape, easing toward corrections instead of
   snapping when new data arrives.
6. Rendered through the visual system in Section 8 (dark diorama, bloom, per-line colors).

---

## 3. Cost & hosting — zero-cost stack

| Layer | Choice | Why free |
|---|---|---|
| Renderer | MapLibre GL JS + deck.gl (`ScenegraphLayer`) | OSS, no token |
| Map tiles | Protomaps (PMTiles) on Cloudflare R2, or OpenFreeMap | No key, no per-request cost |
| Data feeds | MTA (no key), MARTA (free key), IDFM PRIM (free token) | Public/open |
| Backend host | **Oracle Cloud Always Free** VM (4 ARM OCPU / 24GB RAM) | Free forever (per current ToS) |
| Frontend host | Cloudflare Pages | Free static hosting + CDN |
| Domain | Free subdomain (Cloudflare `*.pages.dev` / free DNS) for v1 | No domain purchase needed |
| WebSocket | Runs on the same Oracle VM | Free |

Note: "Always Free" tiers are provider policy, not a guarantee — keep the VM lightly
active and the setup scripted/reproducible so it can be redeployed elsewhere if reclaimed.

---

## 4. System architecture (Option B — always-on VM, chosen)

```
AGENCY FEEDS (MTA / MARTA / PRIM)
        │ poll ~30s
        ▼
Ingest adapters (one per agency, normalize to common schema)
        │
        ▼
Interpolation core (trip→shape match, distanceAlong(t), speed)
        │  ├─→ SQLite (rolling 7-day history, for scrub/playback)
        │
        ▼
WebSocket fan-out (diffs only, ~1-2s cadence, full snapshot on connect)
        │
        ▼
Browser: MapLibre (3D basemap) + deck.gl ScenegraphLayer (3D vehicle models)
         60fps tween/ease loop + hover/click UI + search + scrub playback
```

Static GTFS (shapes.txt, stops.txt, routes.txt) is preprocessed **offline** (daily cron)
into compact per-city JSON: polylines with precomputed cumulative distance, stop lookup
tables, route color tables. Served as static files, loaded once per city on selection.

**Design principles:**
- One central poller only — never let browsers hit agency feeds directly (protects rate
  limits, hides keys, decouples viewer count from feed load).
- Backend computes *where* (sparse ground truth); frontend computes *smooth* (60fps tween
  + correction easing). Keeps WebSocket traffic tiny and motion fluid even with a laggy feed.
- Every city normalizes to one internal schema; each city is a swappable adapter.
- Static (slow-changing) vs. realtime (fast-changing) data is architecturally separated.

**Ops implications of choosing the always-on VM (accepted tradeoff):**
- systemd (`Restart=always`) keeps the Node process alive across crashes.
- Caddy handles TLS + WebSocket upgrade proxying in front of the Node process.
- No uptime monitoring in v1 (explicit decision — add later if this graduates beyond hobby scope).
- You are the on-call for this service; that's the accepted cost of real-time push + shared state.

---

## 5. Normalized data model

```ts
// Live, over WebSocket — kept small
type VehicleState = {
  id: string;          // `${city}:${tripId}`
  city: "nyc" | "atl" | "par";
  mode: "subway" | "bus" | "tram" | "rail";
  route: string;        // "A", "RER B", "MARTA Red"
  color: string;         // hex, from routes.txt (real official agency color)
  shapeId: string;
  dist: number;          // meters along shape — the backend's computed truth
  speed: number;         // m/s, for client-side tween
  bearing?: number;
  elevation: "underground" | "surface" | "elevated"; // drives synthetic depth (Section 8)
  nextStop?: string;
  delay?: number;        // seconds, +late/-early
  stale?: boolean;
};

// Static, loaded once per city
type Shape = { id: string; pts: [number, number][]; cum: number[] }; // cum = cumulative meters
type Stop  = {
  id: string; name: string; pos: [number, number]; shapeDist?: number;
  connectedRoutes: string[]; // for "hover a station → show all connected lines" feature
};

// SQLite history (rolling 7-day)
type HistorySnapshot = { ts: number; vehicleId: string; dist: number; speed: number; delay?: number };
```

---

## 6. Interpolation algorithm (the hard part)

Per vehicle, per ingest tick:

1. **Resolve the shape**: `trip_id` → `shape_id` → precomputed polyline + cumulative distances.
2. **Anchor to known points**: last observed "departed stop" (time + shapeDist) and next
   predicted stop (predicted arrival time + shapeDist). For NYC (no GPS), the depart
   anchor is the last observed `STOPPED_AT`→`IN_TRANSIT_TO` transition, persisted by ingest.
3. **Linear-time interpolation:**
   ```
   frac  = clamp((now - departTime) / (arriveTime - departTime), 0, 1)
   dist  = departDist + frac * (arriveDist - departDist)
   speed = (arriveDist - departDist) / (arriveTime - departTime)
   ```
4. **Emit** `{dist, speed}` — the frontend takes it from here at 60fps.
5. **Correction easing** (critical for "smooth"): when a fresher prediction revises `dist`,
   the frontend never snaps — it eases `dist → targetDist` over ~0.5s. This single detail
   is the difference between "stunning" and "janky."
6. **Edge cases:**
   - Past predicted arrival → clamp at stop, mark dwelling.
   - Trip not in static GTFS / shape match fails → **straight-line fallback** between known
     stop coordinates rather than hiding the vehicle (explicit decision).
   - Feed stale (old timestamp) → freeze position, mark `stale`, dim in the UI.

---

## 7. Locked build & feature decisions

**Stack**
- Backend: Node.js / TypeScript (ingest, interpolation, WebSocket, SQLite)
- Frontend: Vanilla TS + Vite (not React — the complexity lives in the 3D scene, not app state)
- Repo: public on GitHub
- Domain: free subdomain for v1

**System behavior**
- Poll rate: ~30s (matches real agency feed refresh cadence)
- History: SQLite, rolling 7-day retention — powers the scrub/rewind feature
- Monitoring: none in v1 (explicit choice)
- Reconnect UX: silent auto-reconnect, no visible banner
- Unmatched trips: straight-line fallback, never hidden

**Build order**
1. NYC subway fully built (ingest → interpolation → SQLite → 3D rendering, one line first)
2. MARTA added as a second adapter
3. Paris (IDFM PRIM) added as a third adapter
4. Buses/trams added last, as toggleable lazy-loaded layers (much higher vehicle count)

**Core features**
- Search bar → camera flies to a line or station
- Click a train → highlights its full route, dims everything else
- Hover a train → line/name/capacity (if available)/destination/ETA
- Hover a station → all connected routes (bus + rail) at that station
- Hover a street → street name
- Hover a building (in 3D) → building info
- Scrub/rewind playback UI, built now (not deferred), backed by the SQLite history table
- Mobile: desktop-first for v1; responsive/touch later

**3D rendering approach**
- Real 3D model instancing via deck.gl `ScenegraphLayer` (glTF meshes), not flat dots/`TripsLayer`
- Model fidelity: stylized "model railway diorama" look — not photoreal, not fleet-accurate
  per-agency rolling stock (that's a later add-on, not v1)
- Buses rendered as bus models driving on road-level geometry (not trains)
- Elevation/depth: **combined approach** — subway segments render on a lower synthetic
  elevation plane (below street level, dimmer/desaturated) *plus* light tunnel-tube geometry
  where cheap, so tilting the camera makes "train A passes under train B" visually obvious
- Performance: LOD (level of detail) — full model detail up close, simplified geometry at
  distance, tuned to hold a constant target frame rate rather than a fixed detail level

---

## 8. Visual / color system (final)

**Ambient scene palette — extracted from user-provided reference file
("NYC Elevated Trains standalone.html", a Three.js diorama) and adopted for
coloring + opacity only:**

| Element | Value | Source |
|---|---|---|
| Background | `#000103` | reference (`scene.background`) |
| Fog | `FogExp2(#00040a, density 0.012)` | reference |
| Ground plane | `#000000`, roughness 0.4 / metalness 0.6 | reference |
| Ground/street grid glow | primary `#1fd8ff`, secondary `#0c3a4a` | reference (`GridHelper`) — doubles as our "neon-accented streets" decision |
| Ambient light | `#0a1520` @ 0.55 intensity | reference |
| Rim/directional light | `#3a6fae` @ 0.35 intensity, high-behind | reference |
| Building base tone | warm amber/orange (`#7a2f04` family) | reference `buildingHex`, matches our "warm building windows" decision |
| Building texture | solid face + black grid overlay: 3px @ 85% opacity (window mullions), 7px @ 95% opacity (edge border) | reference `makeHardlightTexture` |
| Building/mesh edge glow | outline via `EdgesGeometry`, opacity ~0.9, accent color | reference `addEdgeGlow` — matches our "dark translucent glass, subtle edge lighting" decision |
| Track/lane glow strip | `#0a2a33`, opacity 0.6, transparent plane | reference `laneGlow` |
| Vehicle body material | opacity 0.86, transparent even on "solid" surfaces | reference |
| Tone mapping | ACES Filmic, sRGB output encoding | reference |
| **Bloom technique** | cheap dual-render: whole scene re-rendered to a transparent overlay canvas, composited with CSS `mix-blend-mode: screen`, styled with CSS `filter: blur(Npx) brightness(x) saturate(y)` + layer `opacity` — **not** a GPU postprocess pass | reference — adopted directly, simpler to integrate with deck.gl than `UnrealBloomPass` |
| Bloom intensity presets | subtle: blur 10 / bright 1.3 / sat 1.05 / op 0.4 — balanced: 17 / 1.9 / 1.4 / 0.95 — intense: 24 / 2.4 / 1.6 / 1.15 | reference `glowCfgs` — start on "balanced" |
| HUD text | label `rgba(150,235,255,.85)`, heading `#c8f7ff` + glow-shadow `rgba(90,230,255,.6)`, subtext `rgba(120,200,220,.55-.6)` | reference — informs our glassmorphism panel text styling |

**Decisions made independently of the reference (still standing):**
- Lighting mood: fixed dusk/night always — no day/night cycle
- Per-line colors: **real official agency colors** (MTA, MARTA, Paris metro palettes) —
  layered on top of the ambient scene palette above, not replaced by it
- Water: reflective stylized dark water (rivers/Seine)
- Sky: starry night skybox with warm horizon glow
- UI panels: glassmorphism (translucent frosted glass)
- UI accent: single signature electric-cyan accent (aligns with reference's cyan HUD text)
- Focus mode: clicking a train dims everything else, highlights its full route

---

## 9. Repo structure

```
train-tracker/
├─ ingest/           # adapters: nyc.ts, marta.ts, paris.ts + shared protobuf decoder
├─ core/             # interpolation engine, in-memory state, diffing
├─ server/           # WebSocket fan-out, HTTP static serving
├─ history/          # SQLite schema + writer + query API for scrub playback
├─ preprocess/       # static GTFS → shapes/stops JSON (daily cron)
├─ web/               # MapLibre + deck.gl frontend (Vite)
│  ├─ layers/         # ScenegraphLayer setup, elevation/depth logic, LOD
│  ├─ bloom/          # dual-canvas CSS-blend bloom (Section 8)
│  ├─ anim/           # 60fps tween + correction easing
│  └─ ui/             # search, hover tooltips, station panel, scrub timeline, glassmorphism panels
├─ data/              # generated static geometry (gitignored)
└─ infra/             # Oracle VM setup script, Caddyfile, systemd units
```

---

## 10. Phased plan

1. **NYC subway, one line, local.** Ingest → interpolation → SQLite → 3D model rendering
   with the full visual system above. Proves the hardest part (interpolation + easing +
   3D depth) end to end.
2. **All NYC subway lines** + full hover/click interactions + search + scrub playback.
   This is the "wow" milestone / demo-ready checkpoint.
3. **Deploy**: Oracle VM (backend) + Cloudflare Pages (frontend) + Protomaps tiles → live public app.
4. **Add MARTA**, then **Paris (PRIM)** as adapters.
5. **Buses/trams** as toggleable, lazy-loaded layers (real volume/performance test for LOD).

## 11. Known risk list (carried forward, unresolved by design — not blockers)

- Interpolation smoothness under prediction revisions (mitigated by easing, Section 6.5)
- Paris PRIM auth/coverage is the fiddliest of the three feeds
- Bus data volume is a real scaling exercise — deliberately deferred to Phase 5
- Static/realtime trip-ID matching occasionally fails — mitigated by straight-line fallback
- "Always Free" Oracle tier is a policy, not a contract — keep infra scripted/reproducible

---

## 12. Analytics layer — polyglot streaming anomaly detection + data fusion

A portfolio-oriented extension (added as a second phase after the core 3D tracker was
working) demonstrating streaming-analytics and data-fusion engineering across three
languages, each doing the part it's naturally suited for.

### Scope boundary (non-negotiable)

This layer reasons **only** about:
- Public transit vehicles already tracked by this project (subway trains, buses) —
  aggregate route/segment-level statistics (headway gaps, density per grid cell), never
  an individual vehicle's identity-linked history beyond what already exists.
- Public aggregate open-data sources: NWS weather observations (describes weather, not
  people) and NYC 311 complaint **category counts** (public dataset; `$select` allowlists
  only `complaint_type`, `descriptor`, `created_date`, lat/lon, `borough` — no
  complainant-identifying column is ever requested).

Explicitly out of scope, permanently: license plate recognition, vehicle-owner/operator
identification, fusion with any dataset that identifies a specific person, enforcement/
dispatch-override/ticketing features. Output is always descriptive ("this route shows
anomalous bunching"), never prescriptive-to-a-person. Correlation language only in all
"why" annotations ("nearby", "recent") — never a causal claim.

### Architecture — three services, three languages

```
Node/TS (existing, UNCHANGED)     Go (analytics-go/, :8090)      Python (analytics-py/, :8091)
──────────────────────────        ─────────────────────────       ────────────────────────────
GTFS decode, interpolation,        WS client -> :8080 (reads       stdlib http.server
3D rendering, WS server :8080      the SAME broadcast the          weather.py: api.weather.gov
  (now also decodes GTFS-rt         frontend already consumes —     nyc311.py: NYC Open Data
   occupancy into VehicleState)     server/index.ts needs ZERO      Socrata (see finding below)
                                    changes)                        server.py: GET /context
                                    Welford stats per route+dir,
                                    headway/bunching detection.
                                    SQLite (data/analytics.db,
                                    pure-Go modernc.org/sqlite):
                                      occupancy time series,
                                      baselines (persist+seed),
                                      anomaly_events
                                    serves :8090
                                      GET /anomalies (calls
                                      Python's /context on a
                                      separate ~15s enrichment
                                      timer, never in the hot
                                      per-tick WS path)
```

**Why each language:** TypeScript is untouched-in-spirit (proven, working — GTFS protocol
decode and 3D rendering are exactly what it already does well; only additive change was
decoding the occupancy field the feeds already carry). Go handles the compute-heavy
concurrent stream processing (Welford's online mean/variance per route+direction,
headway/bunching detection) and persistence. Python handles REST-API glue + human-readable
correlation text generation (weather, 311).

### Headway/bunching detection

- **Subway**: event-driven. Each route+direction gets one auto-selected reference stop
  (nearest the shape's midpoint, from `shapeStops.json`). Watches each train's remaining
  distance to that stop (already-continuous `dist` from the interpolator); a passage event
  fires when remaining distance crosses from positive to ≤0. The gap between consecutive
  passages at the same reference stop is a real headway sample.
  Simplification: uses each route+direction's *default* shape only (from
  `routeDirShape.json`) — an express/local variant that skips the chosen reference stop
  won't register a passage there. Acceptable for v1.
- **Bus**: no shape/route geometry exists for buses by design (`ingest/nyc-bus.ts` is
  GPS-only). Instead: every tick, the minimum pairwise haversine distance between
  same-route buses, converted to a time gap via the pair's average reported speed.
- **Baseline**: Welford's online mean/variance per key (O(1) memory, no raw-sample
  storage). No historical seeding from `history.db` was implemented in v1 (an
  acknowledged deferred enhancement — baselines start cold and build up live).
- **Anomaly flag**: z-score > 2.5 once a key has ≥20 samples, OR an absolute floor rule for
  cold start.

**Live-data calibration findings** (from actually running this against the feed, not
assumed):
- The bus floor rule started at 180s and flagged nearly every active route — straight-line
  (haversine) distance systematically *underestimates* true road-following distance in a
  dense street grid, so "close as the crow flies" doesn't mean "actually bunched." Tightened
  to 45s based on the observed gap distribution across ~30 live routes.
- NYC 311's current taxonomy has **no "Subway Delay" or general transit-service category**.
  Subway/bus service complaints go directly to the MTA (a state authority), not city 311.
  The closest genuinely transit-adjacent categories are `Bus Stop Shelter Complaint` /
  `Bus Stop Shelter Placement` — about the physical shelter structure, not service — used
  honestly labeled as such rather than mislabeled as delay complaints. There is no subway
  311 proxy at all; this is a real, permanent gap in the fusion, not a bug.
- The default 24h 311 lookback window was widened to 72h — live volume checks showed only
  ~4 complaints/day citywide for the relevant categories, so 24h was usually zero.

### Data model / storage

`analytics-go` maintains its own SQLite database (`data/analytics.db`) via the pure-Go
`modernc.org/sqlite` driver (no cgo / no native build toolchain — same rationale as
`node:sqlite` over `better-sqlite3` on the TS side). Kept separate from the Node server's
`history.db` to avoid two-process concurrent-writer contention. Three tables:

- **`occupancy`** — a time series of vehicle crowding for future analytics, written
  **on-change only** (a row is inserted just when a vehicle's occupancy status transitions,
  not every 4s tick — a compact state-transition series, not a firehose). Columns:
  `ts, vehicleId, route, mode, status, pct, lon, lat`. Rolling 30-day retention.
- **`baselines`** — the persisted Welford state (`n, mean, m2`) per route+direction key,
  upserted every 30s. **Loaded on startup so anomaly detection is warm on restart instead
  of cold-starting at n=0** (this is the "constant anomaly detection" requirement — verified
  live: a fresh run seeds 0, a subsequent run seeds ~40 baselines from disk). Never pruned
  (one row per key).
- **`anomaly_events`** — one row per anomaly *onset* (logged when a key transitions into a
  flagged state, not every tick it stays flagged), for future analytics. Rolling 30-day
  retention.

(Historical note: an earlier draft of this doc incorrectly stated Go had no database — that
was written before this table existed. The DB is real and verified.)

### Occupancy / crowding

Both the NYC subway and OBA bus GTFS-realtime feeds carry `occupancyStatus` (and a usually-
placeholder `occupancyPercentage`) on **100% of vehicles** (verified live: 57/57 subway,
797/797 bus). This is decoded in `shared/occupancy.ts` (used by both ingest adapters),
threaded through `VehicleState` into the WebSocket broadcast, and:
- **Displayed** in the click-a-vehicle panels — the train journey panel gains an occupancy
  row above the stop timeline; clicking a bus now opens a small panel with route, speed, and
  occupancy. Friendly label + green→amber→red color scale (`EMPTY` → `FULL`); the percentage
  is shown only when non-zero (the feed usually sends 0 as a placeholder, so the enum status
  is the reliable signal and is what's led with).
- **Persisted** by Go into the `occupancy` table (on-change) for future spatio-temporal
  crowding analytics.

(The earlier density heatmap was removed at the user's request — vehicle-count density was
"weird"; occupancy is the more meaningful crowding signal and is surfaced per-vehicle
instead.)

### API surface

- Go (`:8090`): `GET /anomalies`, `GET /health`
- Python (`:8091`): `GET /context?routeId=&lat=&lon=`, `GET /health`
- Frontend fetches `:8090/anomalies` directly (not proxied through the Node server) — polled
  every 5s. Occupancy comes through the existing `:8080` WebSocket, not a new endpoint.

### Running the three services

Each runs in its own terminal (no combined start script built — not asked for):
```bash
# 1. Node backend (as before)
npm run server

# 2. Go analytics service
cd analytics-go
../.tools/go/bin/go.exe run .   # or: go build -o analytics.exe . && ./analytics.exe

# 3. Python analytics service (stdlib only, no pip install needed)
cd analytics-py
python server.py
```
Frontend: the `#anomalies` panel (top-right) appears automatically whenever the Go service
reports ≥1 flagged anomaly; click any train or bus to see its occupancy (plus the train's
upcoming-stop timeline). The density heatmap toggle was removed.
