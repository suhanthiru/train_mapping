"""THE alert-active signal — one bisect index, explicit named windows
(roadmap P3). Before this module the question "was there an alert on this route
around time T?" was answered four different ways with three different windows
(train_eta ±200s, anomaly ±1800s, build_goldenset SQL ±200s, active_alerts
300s trailing) — so a fused dashboard could show contradictory answers side by
side. The window CHOICES are legitimate (features want tight windows, anomaly
context wants wide), so they stay — but as named constants over one index.

Sources, merged per use:
  * ledger alerts_log — the live tracker's own snapshots (2-min cadence)
  * mta_history.alerts() — years of Open-Data alert history (899k pairs),
    merged in-memory only (never written into the ledger)

active_alerts.py keeps its live "is a route alerted RIGHT NOW" TTL cache (a
serving-path concern); it now shares LIVE_WINDOW_S from here.
"""
import bisect
import os
import sqlite3

HERE = os.path.dirname(__file__)
LEDGER = os.environ.get("LEDGER_DB", os.path.join(HERE, "..", "data", "ledger.db"))

# Named windows — the one place their meanings are defined:
TRAIN_WINDOW_S = 200     # feature windows (train_eta / goldenset): tight — "an
                         # alert snapshot within ±200s of this observation"
ANOMALY_WINDOW_S = 1800  # anomaly context: wide — "is this slowness plausibly
                         # explained by an alert within ±30min"
LIVE_WINDOW_S = 300      # live serving: "alert logged in the last 5 min"

_index_cache: dict = {}  # key -> {route: sorted [ts]}


def build(con=None, with_history=False):
    """route_id -> sorted alert timestamps. Cached per (ledger, with_history);
    with_history merges mta_history.alerts() for years of coverage."""
    key = (LEDGER, with_history)
    if key in _index_cache:
        return _index_cache[key]
    idx: dict = {}
    own = con is None
    if own:
        con = sqlite3.connect(LEDGER)
    try:
        for route_id, ts in con.execute(
            "SELECT route_id, ts FROM alerts_log WHERE route_id IS NOT NULL ORDER BY route_id, ts"
        ):
            idx.setdefault(route_id, []).append(ts)
    finally:
        if own:
            con.close()
    if with_history:
        import mta_history
        added = 0
        for route_id, ts in mta_history.alerts():
            idx.setdefault(route_id, []).append(ts)
            added += 1
        for arr in idx.values():
            arr.sort()
        print(f"[alert_index] merged {added} historical alert pairs")
    _index_cache[key] = idx
    return idx


def invalidate():
    """Drop cached indexes (e.g. after a retrain cycle wants fresh ledger rows)."""
    _index_cache.clear()


def active(index, route_id, ts, window=TRAIN_WINDOW_S) -> float:
    """1.0 if `route_id` has an alert within ±window of ts, else 0.0."""
    arr = index.get(route_id)
    if not arr or ts is None:
        return 0.0
    i = bisect.bisect_left(arr, ts - window)
    return 1.0 if i < len(arr) and arr[i] <= ts + window else 0.0
