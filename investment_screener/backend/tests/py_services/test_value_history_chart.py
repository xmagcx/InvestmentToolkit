"""
test_value_history_chart.py - T9 / S6b backend: volume per point, ranges ytd and 10y, and the full-history
`overview` (weekly closes capped at 600 points) for the chart navigator. No network: yfinance is faked.
"""
import sys
import types
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

import value_history as vh  # noqa: E402

TODAY = date(2026, 6, 15)


def frame(freq, end, n, vol=1000.0):
    idx = pd.date_range(end=end, periods=n, freq=freq)
    close = 100 + np.arange(n, dtype=float)
    return pd.DataFrame({"Open": close, "High": close, "Low": close, "Close": close, "Volume": np.full(n, vol)}, index=idx)


class FakeTicker:
    """Daily bars for interval 1d; weekly bars (volume = 5 x daily, as yfinance sums the week) otherwise."""
    fast_info = {"currency": "USD"}

    def __init__(self, symbol):
        pass

    def history(self, interval="1d", start=None, period=None, **_):
        df = frame("B", "2026-06-15", 3000, 1000.0) if interval == "1d" else frame("W-MON", "2026-06-15", 1500, 5000.0)
        return df[df.index >= start] if start else df


@pytest.fixture()
def fake_yf(monkeypatch):
    monkeypatch.setitem(sys.modules, "yfinance", types.SimpleNamespace(Ticker=FakeTicker))


@pytest.fixture()
def db(tmp_path):
    from domain_model.db_client import initialize_db
    path = tmp_path / "domain_model.sqlite"
    initialize_db(str(path)).close()
    return str(path)


def test_ranges_include_ytd_and_10y():
    assert {"ytd", "10y"} <= set(vh.RANGES)
    assert vh.RANGES["10y"] == (3650, "1wk")


def test_ytd_cuts_at_january_first_of_the_current_year():
    closes = [("2025-12-31", 1.0), ("2026-01-01", 2.0), ("2026-03-02", 3.0)]
    pts = vh.build_series(closes, [], "ytd", TODAY)
    assert [p["date"] for p in pts] == ["2026-01-01", "2026-03-02"]


def test_10y_cuts_ten_years_back():
    closes = [("2016-01-04", 1.0), ("2016-06-10", 2.0), ("2020-01-06", 3.0)]
    pts = vh.build_series(closes, [], "10y", TODAY)
    assert [p["date"] for p in pts] == ["2020-01-06"]


def test_points_carry_volume_and_null_when_unknown():
    closes = [("2026-01-02", 10.0), ("2026-01-05", 11.0)]
    pts = vh.build_series(closes, [], "ytd", TODAY, volumes={"2026-01-02": 1234.0})
    assert [p["volume"] for p in pts] == [1234.0, None]
    assert vh.build_series(closes, [], "ytd", TODAY)[0]["volume"] is None


def test_daily_range_points_use_daily_volume(db, fake_yf):
    out = vh.build_value_history("MSFT", "1y", db, today=TODAY)
    assert out["points"] and all(p["volume"] == 1000.0 for p in out["points"])


def test_weekly_range_points_use_the_weekly_summed_volume(db, fake_yf):
    out = vh.build_value_history("MSFT", "5y", db, today=TODAY)
    assert out["points"] and all(p["volume"] == 5000.0 for p in out["points"])


@pytest.mark.parametrize("rng", ["ytd", "1y", "3y", "10y", "max"])
def test_overview_is_the_full_history_capped_at_600_regardless_of_range(db, fake_yf, rng):
    out = vh.build_value_history("MSFT", rng, db, today=TODAY)
    ov = out["overview"]
    assert 0 < len(ov) <= 600
    assert set(ov[0]) == {"date", "price"}
    assert ov[0]["date"] == "2026-06-15" or ov[0]["date"] < "2000-01-01"   # starts at the weekly history start (1500 weeks ~ 1997)
    assert ov[-1]["date"] == "2026-06-15"
    assert [o["date"] for o in ov] == sorted(o["date"] for o in ov)


def test_downsample_keeps_first_and_last_and_never_exceeds_the_cap():
    rows = [{"date": str(i), "price": float(i)} for i in range(1500)]
    out = vh.downsample(rows, 600)
    assert len(out) <= 600 and out[0] == rows[0] and out[-1] == rows[-1]
    assert vh.downsample(rows[:10], 600) == rows[:10]


def test_existing_keys_are_kept(db, fake_yf):
    out = vh.build_value_history("MSFT", "1y", db, today=TODAY)
    assert {"ticker", "currency", "points", "current", "levels"} <= set(out)
    assert {"date", "price", "fair_value", "sma200", "volume"} == set(out["points"][0])
