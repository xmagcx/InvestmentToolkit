#!/usr/bin/env python3
"""
tv_price_refresh.py - Refresh `investment_price` for every held and watchlisted symbol.

Purpose:
    The broker sync updates positions, cash and trades but not prices, so the Daily
    Brief, weights and totals read yesterday's closes until prices are refreshed.
    This reads the refresh scope from domain_model.sqlite, resolves current prices
    from TradingView real-time quotes only (`fetch_portfolio_heatmap.fetch_portfolio_data`
    with tradingview_only=True; yfinance never supplies a price), and writes through the
    investment repositories. A symbol TradingView cannot quote keeps its previous price and
    is reported as failed/stale. It needs neither the Express backend nor a running web server.

Layer:
    Backend / Python Services (shared by the app's Refresh and the tv-price-refresh skill mode)

Usage Examples:
    python3 investment_screener/backend/py_services/tv_price_refresh.py
    python3 investment_screener/backend/py_services/tv_price_refresh.py --db /path/to/domain_model.sqlite --skip-fx

Key Functions (Index):
    - refresh_scope(): symbols to refresh (held + watchlisted, aliases normalised)
    - refresh_prices(): fetch, write, and report written / failed / stale symbols
    - main(): CLI; exit 0 all written, 1 some symbols failed, 2 unusable database

Key Input Dependencies:
    - investment_screener/backend/py_services/domain_model/* (repositories)
    - investment_screener/backend/py_services/fetch_portfolio_heatmap.py (price resolver)
    - investment_screener/backend/py_services/ticker_aliases.py
    - investment_screener/backend/py_services/fetch_broker_data.py (--refresh-exchange-rate)
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
PY_SERVICES = REPO_ROOT / "investment_screener/backend/py_services"
DEFAULT_DB = REPO_ROOT / "investment_screener/backend/data/domain_model.sqlite"
sys.path.insert(0, str(PY_SERVICES))

from domain_model.account_investment_repository import list_account_investments  # noqa: E402
from domain_model.investment_price_repository import get_investment_price, upsert_investment_price  # noqa: E402
from domain_model.investment_repository import list_investments, resolve_investment, update_investment_sector  # noqa: E402
from ticker_aliases import is_cash, normalize_ticker  # noqa: E402

PRICE_CURRENCY = "USD"  # matches the Express /refresh-prices writer this replaces


def refresh_scope(conn) -> list[str]:
    """Return the sorted, de-duplicated symbols to refresh.

    Held (quantity > 0 in any account) plus watchlisted symbols, with broker
    aliases normalised and cash rows excluded.
    """
    held = {row["investment_id"] for row in list_account_investments(conn) if (row["quantity"] or 0) > 0}
    watched = {row["investment_id"] for row in list_investments(conn, is_watchlisted=True)}
    symbols = {normalize_ticker(s) for s in held | watched}
    return sorted(s for s in symbols if s and not is_cash(s) and not s.startswith("CASH_"))


def _default_fetch(items: list[dict]) -> dict:
    from fetch_portfolio_heatmap import fetch_portfolio_data

    return fetch_portfolio_data(items, bust_cache=True, tradingview_only=True)


def refresh_prices(conn, fetch: Callable[[list[dict]], dict] | None = None, now: str | None = None) -> dict:
    """Fetch current prices and write them through the repositories.

    A symbol with no usable quote (missing, non-numeric or <= 0) is never written
    and never fabricated. Its previous row is kept and reported under `stale` so
    the caller can see how old it is.

    Returns:
        {"written": [symbols], "failed": [symbols], "stale": [{"symbol", "fetched_at"}]}
    """
    fetch = fetch or _default_fetch
    now = now or datetime.now(timezone.utc).isoformat()
    symbols = refresh_scope(conn)
    quotes = {s["symbol"]: s for s in fetch([{"symbol": s, "shares": 0} for s in symbols]).get("stocks", [])}
    written, failed, stale = [], [], []
    for symbol in symbols:
        quote = quotes.get(symbol) or {}
        price = quote.get("price")
        investment_id = resolve_investment(conn, symbol)
        if not isinstance(price, (int, float)) or isinstance(price, bool) or not price > 0:
            failed.append(symbol)
            previous = get_investment_price(conn, investment_id)
            stale.append({"symbol": symbol, "fetched_at": previous["fetched_at"] if previous else None})
            continue
        upsert_investment_price(conn, investment_id, float(price), PRICE_CURRENCY, now)
        if quote.get("sector") is not None or quote.get("industry") is not None:
            update_investment_sector(conn, investment_id, quote.get("sector"), quote.get("industry"))
        written.append(symbol)
    return {"written": written, "failed": failed, "stale": stale}


def _refresh_exchange_rate() -> bool:
    """Best-effort USD->CAD refresh from TradingView; a failure never blocks prices."""
    script = PY_SERVICES / "fetch_broker_data.py"
    try:
        return subprocess.run([sys.executable, str(script), "--refresh-exchange-rate"],
                              capture_output=True, timeout=60).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Refresh investment_price for held and watchlisted symbols.")
    parser.add_argument("--db", default=str(DEFAULT_DB), help="Path to domain_model.sqlite")
    parser.add_argument("--exit-zero", action="store_true",
                        help="Exit 0 when some symbols have no quote (the app reads the JSON report instead of the exit code)")
    parser.add_argument("--skip-fx", action="store_true", help="Do not refresh the USD->CAD exchange rate")
    args = parser.parse_args(argv)
    if not Path(args.db).exists():
        print(json.dumps({"error": f"database not found: {args.db}"}), file=sys.stderr)
        return 2
    from domain_model.db_client import initialize_db

    conn = initialize_db(args.db)
    try:
        result = refresh_prices(conn)
    finally:
        conn.close()
    # The USD->CAD refresh reads the broker panel; with the broker integration off (the default,
    # see backend src/utils/brokerIntegration.ts) it is skipped, never attempted.
    broker_on = os.environ.get("BROKER_INTEGRATION", "").strip().lower() == "on"
    if args.skip_fx:
        result["exchange_rate_refreshed"] = None
    elif not broker_on:
        result["exchange_rate_refreshed"] = None
        result["exchange_rate_skipped"] = "broker integration disabled"
    else:
        result["exchange_rate_refreshed"] = _refresh_exchange_rate()
    print(json.dumps(result, indent=2))
    return 0 if args.exit_zero or not result["failed"] else 1


if __name__ == "__main__":
    sys.exit(main())
