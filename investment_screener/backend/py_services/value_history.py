#!/usr/bin/env python3
"""
value_history.py - Price vs fair value series for the Analysis page chart (S6).

Purpose:
    One canonical place that joins a ticker's yfinance close history with its
    projection fair-value revisions from domain_model.sqlite. Fair value is a step
    function: each revision holds until the next one and is null before the first.
    Read-only everywhere: investment_price is never written (only
    tv_price_refresh.py writes prices, rule 25).

Layer:
    Backend / Python Services / Data Retrieval

Usage Examples:
    python3 value_history.py MSFT --range 3y
    python3 value_history.py MSFT --range max --db /path/to/domain_model.sqlite

Revision rule (same as recommendation.py::_valuation_inputs, not a second rule):
    revisions come from the AI_AGENT projections when the ticker has any, else from
    all projections; rows without a fair_value are skipped. The "current" fair value
    is the fair_value of preferred_projection(), exactly what recommendation.py uses.
    Tickers go through ticker_aliases.normalize_ticker.

Key Functions (Index):
    - open_readonly(db_path) - sqlite3 connection in read-only mode
    - find_investment_id(conn, ticker) - investment_id for a (normalized) ticker, or None
    - preferred_projection(conn, investment_id) - latest AI_AGENT projection, else highest version
    - load_revisions(db_path, ticker) - [(YYYY-MM-DD, fair_value)] ascending
    - build_series(closes, revisions, range_key, today, daily) - chart points (price, fair_value, sma200)
    - current_block(price, sma200, levels) - zone, distance to the mean, level confirmation
    - build_value_history(ticker, range_key, db_path, ...) - full endpoint payload

Key Input Dependencies:
    - yfinance history (price), domain_model.sqlite projection_version (fair value)
    - market_regime._sma (the one rolling-mean helper), chart_levels (supports / resistances)

SMA200 / zone rule (S6, L12): sma200 is the simple 200-session mean of DAILY closes, computed on
    the full daily history before the range cut (null under 200 sessions; weekly ranges read it
    from the daily series at the point's date). zone = infravalorada below it, sobrevalorada above
    it; confirmation = nearest chart support below price (infravalorada) or resistance above
    (sobrevalorada), from the same daily bars chart_levels uses (one download, no second fetch).

Key Output Dependencies:
    - routes/stock.ts (GET /api/stock/:ticker/value-history), stock_montecarlo.py (shared helpers)
"""

import argparse
import bisect
import json
import sqlite3
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))
from domain_model.projection_repository import (  # noqa: E402
    get_preferred_projection,
    list_projection_versions,
)
from chart_levels import compute_chart_levels, resistances_above, supports_below  # noqa: E402
from market_regime import _sma  # noqa: E402
from ticker_aliases import normalize_ticker  # noqa: E402

DEFAULT_DB = str(Path(__file__).resolve().parent.parent / "data" / "domain_model.sqlite")
# range -> (days of history or None for all, yfinance interval)
RANGES = {"1y": (365, "1d"), "3y": (3 * 365, "1wk"), "5y": (5 * 365, "1wk"), "max": (None, "1wk")}
SMA_PERIOD = 200
LEVEL_BARS = 504            # two years of sessions: the history chart_levels' swing/Fibonacci rules assume
NEAREST_LEVELS = 3
SMA_WARMUP_DAYS = 300       # calendar days before the range start that cover 200 sessions


def open_readonly(db_path: str) -> sqlite3.Connection:
    return sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)


def find_investment_id(conn: sqlite3.Connection, ticker: str) -> str | None:
    row = conn.execute("SELECT investment_id FROM investment WHERE symbol = ?;", (normalize_ticker(ticker),)).fetchone()
    return row[0] if row else None


preferred_projection = get_preferred_projection  # canonical rule lives in domain_model.projection_repository


def load_revisions(db_path: str, ticker: str) -> list[tuple[str, float]]:
    conn = open_readonly(db_path)
    try:
        inv_id = find_investment_id(conn, ticker)
        rows = list_projection_versions(conn, inv_id) if inv_id else []
    finally:
        conn.close()
    ai_rows = [r for r in rows if r.get("source") == "AI_AGENT"]
    chosen = ai_rows or rows
    revisions = [(r["saved_at"][:10], float(r["fair_value"])) for r in chosen if r.get("fair_value") is not None]
    return sorted(revisions, key=lambda r: r[0])


def _sma_by_date(daily: list[tuple[str, float]]) -> tuple[list[str], list[float | None]]:
    values = _sma(pd.Series([c for _, c in daily], dtype=float), SMA_PERIOD)
    return [d for d, _ in daily], [None if pd.isna(v) else round(float(v), 4) for v in values]


def build_series(closes: list[tuple[str, float]], revisions: list[tuple[str, float]],
                 range_key: str, today: date, daily: list[tuple[str, float]] | None = None) -> list[dict]:
    days = RANGES[range_key][0]
    start = (today - timedelta(days=days)).isoformat() if days else ""
    dates = [r[0] for r in revisions]
    sma_dates, sma_values = _sma_by_date(daily if daily is not None else closes)
    points = []
    for d, close in closes:
        if d < start:
            continue
        i = bisect.bisect_right(dates, d)
        j = bisect.bisect_right(sma_dates, d)
        points.append({"date": d, "price": close, "fair_value": revisions[i - 1][1] if i else None,
                       "sma200": sma_values[j - 1] if j else None})
    return points


def current_block_levels(bars: pd.DataFrame | None, price: float | None) -> dict:
    """Nearest supports below and resistances above price (short UI labels), from chart_levels."""
    chart = compute_chart_levels(bars) if bars is not None and price is not None else None
    def pick(found):  # contiguous volume shelves share an edge: one slot per price, nearest basis wins
        seen, out = set(), []
        for p, b in found:
            if p not in seen and len(out) < NEAREST_LEVELS:
                seen.add(p)
                out.append({"price": p, "basis": b})
        return out
    if not chart:
        return {"supports": [], "resistances": []}
    return {"supports": pick(supports_below(chart, price, short=True)),
            "resistances": pick(resistances_above(chart, price, short=True))}


def current_block(price: float | None, sma200: float | None, levels: dict | None) -> dict:
    """Zone against the 200-day mean and the nearest level on the confirming side."""
    block = {"sma200": sma200, "zone": None, "distance_pct": None, "confirmation": None}
    if price is None or sma200 is None:
        return block
    block["distance_pct"] = round((price - sma200) / sma200 * 100, 2)
    if price == sma200:
        return block
    below = price < sma200
    block["zone"] = "infravalorada" if below else "sobrevalorada"
    found = ((levels or {}).get("supports" if below else "resistances")) or []
    if found:
        lv = found[0]
        block["confirmation"] = {"price": lv["price"], "basis": lv["basis"],
                                 "distance_pct": round((lv["price"] - price) / price * 100, 2)}
    return block


def _closes_of(hist: pd.DataFrame) -> list[tuple[str, float]]:
    return [(idx.strftime("%Y-%m-%d"), round(float(v), 4)) for idx, v in hist["Close"].dropna().items()]


def _fetch_market(ticker: str, range_key: str, today: date) -> dict:
    """Daily OHLCV (one download: SMA200 and chart levels) plus weekly closes for the weekly ranges."""
    import yfinance as yf

    days, interval = RANGES[range_key]
    stock = yf.Ticker(ticker)
    back = None if days is None else max(days, LEVEL_BARS * 7 // 5) + SMA_WARMUP_DAYS
    kwargs = {"start": (today - timedelta(days=back)).isoformat()} if back else {"period": "max"}
    hist = stock.history(interval="1d", auto_adjust=False, **kwargs).dropna(subset=["Close"])
    daily = _closes_of(hist)
    bars = hist.rename(columns=str.lower)[["open", "high", "low", "close", "volume"]].tail(LEVEL_BARS)
    if interval == "1d":
        closes = daily
    else:
        wkw = {"start": (today - timedelta(days=days)).isoformat()} if days else {"period": "max"}
        closes = _closes_of(stock.history(interval=interval, auto_adjust=False, **wkw))
    try:
        currency = stock.fast_info.get("currency") or "USD"
    except Exception:
        currency = "USD"
    return {"closes": closes, "daily": daily, "bars": bars, "currency": currency}


def build_value_history(ticker: str, range_key: str, db_path: str, closes=None, currency=None,
                        today: date | None = None, daily=None, bars=None) -> dict:
    """closes/daily/bars are injectable for tests; without bars there are no chart levels."""
    today = today or date.today()
    symbol = normalize_ticker(ticker.upper())
    if closes is None:
        market = _fetch_market(symbol, range_key, today)
        closes, currency, daily, bars = market["closes"], market["currency"], market["daily"], market["bars"]
    revisions = load_revisions(db_path, symbol)
    points = build_series(closes, revisions, range_key, today, daily)
    _, sma_values = _sma_by_date(daily if daily is not None else closes)

    fair_value = None
    if revisions:
        conn = open_readonly(db_path)
        try:
            entry = preferred_projection(conn, find_investment_id(conn, symbol))
        finally:
            conn.close()
        fair_value = entry.get("fair_value") if entry else None
    last = points[-1] if points else None
    price = last["price"] if last else None
    levels = current_block_levels(bars, price)
    return {
        "ticker": symbol,
        "currency": currency or "USD",
        "points": points,
        "current": {
            "price": price,
            "fair_value": fair_value,
            "date": last["date"] if last else None,
            **current_block(price, sma_values[-1] if sma_values else None, levels),
        },
        "levels": levels,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Price vs fair value history")
    parser.add_argument("ticker")
    parser.add_argument("--range", dest="range_key", choices=list(RANGES), default="1y")
    parser.add_argument("--db", default=DEFAULT_DB)
    args = parser.parse_args()
    try:
        print(json.dumps(build_value_history(args.ticker, args.range_key, args.db)))
    except Exception as e:  # yfinance failure or unreadable DB -> structured error for the route
        print(json.dumps({"error": str(e)}))


if __name__ == "__main__":
    main()
