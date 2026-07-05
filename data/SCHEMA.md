# Data schema — prediction ledger & exports

The analytics data model that backs the ETA backtest, the XGBoost training
table, and the station-network graph. Legible on its own so the data is
reusable for future analysis, graph work, or any other tool.

## Storage

- **`data/ledger.db`** — SQLite (Node's built-in `node:sqlite`, no server). Written live by the backend (`server/index.ts`); 30-day retention (`prune()`).
- **`data/exports/`** — periodic dumps in **Parquet** (columnar, compressed — the data-lake standard) and **CSV** (universal). Produced by `npm run export:{graph,data,all}` (`history/export.ts`, via DuckDB). These are also the archival store beyond the 30-day DB prune.

All timestamps are **epoch seconds (UTC)**. `hour`/`dow` in `segments` are **local time on the host** (assumed America/New_York) — for time-of-day patterns.

---

## `predictions` — the feed's evolving arrival beliefs (bitemporal)

One row each time the feed *revises* its predicted arrival for a `(trip, stop)` by more than ~20s (change-detected, not per-poll — see `PredictionLedger`).

| column | type | meaning |
|---|---|---|
| `trip_id` | TEXT | GTFS-rt trip id, e.g. `015200_1..N10R` |
| `stop_id` | TEXT | platform-level stop, e.g. `119N` |
| `route_id` | TEXT | route, e.g. `1` |
| `pred_arrival` | INTEGER | **valid time** — predicted arrival (epoch s) |
| `observed_at` | INTEGER | **transaction time** — feed ts we recorded it (epoch s) |
| `occ_status` | TEXT | GTFS-rt occupancy enum (e.g. `EMPTY`), nullable |
| `occ_pct` | REAL | occupancy % (often 0/placeholder in NYC), nullable |
| `source` | TEXT | `gtfs-rt` (the feed) or later `model-v1` (our ETA model) |

## `actuals` — ground-truth arrivals

One row per `(trip, stop)`, written the first poll a trip is seen `STOPPED_AT` a stop (upper bound within the 30s poll granularity).

| column | type | meaning |
|---|---|---|
| `trip_id` | TEXT | trip id |
| `stop_id` | TEXT | stop id |
| `actual_arrival` | INTEGER | first ts observed stopped there (epoch s) |
| | | `UNIQUE(trip_id, stop_id)` |

## `conditions` — city weather over time

Sampled every ~5 min from the Python service's `/weather-score`.

| column | type | meaning |
|---|---|---|
| `ts` | INTEGER | when sampled (epoch s) |
| `weather_score` | INTEGER | 0–100 "worse for transit" severity |
| `temp_f` | REAL | temperature °F |
| `precipitating` | INTEGER | 0/1 |
| `conditions` | TEXT | NWS text, e.g. `light rain and fog/mist` |

## `segments` — traversal edges = graph edge list **and** ML training table

Materialized by `buildSegments()` from `actuals`: each trip's consecutive observed arrivals paired into `(from_stop → to_stop)` hops (travel 10–1800s), enriched with nearest weather + that trip/stop's occupancy + local hour/dow. This single table is simultaneously the **graph edges** (nodes = stops) and the **XGBoost training rows** (features → `travel_sec` label).

| column | type | meaning |
|---|---|---|
| `trip_id` | TEXT | trip id |
| `route_id` | TEXT | parsed from trip_id |
| `from_stop`, `to_stop` | TEXT | the hop's endpoints (graph edge) |
| `depart_ts`, `arrive_ts` | INTEGER | arrival at from / to (epoch s) |
| `travel_sec` | INTEGER | **label** — hop travel time |
| `weather_score` | INTEGER | nearest `conditions` value, nullable |
| `occ_status`, `occ_pct` | TEXT/REAL | occupancy on that hop, nullable |
| `hour` | INTEGER | local hour-of-day of arrival (0–23) |
| `dow` | INTEGER | local day-of-week (0=Sun) |

---

## Exports (`data/exports/*.{parquet,csv}`)

- **`nodes`** — `stop_id, parent_station, name, lon, lat` for every stop in the network (from `stops.json`; collapse `stop_id`→`parent_station` for a station-level graph). A few `lon/lat` may be empty for stops absent from `stops.json`.
- **`edges`** — `from_stop, to_stop, route, median_travel_sec, n` — the weighted directed graph aggregated from `segments` (load in networkx/Gephi; nodes join on `stop_id`).
- **`segments`, `actuals`, `conditions`, `predictions_sample`** — the tables above, for pandas/Polars/DuckDB/BI tools.
