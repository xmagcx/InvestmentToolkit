#!/usr/bin/env python3
"""risk_metrics.py — THE three-year risk formulas of the opportunities screener (S11).

Purpose:
    Step 5 of the "Embudo" asks whether a fall is a healthy one: did the instrument hold up
    better than the market when the market fell, and does it pay for the risk it runs? This
    module owns every formula behind that question (rule 19: one implementation per concept) —
    annualised return, Sharpe, Sortino, downside beta, maximum drawdown, the days it took to
    recover and annualised volatility — over a plain pandas Series of daily closes.

    It is pure arithmetic: no network, no database, no yfinance. The ``price_risk`` source
    downloads the closes and stores what this module returns in ``stock_risk_metrics``.

    One rule it never breaks: a series with less than two years of closes (``MIN_OBSERVATIONS``
    = 504 trading days) has no three-year figure, so every function returns ``None`` instead of
    a number computed from too little history. The engine shows that as "Datos insuficientes".

    Conventions: 252 trading days a year, a 4 % annual risk-free rate, the Sortino denominator
    is the deviation of ``min(r - rf/252, 0)``, the downside beta is cov/var measured only on
    the days the benchmark fell, and ``max_drawdown`` is a NEGATIVE fraction (-0.5 = -50 %).

Layer:
    Backend / Python Services

Usage Examples:
    from risk_metrics import compute, sortino_ratio
    metrics = compute(closes, benchmark_closes)   # None when the history is too short
    sortino_ratio(closes)

Key Functions (Index):
    - TRADING_DAYS / RISK_FREE_ANNUAL / MIN_OBSERVATIONS / ZERO_TOLERANCE: the conventions above
    - daily_returns(closes): the cleaned daily return series
    - annualised_return / annualised_volatility(closes)
    - sharpe_ratio(closes) / sortino_ratio(closes)
    - downside_beta(closes, benchmark): cov/var on the benchmark's down days
    - max_drawdown(closes) / recovery_days(closes)
    - compute(closes, benchmark): every metric plus history_days and as_of (None if too short)

Key Input Dependencies:
    - pandas / numpy only (FinQuant was the formula reference, never a dependency)

Key Output Dependencies:
    - investment_sources/price_risk.py, which writes stock_risk_metrics (migration 0016)
"""
from __future__ import annotations

import numpy as np
import pandas as pd

#: Trading days in a year, the factor every annualisation here uses.
TRADING_DAYS = 252
#: The risk-free rate Sharpe and Sortino subtract (4 % a year, S11).
RISK_FREE_ANNUAL = 0.04
#: Two years of daily closes: below this, no three-year metric is reported (S11).
MIN_OBSERVATIONS = 504
#: A denominator this small is floating-point noise (a price that never moves), not a risk.
ZERO_TOLERANCE = 1e-9


def _clean(closes: pd.Series | None) -> pd.Series | None:
    """Numeric, positive, ordered closes — or None when there is not enough history."""
    if closes is None:
        return None
    series = pd.to_numeric(pd.Series(closes), errors="coerce").dropna()
    series = series[series > 0]
    if len(series) < MIN_OBSERVATIONS:
        return None
    return series


def daily_returns(closes: pd.Series | None) -> pd.Series | None:
    """The day-over-day returns of a close series (None when the history is too short)."""
    series = _clean(closes)
    if series is None:
        return None
    return series.pct_change().dropna()


def annualised_return(closes: pd.Series | None) -> float | None:
    """The compound annual growth rate implied by the series (first close to last)."""
    series = _clean(closes)
    if series is None:
        return None
    periods = len(series) - 1
    total = float(series.iloc[-1]) / float(series.iloc[0])
    return total ** (TRADING_DAYS / periods) - 1


def annualised_volatility(closes: pd.Series | None) -> float | None:
    """The standard deviation of the daily returns, scaled to a year."""
    returns = daily_returns(closes)
    if returns is None:
        return None
    return float(returns.std(ddof=1)) * np.sqrt(TRADING_DAYS)


def sharpe_ratio(closes: pd.Series | None) -> float | None:
    """Excess return over total volatility; None when the series never moves."""
    volatility = annualised_volatility(closes)
    annual = annualised_return(closes)
    if volatility is None or annual is None or volatility <= ZERO_TOLERANCE:
        return None
    return (annual - RISK_FREE_ANNUAL) / volatility


def downside_deviation(closes: pd.Series | None) -> float | None:
    """Annualised deviation of the returns that fell short of the daily risk-free rate."""
    returns = daily_returns(closes)
    if returns is None:
        return None
    shortfall = np.minimum(returns.to_numpy() - RISK_FREE_ANNUAL / TRADING_DAYS, 0.0)
    return float(np.sqrt(np.mean(shortfall ** 2)) * np.sqrt(TRADING_DAYS))


def sortino_ratio(closes: pd.Series | None) -> float | None:
    """Excess return over the downside deviation; None when there is no downside at all."""
    deviation = downside_deviation(closes)
    annual = annualised_return(closes)
    if deviation is None or annual is None or deviation <= ZERO_TOLERANCE:
        return None
    return (annual - RISK_FREE_ANNUAL) / deviation


def downside_beta(closes: pd.Series | None, benchmark: pd.Series | None) -> float | None:
    """How hard the instrument falls when the benchmark falls: cov/var over its down days."""
    returns = daily_returns(closes)
    benchmark_returns = daily_returns(benchmark)
    if returns is None or benchmark_returns is None:
        return None
    frame = pd.concat([returns, benchmark_returns], axis=1, join="inner").dropna()
    frame.columns = ["asset", "benchmark"]
    down = frame[frame["benchmark"] < 0]
    if len(down) < 2:
        return None
    variance = float(down["benchmark"].var(ddof=1))
    if variance <= ZERO_TOLERANCE:
        return None
    covariance = float(down["asset"].cov(down["benchmark"]))
    return covariance / variance


def max_drawdown(closes: pd.Series | None) -> float | None:
    """The worst fall from a previous peak, as a negative fraction (-0.38 = -38 %)."""
    series = _clean(closes)
    if series is None:
        return None
    return float((series / series.cummax() - 1).min())


def recovery_days(closes: pd.Series | None) -> int | None:
    """Trading days from the worst trough back to the peak before it; None if not recovered."""
    series = _clean(closes)
    if series is None:
        return None
    drawdown = series / series.cummax() - 1
    if float(drawdown.min()) >= 0:
        return None
    trough = int(np.argmin(drawdown.to_numpy()))
    peak = float(series.iloc[: trough + 1].max())
    after = series.iloc[trough + 1:]
    recovered = np.flatnonzero(after.to_numpy() >= peak)
    if recovered.size == 0:
        return None
    return int(recovered[0]) + 1


def compute(closes: pd.Series | None, benchmark: pd.Series | None) -> dict | None:
    """Every metric of one instrument, or None when it has less than two years of closes."""
    series = _clean(closes)
    if series is None:
        return None
    return {
        "sortino": sortino_ratio(series),
        "sharpe": sharpe_ratio(series),
        "downside_beta": downside_beta(series, benchmark),
        "max_drawdown": max_drawdown(series),
        "recovery_days": recovery_days(series),
        "volatility": annualised_volatility(series),
        "history_days": len(series),
        "as_of": _as_of(series),
    }


def _as_of(series: pd.Series) -> str | None:
    """The date of the last close used, as an ISO date (the index may not be a DatetimeIndex)."""
    last = series.index[-1]
    if isinstance(last, pd.Timestamp):
        return last.date().isoformat()
    try:
        return pd.Timestamp(last).date().isoformat()
    except (TypeError, ValueError):
        return None


__all__ = [
    "TRADING_DAYS", "RISK_FREE_ANNUAL", "MIN_OBSERVATIONS", "ZERO_TOLERANCE", "daily_returns",
    "annualised_return", "annualised_volatility", "sharpe_ratio", "downside_deviation",
    "sortino_ratio", "downside_beta", "max_drawdown", "recovery_days", "compute",
]
