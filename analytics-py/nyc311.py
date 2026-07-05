"""NYC 311 fusion via NYC Open Data (Socrata), erm2-nwe9 dataset.

IMPORTANT finding from live verification (not assumed): the current 311
complaint_type taxonomy has NO "Subway Delay" or general transit-service
category. Subway/bus SERVICE complaints go directly to the MTA (a state
authority), not NYC 311 (a city system) -- so there is no clean city-311
proxy for "subway running late" to fuse against. The closest genuinely
transit-adjacent categories are about bus stop SHELTERS (the physical
structure), not service. We use those honestly, labeled for what they are --
not mislabeled as delay complaints. This is a real, documented scope
limitation, not a design choice to hide.

$select is an explicit allowlist -- never any complainant-identifying column.
"""
import json
import time
import urllib.parse
import urllib.request

BASE_URL = "https://data.cityofnewyork.us/resource/erm2-nwe9.json"

# Verified via a live exploratory query (see PROJECT_SPEC.md) -- these are
# the actual current categories, not assumed ones. Bus-stop-shelter related
# only; there is no subway equivalent in this dataset.
TRANSIT_ADJACENT_TYPES = ["Bus Stop Shelter Complaint", "Bus Stop Shelter Placement"]

_cache = {"ts": 0, "data": None}
CACHE_TTL_SECONDS = 1200  # ~20 min


def fetch_recent_complaints(hours=72):
    # 72h not 24h: live volume check showed only ~4 complaints/day citywide
    # for this narrow category, so a 24h window is usually 0 -- widened
    # for a more useful (still genuinely "recent") correlation signal.
    type_filter = " OR ".join(f"complaint_type='{t}'" for t in TRANSIT_ADJACENT_TYPES)
    where = f"({type_filter}) AND created_date > '{_iso_hours_ago(hours)}'"
    params = {
        "$select": "complaint_type,descriptor,created_date,latitude,longitude,borough",
        "$where": where,
        "$limit": "500",
    }
    url = BASE_URL + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _iso_hours_ago(hours):
    t = time.gmtime(time.time() - hours * 3600)
    return time.strftime("%Y-%m-%dT%H:%M:%S", t)


def get_recent_complaints():
    now = time.time()
    if _cache["data"] is not None and (now - _cache["ts"]) < CACHE_TTL_SECONDS:
        return _cache["data"]
    try:
        data = fetch_recent_complaints()
        _cache["data"] = data
        _cache["ts"] = now
        return data
    except Exception:
        return _cache["data"] or []


def count_near(lat, lon, radius_deg=0.01):
    """Rough count of recent complaints within ~1km (0.01 deg) of a point."""
    complaints = get_recent_complaints()
    count = 0
    for c in complaints:
        try:
            clat, clon = float(c.get("latitude")), float(c.get("longitude"))
        except (TypeError, ValueError):
            continue
        if abs(clat - lat) < radius_deg and abs(clon - lon) < radius_deg:
            count += 1
    return count


if __name__ == "__main__":
    data = get_recent_complaints()
    print(f"{len(data)} recent bus-stop-shelter complaints in the last 72h")
    for c in data[:5]:
        print(" -", c.get("complaint_type"), c.get("descriptor"), c.get("borough"), c.get("created_date"))
