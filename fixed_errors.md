# Fixed Errors

A running log of concrete bugs found in the codebase, what caused them, and how
they were fixed. Severity is my own triage, not a formal scale.

**Dating methodology (so the dates below aren't taken as more precise than they
are):** issues weren't logged with timestamps in real time, so dates are
reconstructed from real evidence, not guessed:
- **I1–I7** were all found and fixed in one continuous working arc that ended at
  the single bulk commit `5e2d8ee` ("updated sys"), timestamped **Jul 9, 02:10 AM**
  — so "found" is dated the evening before (**2026-07-08**) and "fixed" at that
  commit boundary. There's no finer per-issue granularity available within that
  arc (one commit, not one per issue).
- **I8, I9** came later the same day — their own text already said "found live
  during the same incident," and file mtimes (`graph_experiment.py`,
  `train_eta.py` ≈ 10:00–10:06 AM) place that incident on **2026-07-09**.
- **I10, I11** (below) are from live investigation today, **2026-07-10** — both
  are diagnosed but **not yet fixed** (open).

---

## ✅ FIXED

### I2 — `analytics-py` had no persistence (model + ledger vanished on restart)
`Found 2026-07-08 · Fixed 2026-07-08 (session ending 2026-07-09 02:10 AM)`
- **Severity:** High — this silently broke 24/7 operation.
- **Where:** `docker-compose.yml` (`analytics-py` service had zero volumes),
  `analytics-py/app.py`, `analytics-py/train_eta.py`, `analytics-py/build_goldenset.py`.
- **What it was:** In a container, `train_eta.py` read the ledger at
  `../data/ledger.db` — a path that wasn't mounted — so the retrain read an
  **empty database** and did nothing. The trained model (`eta_model.json`,
  `eta_features.json`) was written to the container's ephemeral `/app` (the
  Dockerfile only `COPY *.py`, never the model), so **every restart dropped the
  model and `/predict` returned 503** until the next 6-hour retrain — which, per
  the first point, couldn't succeed anyway. It only appeared to work locally
  because the files happen to sit next to the code when run natively.
- **How it was fixed:**
  - Introduced a `MODEL_DIR` env var (default: alongside the code, so local dev is
    unchanged) that both `app.py` and `train_eta.py` use for the model files.
  - Made the ledger path env-overridable (`LEDGER_DB`) in `train_eta.py` and
    `build_goldenset.py`; added `GOLDENSET_DIR` for the Parquet output.
  - `docker-compose.yml` now bind-mounts `./data:/data` on `analytics-py` and sets
    `LEDGER_DB=/data/ledger.db`, `MODEL_DIR=/data/models`,
    `GOLDENSET_DIR=/data/exports/goldenset` — so the service reads the **same**
    ledger train_3d_map writes and persists the model on the host.
  - `train_eta.py` `os.makedirs(MODEL_DIR)` guards a fresh host where the dir
    doesn't exist yet.
- **Verify:** `docker compose config -q` passes. On a host: `POST /retrain`
  succeeds, then `docker compose restart analytics-py` and `/predict` still
  answers immediately (no 503); `./data/models/eta_model.json` exists on the host.

### I4 — the prediction source `'model-v1'` was hardcoded into the SQL
`Found 2026-07-08 · Fixed 2026-07-08 (session ending 2026-07-09 02:10 AM)`
- **Severity:** Low/Med — a scaling blocker, not a runtime bug.
- **Where:** `history/ledger.ts`, `insModelPred` prepared statement + `recordModelPredictions()`.
- **What it was:** `INSERT INTO predictions (…, source) VALUES (…, 'model-v1')`
  baked the source string into the query, so logging a second model version meant
  duplicating the method. The change-detection dedup key was also un-namespaced by
  source, so two model versions predicting the same stop would clobber each other.
- **How it was fixed:** `source` is now a bound parameter with a default of
  `"model-v1"` (v1 behavior unchanged), and the dedup key is namespaced by source
  (`${source}:${tripId}|${stopId}`). This is the enabler for the model-v2 A/B
  (I1) — both versions log into the same table and are graded identically by the
  existing `accuracyByLeadTime(source)`.
- **Verify:** TypeScript typecheck; existing `model-v1` path unchanged.

### I5 — the analytics dashboard hardcoded `localhost`
`Found 2026-07-08 · Fixed 2026-07-08 (session ending 2026-07-09 02:10 AM)`
- **Severity:** Low — worked locally, broke on a remote host.
- **Where:** `dashboard/app.js` (top-of-file service base URLs).
- **What it was:** `BACKEND/KALMAN/ANALYTICS` were literal
  `http://localhost:8088/8091/8092`. Served from a VM, the browser's "localhost"
  is the *viewer's* machine, so every fetch failed.
- **How it was fixed:** The base URLs now derive from the page's own
  `location.protocol` + `location.hostname` (fixed ports), with a `localhost`
  fallback for `file://`. Works unchanged locally and on a remote host.
- **Follow-up (not done):** once a reverse proxy/TLS is added, switch to relative
  `/api/*` paths proxied server-side. Tracked as a deferred item.

### I3 — fake occupancy carried through three services
`Found 2026-07-08 · Fixed 2026-07-08 (session ending 2026-07-09 02:10 AM)`
- **Severity:** Medium — dead weight + a trap for future contributors.
- **Where:** `ingest/nyc.ts`, `ingest/nyc-bus.ts`, `shared/occupancy.ts`,
  `shared/types.ts`, `core/interpolate.ts`, `history/ledger.ts` (predictions +
  segments schema), `analytics-go` (wsclient + persist + main loop),
  `web/src/main.ts`, `web/index.html`.
- **What it was:** MTA's GTFS-rt `occupancy_status` is **100% `EMPTY`** (no
  passenger-counting hardware), yet it was decoded, stored in two ledger tables
  and Go's `analytics.db`, and plumbed through the UI. Already excluded from
  training and hidden in the map UI, so it was inert — but misleading.
- **How it was fixed (full deletion, not hiding):**
  - Deleted `shared/occupancy.ts` and the `occStatus`/`occPct` fields from both
    shared interfaces; removed the decode calls in both ingest adapters and the
    passthrough in `core/interpolate.ts`.
  - Dropped `occ_status`/`occ_pct` from the `predictions` + `segments` CREATE
    TABLEs, INSERTs, `buildSegments()` join, and `tripHistory()` SELECT.
    (Existing DBs keep the old columns as harmless NULLs — inserts name their
    columns explicitly; fresh DBs are created clean.)
  - Go: removed the `occupancy` table/statement/`OccupancyRow`/`RecordOccupancy`,
    its prune, the WS-client fields, and the on-change tracking loop in `main.go`.
  - Map UI: removed `occupancyHTML`, `OCC_UI`, `OCCUPANCY_ENABLED`, both panel
    render sites, and the `.occ` CSS.
- **Replaced by:** the real station-hourly-ridership feature — see
  `updated_features.md`.
- **Verify:** `tsc` OK (backend, flag-matched to tsx) · `go build ./...` OK ·
  `vite build` OK · repo-wide grep shows zero remaining occupancy references
  (one historical comment in `train_eta.py` retained deliberately).

### I1 — ETA model's 85–130 s late bias at short lead times
`Found 2026-07-08 · Fixed 2026-07-08 (session ending 2026-07-09 02:10 AM)`
- **Severity:** High — it was the headline accuracy problem.
- **Where:** `server/index.ts` `modelPredictTick()` (hop-chaining).
- **What it was:** When chaining per-hop duration predictions into arrival times,
  the code added the **full** predicted duration of the hop the train is *already
  inside*, ignoring how far through it is. A train 70% through a 120 s hop still
  got the whole 120 s added, so the arrival (and every downstream cumulative
  arrival) landed ~84 s late — worst at short lead times.
- **Now MEASURED, not estimated** (new `npm run report:backtest`, 11.5M graded
  predictions): model-v1 bias = **+129 s at 0–1 min, +127 s at 1–2 min** — dead
  center in the diagnosed range. The feed's bias at the same leads: +8 s / +3 s.
- **How it was fixed (model-v2, the learned remaining-time model):**
  - `analytics-py/train_eta.py` `train_v2()` — trains on `vehicle_log × actuals`:
    every mid-hop Kalman log tick becomes one `(features + frac_hop +
    kalman_speed + trains_ahead) → remaining_seconds` example. **1,675,404 real
    samples existed at first training** (the forward-only logger had been
    quietly accumulating), so v2 trained meaningfully on day one.
  - Trained live: in-sample MAE 46.5 s vs 63.2 s predict-the-mean; **frac_hop is
    the #1 feature by gain (63.3M — 2× distance_m)**, congestion #3, Kalman
    speed #4 — the diagnosis confirmed by the data.
  - `analytics-py/app.py` — loads both models, retrains both on the 6 h cycle,
    new `POST /predict-remaining` endpoint (`/predict-batch` untouched).
  - `server/index.ts` `modelV2Tick()` — for the in-progress hop, asks v2 "how
    long REMAINS given frac_hop/speed/congestion" (reusing the same `lastHopState`
    the vehicle_log logger computes — measure and serve from one source), then
    chains v1's full durations for not-yet-started hops. Logs as
    `source='model-v2'` (enabled by the I4 fix) next to v1, which keeps running
    unchanged as the control.
- **Verify:** `model_v2_loaded: true` live on `/health`; v1-vs-v2 paired
  comparison is the last section of `npm run report:backtest` and the dashboard
  showdown panel now plots all three sources. **The verdict number** (does v2's
  0–2 min bias shrink from ~+128 s?) **needs live accumulation** — check after
  the backend has run a few hours.

### I6 — `localhost` DNS penalty silently killed every model prediction *(found during live verification this session)*
`Found 2026-07-08 · Fixed 2026-07-08 (session ending 2026-07-09 02:10 AM)`
- **Severity:** High — the entire model-prediction path was timing out on every tick.
- **Where:** `server/index.ts` service-URL defaults (`ANALYTICS_PY`, `KALMAN_RS`).
- **What it was:** On Windows, `localhost` resolves IPv6 `::1` first; the Python/
  Rust services bind IPv4-only, so every **fresh** connection pays a ~2 s fallback.
  Node's `fetch` aborts `/predict-batch` at 5 s — killing the socket before a
  keep-alive connection can ever establish — so every tick re-paid the penalty
  and logged `model prediction skipped: timeout`.
- **How it was diagnosed (measured, not guessed):** direct calls showed 2.07 s
  for a ONE-hop predict via `localhost` vs **0.04 s for a 3,000-hop batch via
  `127.0.0.1`** — the model was never slow; the hostname was.
- **How it was fixed:** service-URL defaults switched to `http://127.0.0.1:...`.
  Docker overrides via env (`http://analytics-py:8091` etc.) are unaffected.

### I7 — map + dashboard would break under a TLS reverse proxy *(found while writing the Caddy/nginx configs)*
`Found 2026-07-08 · Fixed 2026-07-08 (session ending 2026-07-09 02:10 AM)`
- **Severity:** High (latent) — would have silently broken the live map and dashboard the moment TLS was added, not something a smoke test on plain HTTP would catch.
- **Where:** `web/src/main.ts` (HTTP/WS constants), `dashboard/app.js` (BACKEND/KALMAN/ANALYTICS constants — the I5 fix from earlier this session only got it to "works on one host," not "works behind a proxy," which its own tooltip already flagged as a known gap).
- **What it was:** both hardcoded an explicit port (`:8088`, `:8091`, etc.) onto the current hostname. Fine when every service publishes its own port on the same host — but behind Caddy/nginx terminating TLS on 443, the page loads as `https://...` with no port, and the JS would then try `https://host:8088` (a plain-HTTP service with no TLS listener) — an HTTPS page fetching over what's actually plain HTTP on that port fails, and the WebSocket equivalent (`ws://` from an `https://` page) is blocked by the browser outright as insecure mixed content.
- **How it was fixed:** both now derive same-origin URLs from `location.host`/`location.origin` when not on a known direct-dev port (map: same-origin always, since it's one service on one port; dashboard: same-origin **path-prefixed** — `/api-backend`, `/api-kalman`, `/api-analytics` — proxied through by the new `infra/Caddyfile`/`infra/nginx.conf`). Direct-port dev/VPS access (no proxy) is preserved via a port-based branch (`:5173` for vite dev, `:4174` for the dashboard's own direct port).
- **Verify:** live in-browser check — `console.log("[ws] connected", WS)` fired with the correct same-origin URL, network tab showed clean 200s on the map bundle + GTFS geometry, `vite build` + `tsc` both clean.

### I8 — the backtest materialized millions of rows into JS on every dashboard poll *(found live: 3 GB RSS + a dead event loop)*
`Found 2026-07-09 · Fixed 2026-07-09`
- **Severity:** Critical — the backend hit **3.1 GB of memory within ~20 s of boot** and stopped answering HTTP entirely. This is the "compounds silently" failure the *Incremental Backtest* suggestion (diagram priority #1) predicted — it detonated at 4 days of data.
- **Where:** `history/ledger.ts` `accuracyByLeadTime()` + the `/api/prediction-accuracy` handler in `server/index.ts`.
- **What it was:** the grading query did `.all()` — pulling **every graded prediction row into a JavaScript array** before bucketing in JS. At 8.6M graded model-v1 rows that's ~3 GB of row objects per call, on the **synchronous** `node:sqlite` handle (the event loop is blocked for the entire query + materialization). It ran **at boot** (`snap()` snapshots all 3 sources immediately) and then continuously: the dashboard polls 3 sources every 15 s — and the new Simple-mode panel doubled those calls, which is what pushed the latent bomb into detonating.
- **How it was fixed (three layers):**
  1. **Aggregate in SQL** — `COUNT/AVG(ABS(err))/AVG(err)` grouped by lead bucket inside SQLite (C code); ≤5 rows cross into JS instead of 8.6M.
  2. **Rolling 6 h window** on `observed_at` so the scan rides `idx_pred_observed` instead of walking the whole 30-day table. The live metric is now "recent accuracy"; **full-history analysis lives in `npm run report:backtest`** (DuckDB, offline, read-only attach) — the tool built for exactly that question.
  3. **60 s memo** on `/api/prediction-accuracy` (which also ran `COUNT(*)` over the 18M-row table per poll), so dashboard polling costs nothing between refreshes.
- **Verify (measured):** endpoint went from multi-second/3 GB to **1.2 ms cold, ~1 ms cached** (HTTP 200 with correct buckets); the backend process runs at **114 MB** instead of 3,100 MB; dashboard + Simple mode render live data end-to-end.

### I9 — ingest fetches had NO timeout; a slow MTA feed stalled the whole process *(found live during the same incident)*
`Found 2026-07-09 · Fixed 2026-07-09`
- **Severity:** High — when the MTA feed became unreachable (real, transient network condition observed live), the backend stopped responding even on unrelated local endpoints.
- **Where:** `ingest/nyc.ts` (subway protobuf feeds) and `ingest/nyc-bus.ts` (bus GPS feed) — the only two `fetch()` calls in the codebase without an `AbortSignal.timeout(...)`; every other network call already had one.
- **What it was:** with no timeout, hung connections to the feed piled up unresolved sockets tick after tick; combined with I8's blocked event loop, the process appeared completely dead.
- **How it was fixed:** `AbortSignal.timeout(8000)` on both, matching the codebase-wide pattern.
- **Verify:** logs now show `[nyc-bus] error: The operation was aborted due to timeout` and `fetchTick` completing cleanly during the outage; when the feed recovered, ingestion resumed on its own (259 trains + 150 buses, feed age 13 s).

### I11 — 145 duplicate rows in `segments` from the incremental `buildSegments()` watermark logic
`Found 2026-07-10 · Confirmed fixed 2026-07-12 (verified live, no new dupes since)`
- **Severity:** Low — 0.05% of the table at time of discovery (145 of 290,850 rows), confirmed too small to explain any of the accuracy trends investigated alongside it.
- **Where:** `history/ledger.ts` `buildSegments()`'s watermark-based append.
- **What it was:** a boundary condition where the watermark could advance without the segment inserts for that batch being durable in the same transaction, so a batch could be reprocessed and double-inserted.
- **Verified fixed, not just patched:** `buildSegments()` already wraps every segment `INSERT` and the `setWatermark` call inside one `BEGIN`/`COMMIT`. Live check on 2026-07-12: the table grew from 290,850 → 312,061 rows (~21k new segments) since I11 was first diagnosed, and the duplicate count is **still exactly 145** — proof the transactional fix is actually holding under real, continued ingestion, not just reasoned about. The 145 are inert historical rows from before that transactional fix existed.
- **Cleanup still pending (deliberately not run automatically — it's a live DELETE against the ledger):** `DELETE FROM segments WHERE rowid NOT IN (SELECT MIN(rowid) FROM segments GROUP BY trip_id, from_stop, to_stop, arrive_ts)` removes the 145 legacy dupes so they stop being double-weighted in future v1 training runs. Harmless whenever you want to run it; not urgent given the severity.

---

## 🚧 DIAGNOSED, NOT YET FIXED

### I10 — the retrain scheduler doesn't survive process restarts; model-v1 went ~21h stale and its LIVE accuracy degraded 35% while the model itself never changed
`Found 2026-07-10 · Code hardening added 2026-07-12 — root cause still open (needs stable uptime)`
- **Severity:** High — this is the actual answer to "why are predictions getting worse," and it's an operational gap, not a one-line code bug.
- **Where:** `analytics-py/app.py` (`_scheduler()`'s in-process 6h timer, which resets on every restart) and the upstream cause: the pipeline's own uptime (see the dashboard's new "Uptime — hourly throughput" panel, built 2026-07-10 — only 3/24 hours were collecting in the last day at the time).
- **What it is:** `accuracy_snapshots` shows model-v1's live 0-1min MAE climbing from 124-128s (2026-07-05/06) to 165-171s (2026-07-09/10), while the feed and model-v2 stayed flat over the same window. Direct evidence ruled out the obvious suspects: the model file itself is unchanged since **2026-07-09 21:45** (confirmed: 29.9s in-sample MAE, zero bias, 0% unseen categories against the 5,000 most recent segments) — and `segments` (its training table) has had **zero new rows since that exact timestamp**, so it simply hasn't retrained in ~21h. That's the compound effect of the 19h outage (nothing running to feed `buildSegments()`/`train()`) plus repeated `analytics-py` restarts this session, each of which resets the in-process 6h countdown before it fires.
- **Ruled out with direct tests (not guessed):** encoder staleness, a broken `alert_active` cache (called live, returned real mixed True/False values), and training-data corruption from the I11 duplicate-segment bug (0.05% of rows — far too small to explain a 35% aggregate swing).
- **Best-supported remaining explanation (labeled as inferred, not proven):** v1's live number is a *chained* multi-hop estimate computed by `modelPredictTick`, which depends on live vehicle-state (anchor stop, upcoming-stops list) that resets on every backend restart — noisier chaining without the underlying static model changing at all.
- **Code hardening added 2026-07-12:** `_scheduler()` now anchors its cadence to `eta_model.json`'s own mtime (durable across restarts via `MODEL_DIR`'s persistent volume, per I2) instead of always sleeping a fresh 6h from process start. On boot, if the model is already overdue it retrains immediately (catch-up); otherwise it sleeps only the remaining time to the next real 6h mark. A restart no longer resets the countdown.
- **Still not fully closed:** this stops the scheduler from lying to itself about when it last ran, but the underlying uptime problem (the host restarting at all) is still what needs to stop happening — see the Oracle VM deployment steps in the current chat explainer for what actually closes this.
