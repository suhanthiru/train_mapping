"""Live `alert_active` signal — is there an active MTA service alert for a
route right now. The exact query already exists in build_goldenset.py's
`alert_active(route, ts)` (`SELECT COUNT(*) FROM alerts_log WHERE route_id=?
AND ts BETWEEN ts-200 AND ts+200`), used for offline exploration only; this
module promotes it to a live-servable signal, same "already computed, never
wired in" story as station ridership before it.

Unlike mta_ridership.py, no network call is needed — alerts_log lives in the
SAME local ledger.db train_eta.py already opens read-only, so this is a plain
local SQLite read on a timer, not an external API fetch. Cache shape mirrors
mta_ridership.py's `_state`/TTL pattern for consistency.
"""
import os
import sqlite3
import time

import alert_index

HERE = os.path.dirname(__file__)
LEDGER = os.environ.get("LEDGER_DB", os.path.join(HERE, "..", "data", "ledger.db"))

CACHE_TTL_SECONDS = 60  # alerts change faster than ridership patterns
# window definition lives in alert_index.py (P3) so all consumers agree
ACTIVE_WINDOW_SECONDS = alert_index.LIVE_WINDOW_S

_state = {"ts": 0, "routes": set()}


def _refresh():
    con = sqlite3.connect(LEDGER)
    try:
        since = time.time() - ACTIVE_WINDOW_SECONDS
        rows = con.execute(
            "SELECT DISTINCT route_id FROM alerts_log WHERE ts > ?", (since,)
        ).fetchall()
        _state["routes"] = {r[0] for r in rows if r[0]}
        _state["ts"] = time.time()
    finally:
        con.close()


def is_active(route_id) -> bool:
    """True if `route_id` has a service alert logged within the last
    ACTIVE_WINDOW_SECONDS. Refreshes the cache at most once per TTL; a refresh
    failure (e.g. ledger.db momentarily locked by a concurrent writer) leaves
    the previous cache in place rather than raising."""
    if time.time() - _state["ts"] >= CACHE_TTL_SECONDS:
        try:
            _refresh()
        except Exception as e:
            print("[active_alerts] refresh failed (serving stale/empty):", e)
    return route_id in _state["routes"]


def status():
    return {"active_routes": sorted(_state["routes"]), "refreshed_at": int(_state["ts"]) or None}


if __name__ == "__main__":
    # Live self-test: force a refresh, print what's currently active.
    _refresh()
    print(f"active_routes ({len(_state['routes'])}): {sorted(_state['routes'])}")
