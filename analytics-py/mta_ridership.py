"""MTA station-hourly ridership via NY Open Data (Socrata) — the REAL station
"busyness" signal that replaces the deleted GTFS-rt occupancy field (which the
MTA feed sent as EMPTY for 100% of trains — no passenger-counting hardware).

Both dataset schemas were verified LIVE (same convention as nyc311.py — never
assumed from memory), on 2026-07-08:

  Ridership  https://data.ny.gov/resource/5wq4-mkjj.json  ("Beginning 2025")
    transit_timestamp, transit_mode, station_complex_id, station_complex,
    borough, payment_method, fare_class_category, ridership, transfers,
    latitude, longitude, georeference
    NOTE: one row per (station, hour, payment_method, fare_class) — a station-
    hour's total riders is the SUM of `ridership` across those splits.

  Stations   https://data.ny.gov/resource/39hk-dx4f.json  (gtfs_stop_id <-> complex)
    gtfs_stop_id (e.g. "R01"), station_id, complex_id, stop_name, borough, ...
    NOTE: gtfs_stop_id is the PARENT stop ("R01"); the tracker's runtime stop
    ids are direction-suffixed ("R01N"/"R01S"), so lookups strip a trailing N/S.

Design: instead of one Socrata query per (stop, hour, dow) — thousands of HTTP
calls at train time — we bulk-fetch ONE aggregate profile:
    (station_complex_id, hour, dow) -> avg riders/hour over the last ~8 weeks
That's <= ~80k grouped rows (2 paged queries at $limit=50000), cached to disk
with a TTL, so training enrichment and serving lookups are O(1) and offline-
tolerant. avg = sum(ridership) / (LOOKBACK_DAYS/7) — a slight underestimate for
hours with zero-traffic days, fine for a relative-busyness feature; documented
rather than hidden.

dow is 0=Sunday..6=Saturday — matching BOTH Socrata's date_extract_dow() and
JS Date.getDay(), which is what the ledger's segments.dow already stores.

Zero API keys (public Socrata endpoints; 2 requests per refresh, weekly-ish).
"""
import json
import os
import threading
import time

import socrata

RIDERSHIP_ID = "5wq4-mkjj"
STATIONS_ID = "39hk-dx4f"

HERE = os.path.dirname(__file__)
# Resolves to ./data/ridership_profile.json locally AND /data/... in the
# container (HERE=/app, /data bind-mounted) — same convention as the ledger.
CACHE_PATH = os.environ.get(
    "RIDERSHIP_CACHE", os.path.join(HERE, "..", "data", "ridership_profile.json")
)

LOOKBACK_DAYS = 56  # ~8 weeks: enough (hour,dow) samples, recent enough for season
PROFILE_TTL_SECONDS = 7 * 24 * 3600  # weekly refresh; commute patterns drift slowly
REFRESH_BACKOFF_SECONDS = 600  # after a failed refresh, don't hammer Socrata
FETCH_TIMEOUT_SECONDS = 180  # the server-side GROUP BY takes a while (measured: >30s)

# in-memory: {"ts": epoch, "map": {gtfs_parent: complex}, "profile": {"cx|hr|dw": avg}}
_state = {"ts": 0, "map": None, "profile": None}
_refresh_lock = threading.Lock()
_refreshing = False
_last_attempt = 0.0


# Fetch/paging live in socrata.py (shared with mta_history). This module keeps
# its bespoke async-refresh choreography below — busyness() sits on the live
# /predict path (5s upstream abort), so "stale beats none, never block" is a
# latency contract the generic cache layer deliberately doesn't absorb.

def _fetch_station_map():
    rows = socrata.get(STATIONS_ID, {"$select": "gtfs_stop_id,complex_id", "$limit": "2000"},
                       timeout=FETCH_TIMEOUT_SECONDS)
    return {r["gtfs_stop_id"]: str(r["complex_id"]) for r in rows
            if r.get("gtfs_stop_id") and r.get("complex_id") is not None}


def _fetch_profile():
    """Bulk (complex, hour, dow) -> avg riders/hour via the shared paged client."""
    since = time.strftime(
        "%Y-%m-%dT%H:%M:%S", time.gmtime(time.time() - LOOKBACK_DAYS * 86400)
    )
    weeks = LOOKBACK_DAYS / 7
    rows = socrata.get_all(RIDERSHIP_ID, {
        "$select": ("station_complex_id AS cx,"
                    "date_extract_hh(transit_timestamp) AS hr,"
                    "date_extract_dow(transit_timestamp) AS dw,"
                    "sum(ridership) AS riders"),
        # transit_mode filter halves the scan (dataset includes tram etc.)
        "$where": f"transit_timestamp > '{since}' AND transit_mode='subway'",
        "$group": "cx,hr,dw",
    }, timeout=FETCH_TIMEOUT_SECONDS)
    profile = {}
    for r in rows:
        try:
            key = f"{r['cx']}|{int(r['hr'])}|{int(r['dw'])}"
            profile[key] = round(float(r["riders"]) / weeks, 1)
        except (KeyError, TypeError, ValueError):
            continue
    return profile


def _refresh_blocking():
    """The actual live fetch. Raises on failure; caller owns error policy."""
    m = _fetch_station_map()
    profile = _fetch_profile()
    if m and profile:
        _state.update({"ts": time.time(), "map": m, "profile": profile})
        try:
            os.makedirs(os.path.dirname(CACHE_PATH), exist_ok=True)
            with open(CACHE_PATH, "w") as f:
                json.dump(_state, f)
        except Exception as e:
            print("[ridership] cache write skipped:", e)
        print(f"[ridership] profile refreshed: {len(profile)} keys, {len(m)} stations")


def _refresh_async():
    """Kick one background refresh (with backoff after failures). NEVER blocks
    the caller — the fetch measured >30s, and busyness() sits on the serving
    path where Node aborts /predict-batch at 5s."""
    global _refreshing, _last_attempt
    with _refresh_lock:
        if _refreshing or (time.time() - _last_attempt) < REFRESH_BACKOFF_SECONDS:
            return
        _refreshing = True
        _last_attempt = time.time()

    def run():
        global _refreshing
        try:
            _refresh_blocking()
        except Exception as e:
            print("[ridership] refresh failed (serving stale/none):", e)
        finally:
            with _refresh_lock:
                _refreshing = False

    threading.Thread(target=run, daemon=True).start()


def _load():
    """Serve from memory -> disk cache; when stale/missing, trigger a BACKGROUND
    refresh and return what we have now (stale beats none, and never block)."""
    now = time.time()
    if _state["profile"] is not None and (now - _state["ts"]) < PROFILE_TTL_SECONDS:
        return _state
    # disk cache (also seeds "stale beats none" after a restart)
    try:
        with open(CACHE_PATH) as f:
            disk = json.load(f)
        if disk.get("profile"):
            _state.update(disk)
            if (now - disk.get("ts", 0)) < PROFILE_TTL_SECONDS:
                return _state  # fresh enough — no refresh needed
    except Exception:
        pass
    _refresh_async()
    return _state


def ensure_profile():
    """BLOCKING load for contexts that can wait (training, self-test) — unlike
    the serving path, which must never stall on the ~1-3 min Socrata aggregate.
    Waits for an in-flight async refresh rather than double-fetching.
    Returns True when a profile is available afterwards."""
    _load()
    deadline = time.time() + FETCH_TIMEOUT_SECONDS + 60
    while _refreshing and time.time() < deadline:  # a refresh is already running
        time.sleep(2)
    if not _state["profile"]:
        try:
            _refresh_blocking()
        except Exception as e:
            print("[ridership] blocking refresh failed:", e)
    return bool(_state["profile"])


def _parent_stop(stop_id: str) -> str:
    s = (stop_id or "").strip()
    return s[:-1] if s and s[-1] in "NS" else s


def busyness(stop_id: str, hour: int, dow: int):
    """Avg riders/hour at this station for (hour, dow), or None when the stop is
    unmapped / data never loaded. Callers decide the missing-value policy (the
    model uses 0.0 consistently at train AND serve time)."""
    st = _load()
    if not st["map"] or not st["profile"]:
        return None
    cx = st["map"].get(_parent_stop(stop_id))
    if cx is None:
        return None
    return st["profile"].get(f"{cx}|{int(hour)}|{int(dow)}")


def status():
    """For /health-style reporting: profile size + freshness."""
    st = _state
    return {
        "stations_mapped": len(st["map"]) if st["map"] else 0,
        "profile_keys": len(st["profile"]) if st["profile"] else 0,
        "refreshed_at": int(st["ts"]) or None,
    }


if __name__ == "__main__":
    # Live self-test (run manually): BLOCKING refresh + a few probes. The
    # aggregate query is slow server-side (minutes) — that's why serving uses
    # the async path and only this test/training block on it.
    t0 = time.time()
    ok = ensure_profile()
    print(f"ensure_profile: ok={ok} in {time.time() - t0:.0f}s -> {status()}")
    t = time.localtime()
    dow = (t.tm_wday + 1) % 7  # tm_wday is 0=Mon; convert to 0=Sun
    for probe in ("R01N", "635S", "127N", "L01S"):
        print(f"  busyness({probe}, {t.tm_hour}, {dow}) = {busyness(probe, t.tm_hour, dow)}")
