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
    - build_series(closes, revisions, range_key, today) - chart points
    - build_value_history(ticker, range_key, db_path, ...) - full endpoint payload

Key Input Dependencies:
    - yfinance history (price), domain_model.sqlite projection_version (fair value)

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

sys.path.insert(0, str(Path(__file__).resolve().parent))
from domain_model.projection_repository import (  # noqa: E402
    get_preferred_projection,
    list_projection_versions,
)
from ticker_aliases import normalize_ticker  # noqa: E402

DEFAULT_DB = str(Path(__file__).resolve().parent.parent / "data" / "domain_model.sqlite")
# range -> (days of history or None for all, yfinance interval)
RANGES = {"1y": (365, "1d"), "3y": (3 * 365, "1wk"), "5y": (5 * 365, "1wk"), "max": (None, "1wk")}


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


def build_series(closes: list[tuple[str, float]], revisions: list[tuple[str, float]],
                 range_key: str, today: date) -> list[dict]:
    days = RANGES[range_key][0]
    start = (today - timedelta(days=days)).isoformat() if days else ""
    dates = [r[0] for r in revisions]
    points = []
    for d, close in closes:
        if d < start:
            continue
        i = bisect.bisect_right(dates, d)
        points.append({"date": d, "price": close, "fair_value": revisions[i - 1][1] if i else None})
    return points


def _fetch_closes(ticker: str, range_key: str, today: date) -> tuple[list[tuple[str, float]], str]:
    import yfinance as yf

    days, interval = RANGES[range_key]
    stock = yf.Ticker(ticker)
    kwargs = {"start": (today - timedelta(days=days)).isoformat()} if days else {"period": "max"}
    hist = stock.history(interval=interval, auto_adjust=False, **kwargs)
    closes = [(idx.strftime("%Y-%m-%d"), round(float(v), 4)) for idx, v in hist["Close"].dropna().items()]
    try:
        currency = stock.fast_info.get("currency") or "USD"
    except Exception:
        currency = "USD"
    return closes, currency


def build_value_history(ticker: str, range_key: str, db_path: str, closes=None, currency=None,
                        today: date | None = None) -> dict:
    today = today or date.today()
    symbol = normalize_ticker(ticker.upper())
    if closes is None:
        closes, currency = _fetch_closes(symbol, range_key, today)
    revisions = load_revisions(db_path, symbol)
    points = build_series(closes, revisions, range_key, today)

    fair_value = None
    if revisions:
        conn = open_readonly(db_path)
        try:
            entry = preferred_projection(conn, find_investment_id(conn, symbol))
        finally:
            conn.close()
        fair_value = entry.get("fair_value") if entry else None
    last = points[-1] if points else None
    return {
        "ticker": symbol,
        "currency": currency or "USD",
        "points": points,
        "current": {
            "price": last["price"] if last else None,
            "fair_value": fair_value,
            "date": last["date"] if last else None,
        },
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
