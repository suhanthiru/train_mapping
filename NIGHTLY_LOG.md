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

## Vision gap still open (the "magnum opus" asks)
- Buses driving on roads (NYC bus GTFS-rt has real GPS — good next, verifiable at data layer)
- Trains visibly passing UNDER/OVER each other (needs per-segment elevation data — no clean source yet)
- Fleet-accurate models (R46/R160, MARTA, MP89) — asset work
- Click-to-focus route highlight (dim others); scrub/playback UI; MARTA + Paris adapters

## Blockers encountered
_(none — all Phase 1 data dependencies verified; backend fully working against live data.)_
