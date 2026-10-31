#!/usr/bin/env python3
"""tradingview_scanner.py — fill stock_screen_snapshot from the TradingView scanner (S7).

Purpose:
    The opportunities screener needs one row of fundamentals + technicals per instrument of
    the Racional universe. TradingView's public scanner answers that in bulk: one anonymous
    POST returns every requested column for up to a few hundred names, so the whole universe
    costs a handful of requests instead of thousands of per-symbol calls.

    This source is an ``InvestmentSource`` like any other, so the CLI, the ``source_sync_run``
    ledger, the Express sync route and the scheduler treat it exactly like the connectors. It
    reads its to-do list from the database (active EQUITY rows of ``racional_gsheet``), POSTs
    them in chunks of at most ``chunk_size`` names with at least one second between chunks,
    and replaces the snapshot row of every symbol the scanner returned, inside one transaction.

    Two rules it never breaks: it never writes ``investment_price`` (rule 25 keeps
    tv_price_refresh.py the only price writer), and a symbol the scanner did not return keeps
    its previous row and is reported in ``rejected`` instead of being silently dropped.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    python3 sync_cli.py --source tradingview_scanner
    TradingViewScannerSource(chunk_size=200).sync(conn, trigger="manual")

Key Classes / Functions (Index):
    - SCANNER_URL / SCANNER_COLUMNS: the endpoint and the S7 column list (request order)
    - ScanRecord: frozen DTO with one instrument's scanner row
    - post_json(url, payload, ...): the bounded-retry JSON POST (HttpFetcher does GET only)
    - TradingViewScannerSource: fetch/normalize/validate/upsert for the snapshot pass

Key Input Dependencies:
    - stocks_origin rows (source_code 'racional_gsheet', is_active = 1, asset_type EQUITY/ETF)
    - https://scanner.tradingview.com/america/scan (anonymous, no TradingView login)
    - requests (only when no poster is injected; tests always inject one)

Key Output Dependencies:
    - stock_screen_snapshot rows (migration 0015)
    - source_sync_run rows under source_code 'tradingview_scanner'
"""
from __future__ import annotations

import json
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from ticker_aliases import normalize_ticker  # noqa: E402

from .base import (  # noqa: E402
    USER_AGENT,
    FetchError,
    InvestmentSource,
    SourceError,
    SyncResult,
    log_event,
    utc_now,
)

SCANNER_URL = "https://scanner.tradingview.com/america/scan"
#: The S7 column list, in the order the scanner echoes the values back in each row's "d".
SCANNER_COLUMNS = (
    "name", "description", "sector", "update_mode", "is_primary",
    "close", "price_52_week_high", "SMA50", "SMA200", "RSI", "MACD.macd", "MACD.signal",
    "price_earnings_ttm", "earnings_per_share_diluted_ttm",
    "earnings_per_share_diluted_yoy_growth_ttm", "book_value_per_share_fq",
    "return_on_equity", "return_on_assets", "return_on_invested_capital",
    "free_cash_flow", "market_cap_basic", "debt_to_equity", "price_earnings_growth_ttm",
    "total_revenue_yoy_growth_ttm", "price_target_average",
    "recommendation_buy", "recommendation_hold", "recommendation_sell", "recommendation_total",
)
#: scanner column -> stock_screen_snapshot column (the rest of the columns are metadata).
METRIC_COLUMNS = {
    "close": "close", "price_52_week_high": "price_52_week_high", "SMA50": "sma50",
    "SMA200": "sma200", "RSI": "rsi", "MACD.macd": "macd", "MACD.signal": "macd_signal",
    "price_earnings_ttm": "pe_ttm", "earnings_per_share_diluted_ttm": "eps_ttm",
    "earnings_per_share_diluted_yoy_growth_ttm": "eps_growth_pct",
    "book_value_per_share_fq": "book_value_per_share", "return_on_equity": "roe",
    "return_on_assets": "roa", "return_on_invested_capital": "roic",
    "free_cash_flow": "free_cash_flow", "market_cap_basic": "market_cap",
    "debt_to_equity": "debt_to_equity", "price_earnings_growth_ttm": "peg",
    "total_revenue_yoy_growth_ttm": "revenue_growth_pct",
    "price_target_average": "price_target_average",
    "recommendation_buy": "recommendation_buy", "recommendation_hold": "recommendation_hold",
    "recommendation_sell": "recommendation_sell", "recommendation_total": "recommendation_total",
}
SNAPSHOT_COLUMNS = ("symbol", "tv_symbol", "name", "sector", *METRIC_COLUMNS.values(),
                    "update_mode", "raw_row", "fetched_at")
#: TradingView answers a few hundred names per request comfortably; S7 caps a chunk at 500.
DEFAULT_CHUNK_SIZE = 500
#: S11 politeness: never two scanner requests closer than this.
MIN_INTERVAL_SECONDS = 1.0
HTTP_TIMEOUT_SECONDS = 20.0
MAX_ATTEMPTS = 3


@dataclass(frozen=True)
class ScanRecord:
    """One instrument as the scanner published it, already keyed by normalized symbol."""

    normalized_symbol: str
    tv_symbol: str
    name: str | None
    sector: str | None
    update_mode: str | None
    is_primary: bool
    metrics: dict[str, float | None]
    raw: dict[str, Any]


def post_json(
    url: str,
    payload: dict,
    *,
    timeout: float = HTTP_TIMEOUT_SECONDS,
    max_attempts: int = MAX_ATTEMPTS,
    backoff_base: float = 1.0,
    session: Any = None,
    sleep: Callable[[float], None] = time.sleep,
) -> dict:
    """POST ``payload`` as JSON and return the decoded body, retrying with exponential backoff.

    ``HttpFetcher`` only does GET, and the scanner only answers POST; rather than widen the
    shared fetcher (and the behaviour of every other source) this module keeps its own
    equivalent: same identifiable User-Agent, same bounded retries, same FetchError.

    Raises:
        FetchError: when every attempt failed (network error, HTTP error, unparseable body).
    """
    last_error: Exception | None = None
    for attempt in range(1, max_attempts + 1):
        try:
            http = session
            if http is None:
                import requests  # local import: tests inject a poster and never touch the network

                http = requests
            response = http.post(
                url, json=payload, timeout=timeout,
                headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
            )
            response.raise_for_status()
            return response.json()
        except Exception as exc:  # noqa: BLE001 — any transport/HTTP error is retryable
            last_error = exc
            log_event("http_attempt_failed", url=url, attempt=attempt, error=str(exc))
            if attempt < max_attempts:
                sleep(backoff_base * (2 ** (attempt - 1)))
    raise FetchError(f"POST {url} failed after {max_attempts} attempts: {last_error}")


class TradingViewScannerSource(InvestmentSource):
    """Bulk TradingView scanner readings of the Racional universe into stock_screen_snapshot."""

    source_code = "tradingview_scanner"
    display_name = "TradingView – métricas del screener"

    def __init__(
        self,
        *,
        poster: Callable[[str, dict], dict] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        chunk_size: int = DEFAULT_CHUNK_SIZE,
        min_interval: float = MIN_INTERVAL_SECONDS,
        asset_types: Sequence[str] = ("EQUITY",),
    ) -> None:
        self.poster = poster or (lambda url, payload: post_json(url, payload))
        self.sleep = sleep
        self.chunk_size = max(1, chunk_size)
        self.min_interval = min_interval
        self.asset_types = tuple(asset_types)
        self._conn: sqlite3.Connection | None = None
        self._requested: list[str] = []

    # --- sync: the base contract plus the connection fetch() needs --------------------

    def sync(self, conn: sqlite3.Connection, trigger: str = "cli") -> SyncResult:
        """Stash the connection fetch() reads its to-do list from, then run the shared sync."""
        self._conn = conn
        self._requested = []
        try:
            return super().sync(conn, trigger)
        finally:
            self._conn = None

    # --- fetch / normalize / validate / upsert ---------------------------------------

    def fetch(self) -> list[dict]:
        """POST the universe in chunks (>= 1 s apart) and return the rows the scanner answered."""
        conn = self._conn
        if conn is None:  # pragma: no cover — sync() always sets it before the base calls fetch()
            raise SourceError("fetch() needs the connection stashed by sync()")
        self._requested = self._universe(conn)
        if not self._requested:
            raise SourceError("no active symbols to scan in stocks_origin")
        rows: list[dict] = []
        for position in range(0, len(self._requested), self.chunk_size):
            chunk = self._requested[position:position + self.chunk_size]
            if position:
                self.sleep(self.min_interval)
            payload = self.poster(SCANNER_URL, self._payload(chunk))
            rows.extend(payload.get("data") or [])
            log_event("scanner_chunk_fetched", requested=len(chunk), returned=len(rows))
        return rows

    def _payload(self, chunk: Sequence[str]) -> dict:
        """The scanner request body for one chunk (`name in_range [...]`, S7's columns)."""
        return {
            "filter": [{"left": "name", "operation": "in_range", "right": list(chunk)}],
            "columns": list(SCANNER_COLUMNS),
            "range": [0, max(len(chunk) * 2, 10)],
        }

    def normalize(self, raw: Sequence[dict]) -> list[ScanRecord]:
        """Turn each scanner row into a DTO keyed by this repo's normalized symbol."""
        records: list[ScanRecord] = []
        for row in raw:
            values = dict(zip(SCANNER_COLUMNS, row.get("d") or []))
            symbol = (values.get("name") or "").strip()
            if not symbol:
                continue
            records.append(ScanRecord(
                normalized_symbol=normalize_ticker(symbol),
                tv_symbol=row.get("s") or "",
                name=values.get("description") or symbol,
                sector=values.get("sector"),
                update_mode=values.get("update_mode"),
                is_primary=bool(values.get("is_primary")),
                metrics={column: _number(values.get(scanner_column))
                         for scanner_column, column in METRIC_COLUMNS.items()},
                raw=values,
            ))
        return records

    def validate(self, items: Sequence[ScanRecord]) -> tuple[list[ScanRecord], list[dict]]:
        """Keep one row per symbol (is_primary wins) and report the symbols never returned."""
        best: dict[str, ScanRecord] = {}
        rejected: list[dict] = []
        for item in items:
            if item.metrics.get("close") is None:
                rejected.append({"symbol": item.normalized_symbol, "reason": "no_price"})
                continue
            current = best.get(item.normalized_symbol)
            if current is None or (item.is_primary and not current.is_primary):
                best[item.normalized_symbol] = item
        for symbol in self._requested:
            if normalize_ticker(symbol) not in best:
                rejected.append({"symbol": symbol, "reason": "not_returned_by_scanner"})
        return list(best.values()), rejected

    def upsert(self, items: Sequence[ScanRecord], conn: sqlite3.Connection) -> dict:
        """Replace the snapshot row of every scanned symbol; never delete, never touch prices."""
        now = utc_now()
        inserted = 0
        updated = 0
        for item in items:
            existed = conn.execute(
                "SELECT 1 FROM stock_screen_snapshot WHERE symbol = ?", (item.normalized_symbol,)
            ).fetchone() is not None
            values = {
                "symbol": item.normalized_symbol, "tv_symbol": item.tv_symbol, "name": item.name,
                "sector": item.sector, "update_mode": item.update_mode,
                "raw_row": json.dumps(item.raw, ensure_ascii=False), "fetched_at": now,
                **item.metrics,
            }
            conn.execute(
                f"INSERT OR REPLACE INTO stock_screen_snapshot ({', '.join(SNAPSHOT_COLUMNS)}) "
                f"VALUES ({', '.join('?' for _ in SNAPSHOT_COLUMNS)})",
                [values.get(column) for column in SNAPSHOT_COLUMNS],
            )
            updated += 1 if existed else 0
            inserted += 0 if existed else 1
        return {"inserted": inserted, "updated": updated, "reactivated": 0, "deactivated": 0}

    # --- the to-do list ---------------------------------------------------------------

    def _universe(self, conn: sqlite3.Connection) -> list[str]:
        """The active Racional symbols of the configured asset types, as TradingView names them."""
        placeholders = ", ".join("?" for _ in self.asset_types)
        rows = conn.execute(
            "SELECT DISTINCT normalized_symbol FROM stocks_origin "
            "WHERE source_code = 'racional_gsheet' AND is_active = 1 "
            f"AND asset_type IN ({placeholders}) ORDER BY normalized_symbol",
            self.asset_types,
        ).fetchall()
        return [row[0] for row in rows]


def _number(value: Any) -> float | None:
    """Scanner values are numbers or null; anything else (a string label) is treated as missing."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value)
