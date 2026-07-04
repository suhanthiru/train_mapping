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
- [ ] `core/interpolate.ts` — position along shape from predictions + correction easing (§6). NEXT
- [ ] `history/db.ts` — node:sqlite writer, rolling 7-day.
- [ ] `server/index.ts` — WebSocket fan-out + static serving.
- [ ] `web/` — Vite + MapLibre + deck.gl 3D scene with the reference visual system.
- [ ] All NYC lines rendering + hover/click + search + scrub playback.

## Blockers encountered
_(none yet — all Phase 1 data dependencies verified reachable and working.)_
