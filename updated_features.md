# Updated Features

Everything added, set up, or reconciled this session. Companion to
`fixed_errors.md` (which covers bug fixes). Grouped: **explanations** of things
that already existed but you asked me to walk through, **new** work, and a
**reconciliation** of the nice-to-have list.

---

## Explanations (already built — how they work)

### The continuous retraining job — `analytics-py/app.py`
Already implemented (roadmap Phase 5). How it works:
1. On startup, `load_model()` reads `eta_model.json` + `eta_features.json` into
   memory and serves them from `/predict` and `/predict-batch`.
2. A **daemon thread** (`_scheduler`) sleeps `RETRAIN_EVERY_S` (6 h), then calls
   `do_retrain()`.
3. `do_retrain()` → `train_eta.train()` reads the `segments` table from the
   ledger, fits XGBoost, and writes the model files → `load_model()` **hot-reloads**
   them (no restart, no downtime) → updates `_model_status` → refreshes the
   golden-set Parquet snapshot.
4. `POST /retrain` forces it on demand; `GET /health` reports
   `last_trained / mae / n_train`.

**What was actually wrong with it:** nothing in the logic — but it was silently
broken in a container because the ledger and model dir weren't mounted. Fixing
that (I2 in `fixed_errors.md`) is what makes the always-on retrain real.

### The lead-time breakdown — `history/ledger.ts` + `dashboard/app.js`
Already implemented (Phase 4/6). `accuracyByLeadTime(source)` buckets every graded
prediction by **actual** time-to-arrival — `0–1 / 1–2 / 2–5 / 5–10 / 10+ min` —
and reports **MAE and bias** per bucket, per source. The dashboard renders it for
both `gtfs-rt` (the feed) and the model side by side.

**Does it make sense? Yes.** Two reasons it's the right design:
- Bucketing by *true* lead time (not the predicted one) is what keeps the metric
  honest — you're grading "how wrong were we N minutes before arrival," which is
  the number a rider actually experiences.
- Splitting MAE from **bias** is what surfaces the I1 late bias: a model can have
  a so-so MAE but a large positive (late) bias in the 0–2 min buckets, and only
  the signed metric shows it. This breakdown is exactly the instrument that
  measures whether the model-v2 fix works.

### The always-on host — `DEPLOY.md`, `docker-compose.prod.yml`
The stack already had a prod compose overlay (`restart: unless-stopped` + bounded
logs) and a deploy guide. This session added:
- A concrete **Oracle Cloud Always-Free** walkthrough (genuinely $0/month with no
  12-month expiry, unlike AWS/GCP) — instance shape, SSH keys, port/firewall setup.
- A note that the ARM64 (Ampere) shape builds all Dockerfiles natively.
- The I2 persistence fix, which is the piece that makes unattended retraining
  survive restarts.
> I can't provision the VM for you (it needs your Oracle account + SSH key); the
> code and docs are deploy-ready so the only manual steps are signup and `ssh`.

---

## New work (this session)

### model-v2 — frac_hop-aware remaining-time ETA  ✅ built + trained + live
Replaces the naïve "add the whole in-progress hop" chaining. Trains on
`(features…, frac_hop, kalman_speed, trains_ahead) → remaining_seconds` from
`vehicle_log × actuals`, serves from `POST /predict-remaining`, and logs
`source='model-v2'` so the existing backtest grades it head-to-head vs v1.
- The "needs weeks of data" caveat turned out WRONG in the good direction: the
  forward-only logger had already banked **1.67M usable mid-hop samples**, so v2
  trained meaningfully immediately (MAE 46.5 s vs 63.2 s baseline; frac_hop = #1
  feature by gain at 2× distance_m).
- v1 keeps logging unchanged as the experimental control; both retrain on the
  same 6 h daemon; serving hot-reloads both.
- Full detail + the measured +129 s / +127 s v1 bias numbers: I1 in
  `fixed_errors.md`. The v2 verdict accrues live — read it via
  `npm run report:backtest` (paired same-trip/same-minute comparison) or the
  dashboard showdown panel (now 3 sources).

### Station-hourly-ridership feature (replacing occupancy)  ✅ built
A real busyness signal replacing the deleted occupancy field (I3). How it works:
- **`analytics-py/mta_ridership.py`** — Socrata client in the `nyc311.py` mold.
  Both dataset schemas were **verified live** (2026-07-08), per project convention:
  ridership `5wq4-mkjj` ("Beginning 2025") and stations `39hk-dx4f`
  (`gtfs_stop_id` ↔ `complex_id`; runtime stop ids strip their N/S suffix).
- **Bulk profile, not per-key queries:** one aggregate SoQL query (≤2 pages)
  builds `(station_complex, hour, dow) → avg riders/hr` over the last ~8 weeks,
  cached to `data/ridership_profile.json` with a weekly TTL. Training and serving
  lookups are O(1) and offline-tolerant (stale beats none).
  Honest caveat: avg = sum/(weeks in lookback), a slight underestimate for hours
  with zero-traffic days — fine for a relative busyness feature.
- **Joined entirely in Python** — deliberately NOT a ledger column: `train_eta.py`
  enriches rows at train time and `app.py` enriches identically inside
  `/predict`/`/predict-batch` (which already receive `to_stop`/`hour`/`dow`), so
  train/serve can't drift and Node needed zero changes.
- **Back-compat serving:** `_feature_row` now builds rows from the SAVED
  `feat_order`, so a model trained before the feature still serves correctly, and
  old models never trigger the profile fetch.
- **`GET /ridership?stop_id=&hour=&dow=`** endpoint for the dashboard/debugging.
- Feature list is now `route_id, from_stop, to_stop, elevation` (cat) +
  `hour, dow, weather_score, distance_m, ridership` (num); takes effect at the
  next retrain (6h cycle or `POST /retrain`).

### Ingest schema validation  ✅ built
New `shared/validate.ts`, wired into both adapters:
- `validateRawVehicles()` in `ingest/nyc.ts` — drops records with missing
  trip_id, bad/skewed feed timestamps (>1 h from our clock), strips `upcoming`
  entries with no stop or times outside (−5 min, +3 h), and clears inconsistent
  STOPPED_AT-without-a-stop states. Logs drop counts + reasons only when
  something was actually dropped.
- `inNycBounds()` in `ingest/nyc-bus.ts` — rejects bus GPS fixes outside the NYC
  bounding box (depot test units / bad fixes).
- Conservative by design: only provably-unusable records are dropped; the
  ledger's own guards remain the second line.
- Live-verified: 339 trips decoded through the layer against the real feed.

### Observability on the dashboard  ✅ built
Per your note, it lives on the analytics site, not just an endpoint:
- Backend `GET /api/system-health` (new): feed age, live train/bus counts, WS
  clients, rows-written-per-hour (`ledger.writeRates()`, new), full row counts.
- Dashboard "System health" panel (top of the grid): feed age (green <90 s /
  amber <5 min / red beyond), write rates, model v1/v2 loaded status, ridership
  profile keys. If the backend is down the panel says so — which is the point.
- The model-status line + showdown panel now report v2 alongside v1.

### DuckDB backtest deep-report  ✅ built
DuckDB was already a dependency (used in `history/export.ts` for Parquet/CSV
exports) — reconciliation found the gap was analytical *queries*, so:
- New `history/backtest-report.ts` (`npm run report:backtest`): attaches the
  ledger read-only (zero live-path contention) and grades EVERY logged
  prediction — 11.5M at first run — per source: MAE/bias/median by lead-time
  bucket, worst-routes by short-lead bias, and a **paired v1-vs-v2 comparison**
  (same trip+stop+minute only, so composition differences can't fake a result).
- First run delivered the headline measurement: model-v1 bias +129 s (0–1 min)
  / +127 s (1–2 min) vs the feed's +8 s / +3 s.

---

## Nice-to-have reconciliation

| Item | Status | Notes |
| --- | --- | --- |
| DB indexes on trip_id / snapshot_id | ✅ **Already done** | `ledger.ts` defines 12 indexes incl. `idx_pred_key(trip_id, stop_id, observed_at)`; `history/db.ts` indexes snapshots. Nothing to add. |
| Retention / bounded disk | ✅ **Already done** | `prune()` deletes >30 d across all 7 ledger tables; `history.db` prunes >7 d; golden-set Parquet is prune-immune. |
| DuckDB for fast analytics | ✅ **Done this session** | Was already used for exports; now also powers `npm run report:backtest` (full-history grading + v1-vs-v2 paired comparison). |
| WebSocket delta payloads | ⏸️ **Deferred (deliberately)** | Not actually an easy add: the Go analytics service consumes the same WS stream and expects full state per message, so deltas would ripple across services. Revisit with a versioned message type. |
| Incremental backtest watermark | ✅ **Resolved (differently)** | The deferral bit us: at 4 days of data the full-history backtest OOMed the backend live (3 GB, dead event loop — `fixed_errors.md` I8). Fixed via SQL-side aggregation + a rolling 6 h window + a 60 s endpoint memo, which removes the compounding cost from the hot path without needing a watermark design. Full-history grading lives in `npm run report:backtest` (DuckDB, offline). |
| Reverse-proxy / TLS + relative dashboard URLs | ⏸️ **Deferred** | Follow-up to I5 once you put nginx/Caddy in front. |

Legend: ✅ done · 🟡 partial · 🚧 in progress this session · ⏸️ deferred
