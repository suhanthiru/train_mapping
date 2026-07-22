# Live 3D Transit Tracker

A live, browser-based 3D map that reconstructs real subway/metro trains gliding
along their actual track geometry, driven by agencies' live GTFS-realtime feeds.
Rendered as a stylized "model railway at night" diorama with deck.gl — plus a
self-improving ETA-prediction stack (XGBoost v1/v2, historical pretraining,
anomaly detection) graded head-to-head against the official feed.

**Status:** NYC subway live end-to-end: ingest → Kalman interpolation → 3D render →
prediction ledger → auto-retraining models → analytics dashboard → anomaly API.
Atlanta (MARTA) and Paris (IDFM) planned as additional adapters. See
[PROJECT_SPEC.md](PROJECT_SPEC.md) for the design, [docs/architecture.html](docs/architecture.html)
(served at `/docs/architecture.html`) for the current system diagram, and
[docs/explainer.html](docs/explainer.html) for the plain-words tour.

## Quick Start (Docker Compose)

The easiest way to run the entire stack (macOS, Linux, Windows):

### 1. One-time setup

**Linux / macOS / WSL / Git Bash:**
```bash
chmod +x setup.sh
./setup.sh
```

**Windows PowerShell:**
```powershell
.\setup.ps1
```

This downloads NYC subway geometry, builds the map UI, and validates everything.

### 2. Start the stack

```bash
docker compose up --build
```

Then visit:
- **3D Map:** http://localhost:8088
- **Analytics Dashboard:** http://localhost:4174
- **Service Hub:** http://localhost:8088/hub

Press Ctrl+C to stop.

**That's it.** All 5 services (map, analytics, predictions, anomalies, Kalman filter) start automatically.

For 24/7 hosting on a server, see [DEPLOY.md](DEPLOY.md).

---

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

# 4. start EVERYTHING with one command (backend, analytics, kalman, dashboard, web dev)
npm run dev:all
# then open the service hub: http://localhost:8088/hub
```

`npm run dev:all` starts all five services with name-prefixed joined logs and
stops the whole tree on Ctrl+C. The **service hub** at
[localhost:8088/hub](http://localhost:8088/hub) shows a live health dot + link
for each service — one bookmark instead of five ports:

| Service | Port |
|---|---|
| Backend API + 3D map + hub/docs | 8088 |
| Analytics API (FastAPI, models + anomaly) | 8091 |
| Kalman sidecar (Rust) | 8092 |
| Analytics dashboard | 4174 |
| Web dev server (Vite HMR) | 5173 |

Individual pieces still work standalone (`npm run server`, `python analytics-py/app.py`,
`node dashboard/serve.mjs`, `cd web && npm run dev`), and `docker compose up` remains
the production path (see [DEPLOY.md](DEPLOY.md)).

## Data sources

- **NYC** — MTA GTFS-realtime (no API key). Static GTFS from `rrgtfsfeeds.s3.amazonaws.com`.
- **Atlanta** — MARTA (free API key), planned.
- **Paris** — Île-de-France Mobilités PRIM (free token), planned.

## License / attribution

Transit data © the respective agencies under their open-data terms. This project is
an independent visualization and is not affiliated with any transit agency.
