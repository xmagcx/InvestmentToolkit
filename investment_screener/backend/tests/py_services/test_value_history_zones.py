"""
test_value_history_zones.py - verifier probes for the SMA200 zones of value_history (S6 after L12):
sma200 null under 200 sessions, full-history SMA before the range cut, flat series, missing
bars, empty closes, and nearest levels with distinct prices.
"""
import sys
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

import value_history as vh  # noqa: E402

TODAY = date(2026, 1, 2)


def mkdaily(n, seed=7):
    rng = np.random.default_rng(seed)
    close = 100 + np.cumsum(rng.normal(0.05, 1.5, n))
    idx = pd.bdate_range(end="2026-01-02", periods=n)
    return [(d.strftime("%Y-%m-%d"), round(float(c), 4)) for d, c in zip(idx, close)]


def mkbars(daily):
    idx = pd.to_datetime([d for d, _ in daily])
    c = np.array([v for _, v in daily])
    return pd.DataFrame({"open": c, "high": c * 1.01, "low": c * 0.99, "close": c, "volume": np.full(len(c), 1e6)}, index=idx)


@pytest.fixture()
def db(tmp_path):
    from domain_model.db_client import initialize_db
    path = tmp_path / "domain_model.sqlite"
    initialize_db(str(path)).close()
    return str(path)


def build(db, daily, bars):
    return vh.build_value_history("MSFT", "1y", db, closes=daily, currency="USD", today=TODAY, daily=daily, bars=bars)


@pytest.mark.parametrize("n,has_sma", [(150, False), (199, False), (200, True), (400, True)])
def test_sma200_needs_200_sessions(db, n, has_sma):
    daily = mkdaily(n)
    cur = build(db, daily, mkbars(daily))["current"]
    assert (cur["sma200"] is not None) is has_sma
    if not has_sma:
        assert cur["zone"] is None


def test_range_cut_keeps_the_full_history_mean(db):
    daily = mkdaily(400)
    pts = build(db, daily, mkbars(daily))["points"]
    assert pts[-1]["sma200"] == pytest.approx(np.mean([c for _, c in daily[-200:]]), rel=1e-6)


def test_flat_series_has_no_zone(db):
    daily = [(d, 50.0) for d, _ in mkdaily(250)]
    cur = build(db, daily, mkbars(daily))["current"]
    assert cur["zone"] is None and cur["distance_pct"] == 0.0


def test_without_bars_there_are_no_levels(db):
    daily = mkdaily(250)
    assert build(db, daily, None)["levels"] == {"supports": [], "resistances": []}


def test_empty_closes_give_an_empty_current(db):
    cur = build(db, [], None)["current"]
    assert cur["price"] is None and cur["sma200"] is None and cur["zone"] is None


def test_nearest_levels_have_distinct_prices(db):
    """Contiguous volume shelves share an edge; the same price must not fill two of the 3 slots."""
    for seed in range(1, 12):
        daily = mkdaily(400, seed)
        levels = build(db, daily, mkbars(daily))["levels"]
        for side in ("supports", "resistances"):
            prices = [lv["price"] for lv in levels[side]]
            assert len(prices) == len(set(prices)), (seed, side, levels[side])
