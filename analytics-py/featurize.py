"""THE feature-encoding path — single source of truth (roadmap P3).

Before this module the encoder-build dict-comprehension and the encode loop
were copy-pasted in five places (train_eta.train, train_eta.train_v2,
eval_pretrain, graph_dataset._v2_predict, app._feature_row), which is exactly
how train/serve drift happens. Now every producer and the server encode through
these two functions, and tests/test_featurize_parity.py pins the policy:

  * a column is CATEGORICAL iff it appears in `encoders`
    (label-encoded via str(); unseen value -> -1)
  * every other column is NUMERIC (missing/None -> 0.0)
  * column order = feat_order, always

build_encoders() is deterministic (sorted vocab) so a saved model's features
are reproducible from its eta_features*.json.
"""
import json
import os

import numpy as np

_HERE = os.path.dirname(__file__)
_SPEC_PATH = os.path.join(_HERE, "..", "shared", "features.json")
_spec_cache = None


def feature_spec():
    """The model feature registry (shared/features.json) — cat/num/v2_extra_num
    lists in canonical order. train_eta derives CAT/NUM/NUM_V2 from this;
    graph_dataset derives NODE_NUM; adding a feature edits the JSON + the
    producers' enrichment, not five hardcoded lists."""
    global _spec_cache
    if _spec_cache is None:
        with open(_SPEC_PATH, encoding="utf-8") as f:
            _spec_cache = json.load(f)
    return _spec_cache


def build_encoders(rows, cat):
    """Deterministic label encoders over the given rows for the cat columns."""
    return {c: {v: i for i, v in enumerate(sorted({str(r.get(c)) for r in rows}))}
            for c in cat}


def encode_rows(rows, feat_order, encoders):
    """rows (list of dicts) -> float32 feature matrix in feat_order."""
    X = np.zeros((len(rows), len(feat_order)), dtype=np.float32)
    for i, r in enumerate(rows):
        for j, c in enumerate(feat_order):
            enc = encoders.get(c)
            if enc is not None:
                X[i, j] = enc.get(str(r.get(c)), -1)
            else:
                v = r.get(c)
                X[i, j] = float(v) if v is not None else 0.0
    return X


def labels(rows, label):
    """Label vector for training."""
    return np.array([float(r[label]) for r in rows], dtype=np.float32)
