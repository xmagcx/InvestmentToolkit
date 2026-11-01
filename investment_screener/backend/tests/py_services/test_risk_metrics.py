"""test_risk_metrics.py — behaviour tests for the canonical risk formulas (C1, S11).

Purpose:
    Covers ``risk_metrics`` through its public interface with hand-computable synthetic price
    series: a constant-growth series (no drawdown, positive Sortino), a series that loses 50 %
    and recovers (max drawdown -0.5 and a known recovery length), a series that falls twice as
    hard as the benchmark on the benchmark's down days (downside beta ~= 2) and a short series
    (less than two years of closes -> every metric is None). No network, no database.

Key Input Dependencies:
    - py_services/risk_metrics.py (the module under test), numpy/pandas
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

import risk_metrics  # noqa: E402

DAYS = 800  # comfortably over the 504-close (two-year) minimum


def _series(values) -> pd.Series:
    index = pd.bdate_range("2023-01-02", periods=len(values))
    return pd.Series([float(v) for v in values], index=index)


def constant_growth(days: int = DAYS, daily: float = 0.0005) -> pd.Series:
    """A price that rises by exactly ``daily`` every day: no drawdown, no down days."""
    return _series([100.0 * (1 + daily) ** day for day in range(days)])


def crash_and_recover(fall_days: int = 100, recover_days: int = 214) -> pd.Series:
    """100 flat days at 100, a straight fall to 50, then a straight climb back to 100."""
    flat = [100.0] * fall_days
    down = list(np.linspace(100.0, 50.0, fall_days + 1))[1:]
    up = list(np.linspace(50.0, 100.0, recover_days + 1))[1:]
    tail = [100.0] * (DAYS - len(flat) - len(down) - len(up))
    return _series(flat + down + up + tail)


# --- the minimum history rule -------------------------------------------------------------


def test_every_metric_needs_two_years_of_closes():
    short = constant_growth(days=risk_metrics.MIN_OBSERVATIONS - 1)

    assert risk_metrics.annualised_return(short) is None
    assert risk_metrics.sharpe_ratio(short) is None
    assert risk_metrics.sortino_ratio(short) is None
    assert risk_metrics.max_drawdown(short) is None
    assert risk_metrics.recovery_days(short) is None
    assert risk_metrics.annualised_volatility(short) is None
    assert risk_metrics.downside_beta(short, constant_growth(days=risk_metrics.MIN_OBSERVATIONS - 1)) is None
    assert risk_metrics.compute(short, constant_growth()) is None


def test_two_years_of_closes_is_enough():
    series = constant_growth(days=risk_metrics.MIN_OBSERVATIONS)

    assert risk_metrics.MIN_OBSERVATIONS == 504
    assert risk_metrics.max_drawdown(series) == pytest.approx(0.0)


# --- the formulas ---------------------------------------------------------------------------


def test_constant_growth_has_no_drawdown_and_no_recovery_to_report():
    series = constant_growth()

    assert risk_metrics.max_drawdown(series) == pytest.approx(0.0)
    assert risk_metrics.recovery_days(series) is None
    assert risk_metrics.annualised_volatility(series) == pytest.approx(0.0, abs=1e-9)


def test_constant_growth_annualises_its_daily_rate():
    series = constant_growth(daily=0.0005)

    expected = (1.0005 ** 252) - 1
    assert risk_metrics.annualised_return(series) == pytest.approx(expected, rel=1e-6)


def test_constant_growth_above_the_risk_free_rate_has_no_downside_deviation():
    # Every daily return beats rf/252, so the Sortino denominator is zero: not a number we invent.
    assert risk_metrics.sortino_ratio(constant_growth(daily=0.0005)) is None
    assert risk_metrics.sharpe_ratio(constant_growth(daily=0.0005)) is None  # zero volatility


def test_a_series_that_halves_reports_minus_fifty_percent_and_its_recovery_length():
    series = crash_and_recover(fall_days=100, recover_days=214)

    assert risk_metrics.max_drawdown(series) == pytest.approx(-0.5)
    assert risk_metrics.recovery_days(series) == 214


def test_a_series_still_under_water_has_no_recovery_days():
    flat = [100.0] * 100
    down = list(np.linspace(100.0, 50.0, 101))[1:]
    series = _series(flat + down + [50.0] * (DAYS - 200))

    assert risk_metrics.max_drawdown(series) == pytest.approx(-0.5)
    assert risk_metrics.recovery_days(series) is None


def test_downside_beta_of_a_series_that_falls_twice_as_hard_is_two():
    rng = np.random.default_rng(7)
    benchmark_returns = rng.normal(0.0003, 0.01, DAYS - 1)
    asset_returns = [r * 2 if r < 0 else r for r in benchmark_returns]
    benchmark = _series(np.concatenate([[100.0], 100 * np.cumprod(1 + benchmark_returns)]))
    asset = _series(np.concatenate([[100.0], 100 * np.cumprod(1 + np.array(asset_returns))]))

    assert risk_metrics.downside_beta(asset, benchmark) == pytest.approx(2.0, abs=0.05)


def test_downside_beta_of_the_benchmark_against_itself_is_one():
    rng = np.random.default_rng(11)
    returns = rng.normal(0.0002, 0.012, DAYS - 1)
    benchmark = _series(np.concatenate([[100.0], 100 * np.cumprod(1 + returns)]))

    assert risk_metrics.downside_beta(benchmark, benchmark) == pytest.approx(1.0, abs=1e-9)


def test_sortino_uses_the_downside_deviation_below_the_risk_free_rate():
    rng = np.random.default_rng(3)
    returns = rng.normal(0.0006, 0.011, DAYS - 1)
    series = _series(np.concatenate([[100.0], 100 * np.cumprod(1 + returns)]))

    daily_rf = risk_metrics.RISK_FREE_ANNUAL / risk_metrics.TRADING_DAYS
    downside = np.minimum(returns - daily_rf, 0.0)
    expected_dd = np.sqrt(np.mean(downside ** 2)) * np.sqrt(risk_metrics.TRADING_DAYS)
    expected = (risk_metrics.annualised_return(series) - risk_metrics.RISK_FREE_ANNUAL) / expected_dd

    assert risk_metrics.sortino_ratio(series) == pytest.approx(expected, rel=1e-9)
    assert risk_metrics.RISK_FREE_ANNUAL == 0.04 and risk_metrics.TRADING_DAYS == 252


def test_sharpe_is_the_excess_return_over_the_annualised_volatility():
    rng = np.random.default_rng(5)
    returns = rng.normal(0.0004, 0.013, DAYS - 1)
    series = _series(np.concatenate([[100.0], 100 * np.cumprod(1 + returns)]))

    expected = ((risk_metrics.annualised_return(series) - risk_metrics.RISK_FREE_ANNUAL)
                / risk_metrics.annualised_volatility(series))

    assert risk_metrics.sharpe_ratio(series) == pytest.approx(expected, rel=1e-9)


# --- the bundle the sources store -----------------------------------------------------------


def test_compute_returns_every_metric_with_the_history_it_used():
    series = crash_and_recover()
    rng = np.random.default_rng(13)
    benchmark = _series(np.concatenate([[100.0], 100 * np.cumprod(1 + rng.normal(0.0003, 0.01, DAYS - 1))]))

    metrics = risk_metrics.compute(series, benchmark)

    assert set(metrics) == {"sortino", "sharpe", "downside_beta", "max_drawdown",
                            "recovery_days", "volatility", "history_days", "as_of"}
    assert metrics["max_drawdown"] == pytest.approx(-0.5)
    assert metrics["recovery_days"] == 214
    assert metrics["history_days"] == DAYS
    assert metrics["as_of"] == series.index[-1].date().isoformat()


def test_compute_without_a_benchmark_still_reports_the_rest():
    metrics = risk_metrics.compute(crash_and_recover(), None)

    assert metrics["downside_beta"] is None
    assert metrics["max_drawdown"] == pytest.approx(-0.5)


def test_compute_ignores_missing_closes_and_non_numeric_values():
    values = [float(v) for v in constant_growth().tolist()]
    series = _series(values)
    series.iloc[10] = np.nan

    metrics = risk_metrics.compute(series, None)

    assert metrics["history_days"] == DAYS - 1
