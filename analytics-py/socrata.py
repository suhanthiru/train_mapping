"""THE Socrata (data.ny.gov) client — fetch, paging, and blocking disk cache
in one place (roadmap P3). Previously duplicated across mta_ridership.py and
mta_history.py, which meant two URL builders, two pagers, and two cache
implementations to keep in sync.

Two layers, used as needed:
  get(resource_id, params)           one JSON query
  get_all(resource_id, params)       paged until a short page
  cached(name, builder, ttl)         mem -> gzip disk -> build (blocking),
                                     one lock per name so concurrent callers
                                     don't double-fetch

NOT here on purpose: mta_ridership's async-refresh serving path ("stale beats
none, never block"). That policy exists because busyness() sits on the live
/predict path with a 5s upstream abort — a generic layer shouldn't absorb a
latency contract that specific. mta_ridership uses get()/paging from here and
keeps its own refresh choreography.
"""
import gzip
import json
import os
import threading
import time
import urllib.parse
import urllib.request

BASE = "https://data.ny.gov/resource"
PAGE_LIMIT = 50000
FETCH_TIMEOUT_SECONDS = 180
DEFAULT_TTL_SECONDS = 30 * 24 * 3600

HERE = os.path.dirname(__file__)
CACHE_DIR = os.environ.get("HISTORY_CACHE_DIR", os.path.join(HERE, "..", "data", "history_cache"))

_locks: dict = {}
_mem: dict = {}


def get(resource_id, params, timeout=FETCH_TIMEOUT_SECONDS):
    """One Socrata JSON query."""
    url = f"{BASE}/{resource_id}.json?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def get_all(resource_id, params, timeout=FETCH_TIMEOUT_SECONDS):
    """Paged fetch until a short page signals the end."""
    out = []
    offset = 0
    while True:
        p = dict(params, **{"$limit": str(PAGE_LIMIT), "$offset": str(offset)})
        rows = get(resource_id, p, timeout)
        out.extend(rows)
        if len(rows) < PAGE_LIMIT:
            return out
        offset += PAGE_LIMIT


def probe(resource_id):
    """Schema re-confirm: fetch one row, return its keys — run before a bulk
    pull so a silently-changed upstream schema fails loud, not wrong."""
    rows = get(resource_id, {"$limit": "1"}, timeout=30)
    return sorted(rows[0].keys()) if rows else []


# ------------------------------------------------------------------ cache

def _cache_path(name):
    return os.path.join(CACHE_DIR, f"{name}.json.gz")


def _read(name, ttl):
    if name in _mem and (time.time() - _mem[name]["ts"]) < ttl:
        return _mem[name]["data"]
    try:
        with gzip.open(_cache_path(name), "rt", encoding="utf-8") as f:
            blob = json.load(f)
        if (time.time() - blob.get("ts", 0)) < ttl:
            _mem[name] = blob
            return blob["data"]
    except Exception:
        pass
    return None


def _write(name, data):
    blob = {"ts": time.time(), "data": data}
    _mem[name] = blob
    try:
        os.makedirs(CACHE_DIR, exist_ok=True)
        with gzip.open(_cache_path(name), "wt", encoding="utf-8") as f:
            json.dump(blob, f)
    except Exception as e:
        print(f"[socrata] cache write skipped ({name}):", e)


def cached(name, builder, ttl=DEFAULT_TTL_SECONDS):
    """Serve from mem/disk; otherwise build (blocking), cache, return."""
    data = _read(name, ttl)
    if data is not None:
        return data
    lock = _locks.setdefault(name, threading.Lock())
    with lock:
        data = _read(name, ttl)  # recheck under lock
        if data is not None:
            return data
        print(f"[socrata] building '{name}' (live pull) …")
        data = builder()
        _write(name, data)
        print(f"[socrata] '{name}' cached ({size(data)})")
        return data


def cache_ts(name):
    """Epoch of the cached blob (None if absent) — lets consumers key their own
    derived-view memos on the underlying dataset's freshness."""
    blob = _mem.get(name)
    return blob.get("ts") if blob else None


def size(data):
    if isinstance(data, dict):
        return f"{len(data)} keys"
    if isinstance(data, list):
        return f"{len(data)} rows"
    return "?"
