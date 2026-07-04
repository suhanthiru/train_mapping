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
      ⚠️ **NOT visually verified** — Chrome extension was offline in the autonomous session, so I
      could not screenshot the live render. Build + serve verified; in-browser render is the #1
      morning check. Hardened the known deck.gl v9 risks (SimpleMeshLayer texCoords, removed
      uncertain Deck params). If something's off it'll be train mesh orientation/scale or a deck API detail.
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
- Interpolation: some vehicles show speed 0 / next-stop `undefined` — vehicle-only entities
  (no TripUpdate) or STOPPED_AT with no forward stop. Improve next-stop coverage & moving fraction.
- Elevation is hardcoded "underground" — needs per-segment elevated/surface data for the
  "trains pass under each other" feature (deferred; needs a data source or heuristic).
- Broadcast is full-state each tick (264 vehicles); diffing is a later optimization.
- Straight-line fallback for unmatched trips not yet wired (currently skipped; ~3/269).

## Blockers encountered
_(none — all Phase 1 data dependencies verified; backend fully working against live data.)_
