# Live 3D Transit Tracker

A live, browser-based 3D map that reconstructs real subway/metro trains gliding
along their actual track geometry, driven by agencies' live GTFS-realtime feeds.
Rendered as a stylized "model railway at night" diorama with deck.gl.

**Status:** Phase 1 (NYC subway) complete — live ingest → interpolation → 3D render.
Atlanta (MARTA) and Paris (IDFM) planned as additional adapters. See
[PROJECT_SPEC.md](PROJECT_SPEC.md) for the full design and [NIGHTLY_LOG.md](NIGHTLY_LOG.md)
for build progress.

## How it works

GTFS-realtime gives predicted arrival times per stop, not continuous GPS — so the
backend reconstructs each train's position *along the real track polyline* from the
static GTFS `shapes`, and the frontend tweens it at 60fps with correction-easing.

```
MTA feed ──poll 30s──▶ ingest (protobuf decode)
                          │
                          ▼
                   interpolation core  ──▶ SQLite history (rolling 7-day)
                   (position along shape)
                          │ WebSocket
                          ▼
              deck.gl scene: glowing MTA-colored lines +
              3D train meshes, 60fps tween + bloom
```

- **Backend** (`ingest/`, `core/`, `history/`, `server/`) — Node.js + TypeScript, run
  with `tsx`. Uses Node 24's built-in `node:sqlite` (no native builds).
- **Preprocess** (`preprocess/`) — downloads static GTFS, precomputes track polylines
  with cumulative distance and ordered stops-per-shape.
- **Frontend** (`web/`) — Vite + deck.gl (`SimpleMeshLayer` trains, `PathLayer` lines),
  dark diorama palette, dual-canvas CSS bloom, glassmorphism UI.

## Run it locally

Requires Node 24+. (A portable Node is vendored under `.tools/` for the dev machine.)

```bash
# 1. install backend + frontend deps
npm install
cd web && npm install && cd ..

# 2. download + preprocess NYC static GTFS (writes data/nyc/*.json)
npm run preprocess:nyc

# 3. build the frontend
cd web && npm run build && cd ..

# 4. start the server (serves the app + live data on :8080)
npm run server
# open http://localhost:8080
```

For frontend live-reload during development: `cd web && npm run dev` (app on :5173),
with `npm run server` also running for the data/WebSocket.

## Data sources

- **NYC** — MTA GTFS-realtime (no API key). Static GTFS from `rrgtfsfeeds.s3.amazonaws.com`.
- **Atlanta** — MARTA (free API key), planned.
- **Paris** — Île-de-France Mobilités PRIM (free token), planned.

## License / attribution

Transit data © the respective agencies under their open-data terms. This project is
an independent visualization and is not affiliated with any transit agency.
