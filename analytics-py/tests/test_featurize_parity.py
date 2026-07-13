"""Train-vs-serve encoding parity — the drift this guards against is real:
train_eta.train() builds X with its own encode loop, app.py serves with
_feature_row(); if the two ever disagree (missing-value policy, unseen-category
policy, column order) the model silently sees different features at serve time
than it was trained on. This test feeds identical rows through BOTH paths and
requires bit-identical rows.
"""
import numpy as np

import train_eta as T
from app import _feature_row

ROWS = [
    # normal row
    {"route_id": "2", "from_stop": "120S", "to_stop": "123S", "elevation": "underground",
     "hour": 8, "dow": 3, "weather_score": 12.5, "distance_m": 1902.0,
     "ridership": 518.9, "alert_active": 1.0},
    # missing numerics -> 0.0 on both paths
    {"route_id": "A", "from_stop": "A02N", "to_stop": "A03N", "elevation": "elevated",
     "hour": None, "dow": None, "weather_score": None, "distance_m": None,
     "ridership": None, "alert_active": None},
    # unseen category at serve time -> -1 on both paths (encoder built w/o this row)
    {"route_id": "ZZ", "from_stop": "XX9N", "to_stop": "XX8N", "elevation": "surface",
     "hour": 23, "dow": 0, "weather_score": 0.0, "distance_m": 10.0,
     "ridership": 0.0, "alert_active": 0.0},
]


def _train_style(rows, encoders):
    """Reproduces train_eta.train()'s encode loop exactly (same slice of code)."""
    X = np.zeros((len(rows), len(T.FEAT_ORDER)), dtype=np.float32)
    for i, r in enumerate(rows):
        for j, c in enumerate(T.CAT):
            X[i, j] = encoders[c].get(str(r.get(c)), -1)
        for j, c in enumerate(T.NUM):
            v = r.get(c)
            X[i, len(T.CAT) + j] = float(v) if v is not None else 0.0
    return X


def test_train_and_serve_paths_encode_identically():
    # encoders over the first two rows only, so row 3 exercises the unseen path
    enc = {c: {v: i for i, v in enumerate(sorted({str(r.get(c)) for r in ROWS[:2]}))}
           for c in T.CAT}
    feats = {"encoders": enc, "feat_order": T.FEAT_ORDER}

    X_train = _train_style(ROWS, enc)
    X_serve = np.array([_feature_row(feats, dict(r)) for r in ROWS], dtype=np.float32)

    assert X_train.shape == X_serve.shape
    assert np.array_equal(X_train, X_serve), (
        f"train/serve encoding drift:\ntrain={X_train}\nserve={X_serve}"
    )


def test_unseen_category_encodes_minus_one_everywhere():
    enc = {c: {v: i for i, v in enumerate(sorted({str(r.get(c)) for r in ROWS[:2]}))}
           for c in T.CAT}
    feats = {"encoders": enc, "feat_order": T.FEAT_ORDER}
    row = _feature_row(feats, dict(ROWS[2]))
    # every categorical column of the unseen row must be -1
    for j, _ in enumerate(T.CAT):
        assert row[j] == -1


def test_feat_order_is_cat_then_num():
    assert T.FEAT_ORDER == T.CAT + T.NUM
    assert T.FEAT_ORDER_V2 == T.CAT_V2 + T.NUM_V2
