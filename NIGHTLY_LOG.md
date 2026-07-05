# Nightly Build Log

Autonomous overnight build of the Live 3D Transit Tracker (see [PROJECT_SPEC.md](PROJECT_SPEC.md)).
Mode: continuous through phases, skip-and-note on hard blockers, git commit at each milestone.

## Environment (verified before sleep)
- Portable Node **v24.18.0** LTS + npm 11.16.0 at `.tools/node-v24.18.0-win-x64` (not on system PATH — prepend it in shell calls).
- `node:sqlite` built-in available → no native build (avoids better-sqlite3 / node-gyp risk).
- Python 3.11.9, git 2.54 present.
- Network OK. Confirmed reachable: live MTA feed (200, ~57KB), NYC static GTFS zip (200, 5.6MB), npm registry (200).
- NYC needs **no API key**. MARTA + Paris keys needed later (Phases 4) — will block those, not Phase 1.

## Cannot be done overnight (needs you)
- Deployment (Oracle VM + Cloudflare) — requires your interactive cloud logins.
- MARTA / Paris feeds — need free API keys/tokens from you.

## Progress
- [x] Phase 1 setup: repo scaffold, toolchain, configs. (commit: scaffold)
- [x] Portable Node 24.18 installed + verified (no admin needed).
- [x] `shared/types.ts` — normalized data model.
- [x] `preprocess/nyc.ts` — downloads real GTFS, builds shapes+cum distance / stops / routes / trips.
      VERIFIED vs live data: 29 routes, 257 shapes, 1488 stops, 20309 trips; sample shape = 23.52 km. ✓
- [x] `ingest/nyc.ts` — fetches + decodes all 8 live NYC subway feeds into RawVehicle[].
      VERIFIED vs live feed: 306 active trips, 279 with next-stop predictions, correct station names/ETAs. ✓
- [x] `shared/geo.ts` — project stops onto shapes, dist<->lonlat, bearing.
- [x] `core/interpolate.ts` — position along shape (§6). VERIFIED: 266 live trains, 100% in NYC bounds. ✓
- [x] `history/db.ts` — node:sqlite writer, rolling 7-day retention + scrub queries.
- [x] `server/index.ts` — 30s poll loop + WebSocket fan-out + static geometry serving.
      VERIFIED: /health=264 vehicles, ws snapshot delivered, data served. ✓ **Backend complete.**
- [~] `web/` — Vite + deck.gl 3D scene BUILT (908 modules, 0 errors). Backend serves it.
      Glowing colored subway lines (real MTA colors), 3D train meshes, 60fps tween + correction
      easing, WebSocket live feed, dual-canvas bloom, hover tooltips, glassmorphism HUD.
      ⚠️ **Functionally verified, pixels NOT verified.** Ran it via a headless preview browser:
      app loads with ZERO console errors, fetches shapes/routes/stops (200s), WebSocket connects
      with 264–268 live trains flowing into state, deck.gl instantiates with a live (non-lost) GL
      context. BUT requestAnimationFrame does not fire in the headless preview (no compositor), so
      deck.gl's resize + the render loop never tick there — canvas stayed 300×150 and screenshots
      timed out. This is an ENVIRONMENT limitation, not an app bug; a real browser ticks RAF fine.
      Added a ResizeObserver canvas-sizing guard (web/src/main.ts) as belt-and-suspenders.
      Chrome extension (for real screenshots) was offline all session.
      **#1 morning check:** open http://localhost:8080 in real Chrome — confirm trains render/move,
      then tune mesh orientation/scale, bloom, colors. Everything up to the GL draw is confirmed working.
      Added infra/static.mjs + .claude/launch.json (web-dist preview config) for quick local viewing.
- [ ] Phase 2: all-lines polish, click-to-focus route highlight, search bar, scrub playback UI,
      underground elevation, straight-line fallback, diff-based broadcast.

## ▶ HOW TO VIEW IT (morning)
```
# from D:\train_tracker, with portable node on PATH:
export PATH="/d/train_tracker/.tools/node-v24.18.0-win-x64:$PATH"   # (Git Bash)
npm run server        # serves built app + live data on http://localhost:8080
# then open http://localhost:8080 in Chrome
# to rebuild the frontend after edits:  cd web && npm run build
# for live-reload dev instead:          cd web && npm run dev   (app on :5173, backend must also run)
```

## Refinements to revisit (noted, non-blocking)
- [x] Interpolation moving fraction & next-stop coverage — FIXED (late trains creep instead of
      parking; next-stop derived from shapeStops). Now ~126/251 moving, 242/251 labeled.
- **Shape-variant matching (known limitation):** realtime trips resolve a shape by route+direction
  only, so express/local variants collapse onto one representative shape — a few trains can overlap
  at the same distance. Proper fix: match realtime trips to the correct static shape by stop pattern.
- Elevation is hardcoded "underground" — needs per-segment elevated/surface data for the
  "trains pass under each other" feature (deferred; needs a data source like OSM).
- Broadcast is full-state each tick (~250 vehicles, ~40KB/30s = negligible); diffing deferred —
  not worth the protocol risk to the (browser-unverified) frontend for no real bandwidth gain.
- Straight-line fallback effectively moot: route+dir fallback resolves 100% of trips to a shape;
  the ~26 dropped/tick have no stop anchor at all (unplaceable), which is correct to skip.

## Loop iteration 2 (backend refinements, verifiable)
- [x] Diagnosed feed (core/diag.ts): 238/277 have next-stop+ETA; 78 ETAs already past (the parking bug).
- [x] Fixed interpolation moving/labeling. Committed.
- [x] README.md for the public repo. Committed.
- Browser still offline — retried, no luck; frontend visual verification still pending real Chrome.

## Loop iterations 3-6 (user-driven fixes + features)
- [x] **Real 3D city**: MapLibre + OpenFreeMap vector tiles — 3D building extrusions, water, roads,
      dark warm palette. deck.gl trains as interleaved overlay. (user: "love the map and building design")
- [x] **Motion fix**: was snap-back bug (frontend boosted 5x + reset to real pos each update) + ~80%
      trains parked. Now continuous glide + gentle drift absorb; feed-anchored glide for dwelling/late
      trains -> 242/243 moving, verified advancing across pushes. Backend split feed-poll(30s)/push(4s).
- [x] **Real multi-car train mesh** (was a box).
- [x] **Live arrivals board**: /api/arrivals?stop=ID (verified: Times Sq real ETAs). Click a station
      in the UI -> glass panel with upcoming trains. Ingest now keeps upcoming-stop lists.
- Verified headless each step (0 console errors, data-layer live). Pixel-level look still needs the
  user's real Chrome (my screenshot tool offline all session).

## Vision gap
- [x] **Buses driving on roads** — OBA NYC bus GTFS-rt (real GPS, no key). ingest/nyc-bus.ts emits
      VehicleState with `pos`; server merges into stream (242 trains + 236 buses). Frontend renders
      amber bus meshes, dead-reckoned along bearing (isolated layer). Verified: 233 buses in app state.
- Trains visibly passing UNDER/OVER each other — needs per-segment elevation data (no clean source; OSM
  layer/tunnel tags would need extraction). BLOCKED on a data decision.
- Fleet-accurate models (R46/R160, MARTA, MP89) — asset work; low ROI while I can't see pixels.
- Click-to-focus route highlight; scrub/playback UI (history DB ready) — frontend, need pixel verification.
- MARTA + Paris adapters — need free API keys from the user.

## Edge of autonomous scope
Trains + motion + 3D city + arrivals + buses are built & data-verified. Most remaining asks now need
the user: (a) eyes on pixels (my screenshot tool offline all session), (b) MARTA/Paris API keys,
(c) a call on elevation data. Good point for a status/handoff report.

## Blockers encountered
_(none — all Phase 1 data dependencies verified; backend fully working against live data.)_

## Phase 2: Polyglot analytics layer (portfolio extension)

User wanted a portfolio piece demonstrating streaming-analytics/data-fusion skills (the
kind of engineering companies like Palantir/Flock do), scoped strictly to public
vehicles + public aggregate data (no individual tracking — see PROJECT_SPEC.md §12 Scope
Boundary), and explicitly wanted it to span multiple languages for skill demonstration:
**Go** for the streaming anomaly-detection service, **Python** for weather/311 data
fusion, alongside the existing TypeScript stack (left untouched).

All 10 planned build steps completed and live-data verified this session:

- [x] **analytics-go/ scaffolded**, portable Go 1.23.4 installed (no admin, same pattern as
      portable Node). Connects to the existing Node WS server as a plain client — verified:
      537 vehicles decoded correctly (387 trains + 150 buses) from the live snapshot+state
      broadcasts. `server/index.ts` needed **zero changes**.
- [x] **Density grid bucketing** — verified live: Midtown box consistently ~22-23 vehicles
      vs. 11 in an outer-borough box (~2x), matching real-world expectations.
- [x] **GET /density + frontend heatmap** (key `H`) — verified via browser fetch, 200 OK,
      0 console errors.
- [x] **Welford baseline + subway headway** — event-driven passage detection at an
      auto-selected reference stop per route+direction. Verified: caught REAL live passage
      events (`7|N: gap=192s`, `1|S: gap=184s`) — both plausible real subway headways.
      Debugging note: initially got zero samples for ~90s because I forgot to kill a stray
      prior process holding :8090, which made `log.Fatalf` silently kill the whole program
      before it ever processed a WS message — not a logic bug, a process-hygiene mistake.
- [x] **Bus proximity headway** — pairwise haversine distance -> time gap. Verified: M104
      route showed two buses 19m apart / 4s gap, a genuinely bunched pair.
- [x] **Anomaly thresholding** — z-score (>2.5, n>=20) + absolute floor rule for cold start.
      **Live calibration finding**: initial 180s bus-bunching floor flagged nearly every
      active route (straight-line distance underestimates real road-distance in a grid
      city) — tightened to 45s based on observed live gap distributions, dropping flagged
      routes from ~all to a selective ~6/40.
- [x] **GET /anomalies + #anomalies panel** — verified real rendered DOM content in a
      headless browser: "LIVE ANOMALIES (3)" with correct badges/kind/why-text.
      Caught and fixed two real bugs here: a grammar bug ("buss" instead of "buses") and a
      text-encoding mojibake bug (em-dash literal got corrupted somewhere in the write
      pipeline) — fixed by switching to a plain ASCII separator instead of fighting the
      encoding.
- [x] **analytics-py/ scaffolded** (stdlib only, no pip installs) — weather.py verified
      against live NWS (`api.weather.gov`): real data returned (75°F, "Heavy Rain",
      precipitating=true). nyc311.py verified against live Socrata data.
      **Real finding, not assumed**: NYC 311's current taxonomy has NO "Subway Delay" or
      general transit-service category — subway/bus service complaints go directly to the
      MTA (a state authority), not city 311. Closest real categories are
      `Bus Stop Shelter Complaint`/`Bus Stop Shelter Placement` (about the physical
      shelter, not service) — used honestly labeled as such. Also widened the lookback
      window from an assumed 24h to 72h after finding real volume is only ~4/day citywide
      for these categories (24h was usually zero).
- [x] **Go -> Python /context wiring** — enrichment runs on its own ~15s timer (separate
      goroutine), never blocking the hot per-tick WS path; store only gets overwritten by
      the enriched version, avoiding a race with the fast path. Verified end-to-end in a
      real browser DOM: `"Two buses only 2s apart - closer than expected (baseline still
      building, n=12). (active heavy rain in the area)"` — genuine data flowing through
      all three processes (Node -> Go -> Python -> Go -> frontend).
- [x] **Docs**: PROJECT_SPEC.md §12 (scope boundary + full architecture + calibration
      findings), this log entry. HUD hint string already included `[H]eat` from step 3.

**Process note**: no commits made this phase — user asked to review and commit everything
themselves at the end (see memory: feedback_no_auto_commit.md).

**Known follow-ups, not blocking**: no historical baseline seeding from `history.db` (v1
baselines start cold, build up live); no combined start script for the 3 services (not
asked for); subway-side 311 fusion has no real proxy available in the current NYC Open
Data taxonomy (documented limitation, not a bug).

## Phase 2b: persistence + occupancy + heatmap removal

User asked to: create the DB (the earlier phase had NONE — I'd wrongly documented one;
verified by inspecting go.mod/code and corrected the docs), store occupancy time series +
what's needed for constant anomaly detection, remove the "weird" density heatmap, and add
occupancy to the click-a-vehicle UI. All done and live-verified:

- [x] **Honest correction first**: confirmed the prior phase's analytics-go had zero
      persistence (go.mod only had gorilla/websocket, no .db file existed) — the
      PROJECT_SPEC claim of "writes analytics.db" was aspirational, never built. Fixed the
      docs, then actually built it.
- [x] **Occupancy through the TS pipeline**: verified both feeds carry occupancy on 100% of
      vehicles (57/57 subway, 797/797 bus). New shared/occupancy.ts decoder used by both
      ingest adapters; threaded via VehicleState into the WS broadcast. Verified live:
      425/461 vehicles carry occStatus (all buses + most trains), real distribution
      (mostly EMPTY off-peak). Note: occupancyPercentage is usually a 0 placeholder, so UI
      leads with the enum status.
- [x] **Go SQLite persistence** (modernc.org/sqlite, pure-Go, no cgo): 3 tables —
      occupancy (on-change writes, compact transition series), baselines (Welford n/mean/m2,
      upsert every 30s, LOAD on startup), anomaly_events (on onset). Added Welford
      State/Restore + detector Export/ImportBaseline + DrainNewEvents.
      **Verified the actual point of it**: run #1 fresh -> "seeded 0 baselines"; run #2 ->
      "seeded 39 baselines from disk" = anomaly detection is now WARM on restart, not
      cold. All 3 tables confirmed writing real rows (occupancy grew 8->60, anomaly_events
      6->43 over the session).
- [x] **Removed the density heatmap** entirely: frontend (H key, densityLayers, pollDensity,
      DensityCell, HUD hint) and Go (/density endpoint, internal/density package deleted,
      midtown/outer diagnostic removed). Both build clean.
- [x] **Occupancy in the click UI**: train journey panel gains an occupancy row (verified:
      "1 train / toward South Ferry / Empty" with colored dot); buses are now clickable ->
      new panel with route/speed/occupancy (verified: "B12 bus / 11 mph / Few seats").
      Green->amber->red status color scale in shared OCC_UI map.
- [x] Docs corrected throughout (PROJECT_SPEC §12: real DB, no heatmap, occupancy features;
      API surface; running instructions). This log entry.

Final state: all 3 services healthy together (Node 448 vehicles, Go 6 anomalies, Python ok),
analytics.db actively accumulating. No git commits (user commits themselves).

**New known follow-up**: the occupancy table currently keys on `vehicleId` which for subway
is the trip id (changes when a train finishes its trip) — fine for spatio-temporal
crowding analytics, but not a stable per-physical-train identity across trips (GTFS-rt
doesn't expose that for NYC anyway).

---

# Analytics roadmap build (2026-07-05) — branch `overnight-build`

5-phase build on top of the prediction ledger. Local per-phase commits (no push). Full plan in the session plan file.

## Done + verified + committed
- **Phase 1 — data future-proofing** (`ee14890`): `segments` edge/training table (`buildSegments`), DuckDB→Parquet exports (`history/export.ts`, `npm run export:*`), graph nodes/edges (401 nodes, 318 edges, 0 orphans), `data/SCHEMA.md`.
- **Phase 2 — Rust Kalman sidecar** (`92f63d8`): portable Rust toolchain installed (rustup GNU, no admin). `kalman-rs/` 1D constant-velocity filter service (:8092). Node wiring (pre-clamp `measuredDist` → async filter call → `uncertainty`, clamp fallback). Frontend `K` halo toggle. Verified live: 513 trains, **median 2m** position innovation, teleports damped, graceful degrade confirmed.
- **Phase 3 — XGBoost ETA** (`1282289`): `train_eta.py` (xgboost+polars) → `app.py` FastAPI (:8091, `/predict`, `/feature-importance`, `/docs`, ported `/context`+`/weather-score`). In-sample MAE 15.3s vs 29.4s predict-the-mean.
- **Phase 4 — dashboard** (`5dd3b6e`): `dashboard/` Chart.js site (:4174), system + per-train modes; `accuracy_snapshots` + new backend read endpoints. All panels render live.
- **Phase 5 — Docker** (`29fc6a1`): Dockerfile per service + `docker-compose.yml` + `.dockerignore`; Go paths env-configurable. Verified: all 5 images build (Go 31MB distroless, Rust 115MB), `docker compose up` runs the whole stack healthy, cross-container networking works, `./data` volume persisted the existing ledger (74.7k predictions).

## Honest limitations
- **Kalman**: tracks position tightly (2m) but its speed-innovation (~6–9 m/s) ≈ the 5.72 m/s clamp baseline — value is smoothing + uncertainty, not speed accuracy.
- **ONNX dropped**: `onnx` pip package won't install on Store-Python (Windows MAX_PATH, needs admin). Serve native XGBoost via FastAPI instead.
- **ETA model accuracy is thin** (~1 day of mostly-unique segments) — the pipeline is what's built; accuracy improves as the ledger matures.
- Headless preview throttles rAF, so charts/halos were verified via data + DOM inspection, not screenshots.
