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

### Incremental `buildSegments()`  ✅ built
`history/ledger.ts`'s `buildSegments()` used to `DELETE FROM segments` and rebuild
the entire table from all of `actuals` every hour — cost that grows with total
history forever. Now watermark-based: a `segments_watermark` row tracks the last
processed `actual_arrival`; each run only reads newer actuals and INSERTs (segments
are immutable once a hop completes, so append-only is correct). A new
`idx_actuals_trip_ts` index supports the per-row predecessor lookup.
- **Verified:** first run did the one-time full pass (271k rows, 6.2 s); an
  immediate second run with no new actuals processed 0 rows in **16 ms** (~390×
  faster, and now flat regardless of table size).

### `alert_active` promoted into the live model  ✅ built + retrained
`build_goldenset.py` had computed `alert_active` (is there an active MTA service
alert for this route around this time) for offline exploration since Phase 6, but
it was never a live feature — the same "already computed, never wired in" story
`ridership` had. Now:
- New `analytics-py/active_alerts.py` — a local cache over `alerts_log` (no network
  call; same file the trainer already reads), refreshed ~60 s, `is_active(route)`.
- Added to both `train()` and `train_v2()` via a bisect-indexed `alerts_log` join
  (mirrors `build_goldenset.py`'s ±200 s window), and to `app.py`'s `_enrich()`
  serving path — same pattern as ridership, so train/serve can't drift.
- **Not marginal — real signal:** after retrain, gain = **1.53 M** for v1 (above
  `weather_score`) and **10.6 M** for v2 (also above weather). Live-verified on
  `/feature-importance`; empty-alert and unknown-route cases handled safely.

### Graph-ETA experiment: Baseline / Graph A / Graph B / Graph C  ✅ built + run
A four-condition offline experiment testing whether **cross-train** signal (which
the MTA feed implicitly has and our per-train model doesn't) closes the gap. Every
graph condition is a **residual correction on model-v2**: `final = v2_pred +
gnn_residual`, target = `remaining_sec − v2_pred`. Baseline = v2 with residual 0.
- **`analytics-py/graph_edges.py`** (Phase 1): FOLLOWS canonical spines per
  route+direction (longest-variant fix — verified load-bearing) and SHARES_TRACK
  junction zones (longest common contiguous stop-id run, K=4). All six spot-check
  junctions match exactly (2/3=13, 4/5=7, N/R=28, N/Q=9, A/C=40, B/D=11).
- **`analytics-py/graph_dataset.py`** (Phase 2): builds one PyG `HeteroData` per
  30 s snapshot (all active trains as nodes, FOLLOWS + SHARES edges). Design
  refinement vs. the plan's literal "1.75M ego-subgraphs": one graph per snapshot,
  and the A/B/C conditions differ purely in the *model* (a 2-layer GNN only sees a
  2-hop neighborhood, so it *is* the local ego-subgraph) — same ablation, tractable
  on CPU. Reuses `train_eta.load_v2_instances()` (extracted this session) so node
  features can't drift from live v2. Temporal expanding-window folds with a
  1800 s label-horizon gap + trip-purity guard — **verified zero leakage**.
- **`analytics-py/graph_model.py`** (Phase 3): GraphSAGE + `HeteroConv` (inductive;
  "drop shares" = Graph A). Graph C adds depth (4 layers) + jumping-knowledge +
  inter-layer residuals + edge dropout (the standard oversmoothing mitigations).
  All three overfit a tiny batch to ~0 (sanity check passes).
- **`analytics-py/graph_experiment.py`** (Phase 4): trains A/B/C on shared folds,
  grades all four on identical test nodes, paired win-rates + auto verdict, writes
  `data/exports/graph/experiment_report.json`. **Strictly offline** — verified the
  live `ledger.db` is untouched (only `data/exports/graph/` is written).

#### The verdict (honest, and it's a real finding)
On a representative strided sample (400 snapshots across the full ~4–5 day span,
15,250 test nodes, above the 1000-node gate):

| Condition | short-lead (0–2 min) MAE | vs. previous |
|---|---|---|
| Baseline (v2 remaining-time) | 32.8 s | — |
| **Graph A** (FOLLOWS-only) | **29.6 s** | **PASS** vs baseline (−3.2 s, 55% win) |
| Graph B (+ SHARES_TRACK) | 29.1 s | ties A (−0.5 s, 51% — no real gain) |
| Graph C (whole-network, deep) | 29.3 s | ties B (no gain) |

**Reading:** the graph genuinely helps — ~10% short-lead improvement, mostly by
correcting v2's residual late-bias (baseline +34 s bias at 0–1 min → Graph A
+22 s). But **the entire benefit comes from FOLLOWS (the same-line train ahead)**.
Adding cross-route junction edges (B) and whole-network deep propagation (C) buy
essentially nothing — coin-flip win-rates. This is exactly one of the outcomes the
plan flagged as legitimate: *NYC's same-line headway already carries the cross-train
signal; cross-route interaction is marginal at this timescale/data volume.*
- Caveat (stated, not hidden): this is a 4–5 day dataset. n is above the gate and
  the sample now spans the whole range, so it's a trustworthy **directional** read
  — but not a ship-grade verdict, which the plan gates on ~2–3 weeks of
  accumulation. At longer leads (small n) the residual model slightly *hurts*.

**Phase 5 (production Rust sidecar) — deliberately NOT built.** There's a
directional winner (Graph A), but building a `tch`/libtorch GNN serving sidecar for
a ~3 s gain from a 4–5 day smoke test would violate the plan's own ship gate. The
correct, test-first call: re-confirm on accumulated data first. If it holds, the
thing to ship is **Graph A** (the simplest graph) — not B or C.

### Live graph-structure overlay on the map  ✅ built + verified
A `Y`-key toggle that draws the actual FOLLOWS/SHARES_TRACK connections between
currently-visible trains — "how the graph thinks," shipped independently of whether
the GNN ever wins. Backend loads the Phase-1 topology and computes live edges each
4 s `pushTick` (FOLLOWS = each train → the next ahead on its line; SHARES = a train
→ the nearest cross-route train at a shared junction), attached to the existing WS
`state` broadcast. Frontend renders them as deck.gl `ArcLayer`s (cyan = FOLLOWS,
orange = SHARES) with hover tooltips.
- **Verified live:** 666 edges (444 FOLLOWS, 222 SHARES), zero self-loops, FOLLOWS
  only ever links same-route+direction trains, and **100 % of edge endpoints
  resolve** to real train positions in the browser.

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
