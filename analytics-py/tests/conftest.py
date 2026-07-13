"""Hermetic test setup: analytics-py on sys.path, no network, no side threads.

Env is set BEFORE any project import so module-level threads/caches never fire:
  ANOMALY_WARM=0        app.py skips the baseline warm thread
  HISTORY_CACHE_DIR     empty tmp dir — any accidental mta_history build would
                        try Socrata; tests must monkeypatch instead of pulling
  RIDERSHIP_CACHE       likewise for mta_ridership
"""
import os
import sys
import tempfile

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(HERE, "..")))

_tmp = tempfile.mkdtemp(prefix="tt_tests_")
os.environ.setdefault("ANOMALY_WARM", "0")
os.environ.setdefault("HISTORY_CACHE_DIR", os.path.join(_tmp, "history_cache"))
os.environ.setdefault("RIDERSHIP_CACHE", os.path.join(_tmp, "ridership_profile.json"))
os.environ.setdefault("LEDGER_DB", os.path.join(_tmp, "ledger.db"))
