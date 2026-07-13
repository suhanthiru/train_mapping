"""The measure-first promotion gate (eval_pretrain._verdict) — pure logic, no
training. This is the guard that decides whether a pretrain blend may touch the
live models, so its edge cases deserve pinning: win on cold-start, win on long
lead, block on near-term regression even when something else improved.
"""
import eval_pretrain as E


def _v1(cold_cur, cold_cand, overall_cur=35.0, overall_cand=35.0):
    return {"n_train": 1000, "n_holdout": 200, "n_cold": 50,
            "overall": {"current": overall_cur, "candidate": overall_cand},
            "cold_start": {"current": cold_cur, "candidate": cold_cand}}


def _v2(buckets):
    return {"n_train": 1000, "n_holdout": 200,
            "buckets": {name: {"n": 100, "cur_mae": cur, "cand_mae": cand,
                               "cur_bias": 0.0, "cand_bias": 0.0}
                        for name, (cur, cand) in buckets.items()}}


def test_cold_start_win_promotes():
    win, reasons = E._verdict(_v1(227.7, 180.2), None)
    assert win is True
    assert any("cold-start" in r for r in reasons)


def test_flat_result_does_not_promote():
    win, _ = E._verdict(_v1(200.0, 199.5), None)  # inside the 1s margin
    assert win is False


def test_long_lead_v2_win_promotes():
    v2 = _v2({"0-1 min": (34.0, 34.0), "1-2 min": (23.0, 23.0), "10+ min": (632.0, 600.0)})
    win, reasons = E._verdict(None, v2)
    assert win is True
    assert any("10+ min" in r for r in reasons)


def test_near_term_regression_blocks_even_with_wins():
    # cold-start improves a lot, but v2 0-1min regresses past tolerance -> block
    v2 = _v2({"0-1 min": (34.0, 40.0), "10+ min": (632.0, 600.0)})
    win, reasons = E._verdict(_v1(227.7, 180.2), v2)
    assert win is False
    assert any("regressed beyond tol" in r for r in reasons)


def test_v1_overall_regression_blocks():
    win, reasons = E._verdict(_v1(227.7, 180.2, overall_cur=35.0, overall_cand=40.0), None)
    assert win is False
    assert any("blocked" in r for r in reasons)
