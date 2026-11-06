#!/usr/bin/env python3
"""
chart_levels.py - Chart support and resistance levels from daily price history.

Purpose:
    The one implementation of the chart analysis behind stored price levels: Fibonacci
    retracements of the last major advance, high-volume price shelves and the 50/200-day
    EMAs. update_price_levels.py combines these with the valuation tiers, and TradingView
    draws the stored result, so the Stock Analysis page and the chart show the same levels.

Layer: Backend / Python Services

Usage Examples:
    from chart_levels import fetch_daily_bars, compute_chart_levels
    bars = fetch_daily_bars(["VRT"])["VRT"]
    levels = compute_chart_levels(bars)

Key Functions (Index):
    - fetch_daily_bars(): two years of daily OHLCV per ticker (batch download, SQLite cache)
    - compute_chart_levels(): swing, Fibonacci levels, volume shelves, EMAs
    - supports_below() / resistances_above(): candidate levels around a price (short=True: Spanish UI labels)

Key Input Dependencies:
    - yfinance (daily bars), cache.py (fetch_cache table in domain_model.sqlite)
"""
from __future__ import annotations

from typing import Any

import pandas as pd

FIB_RATIOS = (0.382, 0.5, 0.618, 0.786)
SWING_LOOKBACK_BARS = 260   # the swing low is searched within a year before the swing high
SHELF_BARS = 250            # volume shelves use the last trading year
SHELF_BINS = 12
TOP_SHELVES = 3


def fetch_daily_bars(tickers: list[str], period: str = "2y") -> dict[str, pd.DataFrame]:
    """Daily OHLCV per ticker, one batch download for the tickers not cached in SQLite.

    Returns {ticker: DataFrame[open, high, low, close, volume] indexed by date}; a ticker
    with no data is left out rather than returned empty.
    """
    from cache import cache_get, cache_set

    out: dict[str, pd.DataFrame] = {}
    missing = []
    for t in tickers:
        cached = cache_get(f"{t}:1d:{period}", "ohlcv")
        if cached and cached.get("rows"):
            out[t] = _frame(cached["rows"])
        else:
            missing.append(t)
    if missing:
        import yfinance as yf

        raw = yf.download(missing, period=period, interval="1d", auto_adjust=True, progress=False,
                          group_by="ticker", threads=True)
        for t in missing:
            try:
                df = (raw[t] if isinstance(raw.columns, pd.MultiIndex) else raw).dropna()
            except KeyError:
                continue
            if df.empty:
                continue
            rows = [[i.date().isoformat(), float(r.Open), float(r.High), float(r.Low), float(r.Close), float(r.Volume)]
                    for i, r in df.iterrows()]
            cache_set(f"{t}:1d:{period}", "ohlcv", {"rows": rows})
            out[t] = _frame(rows)
    return out


def _frame(rows: list[list]) -> pd.DataFrame:
    df = pd.DataFrame(rows, columns=["date", "open", "high", "low", "close", "volume"])
    df["date"] = pd.to_datetime(df["date"])
    return df.set_index("date")


def compute_chart_levels(bars: pd.DataFrame) -> dict[str, Any] | None:
    """Swing, Fibonacci levels, volume shelves and EMAs from daily bars.

    The swing high is the highest high in the history; the swing low is the lowest low in
    the SWING_LOOKBACK_BARS before it, so the Fibonacci levels retrace the advance that
    made the high. Returns None with fewer than 60 bars.
    """
    if bars is None or len(bars) < 60:
        return None
    hi_at = bars["high"].idxmax()
    hi = float(bars["high"].max())
    before = bars.loc[:hi_at].tail(SWING_LOOKBACK_BARS)
    lo_at = before["low"].idxmin()
    lo = float(before["low"].min())
    fibs = {r: round(hi - (hi - lo) * r, 2) for r in FIB_RATIOS} if hi > lo else {}

    recent = bars.tail(SHELF_BARS)
    bins = pd.cut(recent["close"], SHELF_BINS)
    shelves = (recent.groupby(bins, observed=True)["volume"].sum().sort_values(ascending=False).head(TOP_SHELVES))
    close = bars["close"]
    return {
        "asOf": bars.index[-1].date().isoformat(),
        "price": round(float(close.iloc[-1]), 2),
        "swingHigh": {"price": round(hi, 2), "date": hi_at.date().isoformat()},
        "swingLow": {"price": round(lo, 2), "date": lo_at.date().isoformat()},
        "fib": fibs,
        "shelves": [{"low": round(float(i.left), 2), "high": round(float(i.right), 2), "volume": float(v)}
                    for i, v in shelves.items()],
        "ema50": round(float(close.ewm(span=50).mean().iloc[-1]), 2),
        # no 200-day EMA before 200 sessions: a shorter seed is not that average (None, never a level)
        "ema200": None if len(close) < 200 else round(float(close.ewm(span=200, min_periods=200).mean().iloc[-1]), 2),
    }


def _candidates(chart: dict[str, Any], short: bool = False) -> list[tuple[float, str]]:
    """Every level with its label: the stored-level wording, or the short Spanish UI wording."""
    swing = f"{chart['swingLow']['date'][:7]} to {chart['swingHigh']['date'][:7]} advance"
    out = [(p, f"Fibonacci {r:.3f}" if short else f"Chart: Fibonacci {r * 100:.1f}% retracement of the {swing}")
           for r, p in chart["fib"].items()]
    for s in chart["shelves"]:
        rng = f"${s['low']:.0f}-${s['high']:.0f}"
        out.append((s["high"], f"Zona de volumen ${s['low']:.0f}–${s['high']:.0f} (techo)" if short
                    else f"Chart: top of the {rng} high-volume shelf"))
        out.append((s["low"], f"Zona de volumen ${s['low']:.0f}–${s['high']:.0f} (base)" if short
                    else f"Chart: bottom of the {rng} high-volume shelf"))
    if chart["ema200"] is not None:
        out.append((chart["ema200"], "EMA 200 días" if short else "Chart: 200-day EMA"))
    out.append((chart["ema50"], "EMA 50 días" if short else "Chart: 50-day EMA"))
    return out


def supports_below(chart: dict[str, Any] | None, price: float, short: bool = False) -> list[tuple[float, str]]:
    """Chart levels below price, nearest first."""
    if not chart:
        return []
    return sorted([c for c in _candidates(chart, short) if c[0] < price], key=lambda c: -c[0])


def resistances_above(chart: dict[str, Any] | None, price: float, short: bool = False) -> list[tuple[float, str]]:
    """Chart levels above price, nearest first."""
    if not chart:
        return []
    return sorted([c for c in _candidates(chart, short) if c[0] > price], key=lambda c: c[0])
