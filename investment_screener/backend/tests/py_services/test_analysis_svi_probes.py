"""
test_analysis_svi_probes.py - independent verifier probes for the Análisis page
(S2 no-projection fair value, S13 Monte Carlo distribution invariants,
S14 news-sentiment period boundaries).
"""
import sys
from datetime import date, timedelta
from pathlib import Path

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from dcf_sensitivity import monte_carlo  # noqa: E402
from news_sentiment import finviz_symbol, period_counts  # noqa: E402
from value_history import build_series  # noqa: E402

BEAR = {"growthRate": 10.0, "netMargin": 15.0, "exitPE": 20.0, "qualityMultiplier": 1.0, "shareChange": 0.0}
BASE = {"growthRate": 22.0, "netMargin": 25.0, "exitPE": 30.0, "qualityMultiplier": 1.0, "shareChange": 0.0}
BULL = {"growthRate": 35.0, "netMargin": 32.0, "exitPE": 40.0, "qualityMultiplier": 1.0, "shareChange": 0.0}
TODAY = date(2026, 6, 1)


def test_s13_histogram_invariants_hold_for_every_size():
    for price, n, seed in [(120.0, 2000, 7), (50.0, 500, 1), (1000.0, 5000, 99), (120.0, 1, 3)]:
        r = monte_carlo(BEAR, BASE, BULL, 0.10, 5, 1e9, 1e8, price, n=n, seed=seed)
        h = r["histogram"]
        assert len(h["bins"]) == len(h["counts"]) + 1 == 25
        assert sum(h["counts"]) == n
        assert r["min"] <= r["p10"] <= r["p25"] <= r["p50"] <= r["p75"] <= r["p90"] <= r["max"]
        assert round(r["probabilityOvervalued"] + r["probabilityUndervalued"], 6) == 1.0


def test_s2_no_projection_never_invents_a_fair_value():
    closes = [("2026-05-01", 10.0), ("2026-05-02", 11.0)]
    assert [p["fair_value"] for p in build_series(closes, [], "1y", TODAY)] == [None, None]


def test_s2_points_before_the_first_revision_stay_null():
    closes = [("2026-05-01", 10.0), ("2026-05-02", 11.0)]
    assert [p["fair_value"] for p in build_series(closes, [("2026-05-02", 20.0)], "1y", TODAY)] == [None, 20.0]


def _art(days_ago, sentiment="positive"):
    return {"date": (TODAY - timedelta(days=days_ago)).isoformat(), "sentiment": sentiment}


def test_s14_period_counts_are_inclusive_at_the_boundary_and_drop_future_dates():
    arts = [_art(0), _art(30), _art(31), _art(91), _art(92), _art(365), _art(366), _art(-5)]
    counts = period_counts(arts, TODAY)
    assert {k: v["positive"] for k, v in counts.items()} == {"1M": 2, "3M": 4, "6M": 5, "1Y": 6}


def test_s14_finviz_symbol_rejects_non_us_listings_and_empty_input():
    assert finviz_symbol("MSFT") == "MSFT"
    assert finviz_symbol("BRK.B") == "BRK-B"
    assert finviz_symbol("SHOP.TO") is None
    assert finviz_symbol("PSU.U") is None
    assert finviz_symbol("") is None
