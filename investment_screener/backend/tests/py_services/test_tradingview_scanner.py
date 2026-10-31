"""test_tradingview_scanner.py — behaviour tests for the TradingView scanner snapshot source (B1a, S7).

Purpose:
    Covers ``TradingViewScannerSource`` through its public interface (``sync()`` result +
    SELECTs against a real migrated SQLite file): the universe it asks for (active EQUITY
    rows of racional_gsheet), the chunked POSTs with their politeness pause, the mapping of
    the tickers TradingView returns (is_primary preferred, BRK.B kept), the one-transaction
    upsert of ``stock_screen_snapshot`` and the reporting of symbols the scanner did not
    return. No network: the POST is injected.

Key Input Dependencies:
    - investment_screener/backend/schema/domain_model/*.sql (real migrator builds the tmp DB)
    - investment_sources.tradingview_scanner (the source under test)
"""
import json
import sqlite3
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from domain_model.db_client import initialize_db  # noqa: E402
from investment_sources import registry  # noqa: E402
from investment_sources.tradingview_scanner import (  # noqa: E402
    SCANNER_COLUMNS,
    SCANNER_URL,
    TradingViewScannerSource,
)


class StubPoster:
    """Stands in for the scanner POST: returns one canned payload per chunk, records the calls."""

    def __init__(self, responses: list[dict]) -> None:
        self.responses = responses
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, url: str, payload: dict) -> dict:
        self.calls.append((url, payload))
        return self.responses[min(len(self.calls) - 1, len(self.responses) - 1)]


def _scan_row(tv_symbol: str, name: str, **overrides) -> dict:
    """One `data` entry of a scanner response, with every column of SCANNER_COLUMNS filled."""
    values = {
        "name": name, "description": f"{name} Inc.", "sector": "Electronic Technology",
        "update_mode": "delayed_streaming_900", "is_primary": True,
        "close": 100.0, "price_52_week_high": 150.0, "SMA50": 95.0, "SMA200": 120.0,
        "RSI": 33.0, "MACD.macd": 1.0, "MACD.signal": 0.5,
        "price_earnings_ttm": 12.0, "earnings_per_share_diluted_ttm": 8.0,
        "earnings_per_share_diluted_yoy_growth_ttm": 10.0, "book_value_per_share_fq": 30.0,
        "return_on_equity": 20.0, "return_on_assets": 9.0, "return_on_invested_capital": 18.0,
        "free_cash_flow": 5_000_000_000.0, "market_cap_basic": 100_000_000_000.0,
        "debt_to_equity": 0.4, "price_earnings_growth_ttm": 0.9,
        "total_revenue_yoy_growth_ttm": 12.0, "price_target_average": 130.0,
        "recommendation_buy": 10, "recommendation_hold": 2, "recommendation_sell": 1,
        "recommendation_total": 20,
    }
    values.update(overrides)
    return {"s": tv_symbol, "d": [values[column] for column in SCANNER_COLUMNS]}


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    c = initialize_db(str(tmp_path / "domain_model.sqlite"))
    yield c
    c.close()


def _universe(conn: sqlite3.Connection, rows: list[tuple[str, str, int]]) -> None:
    """Seed stocks_origin with (normalized_symbol, asset_type, is_active) rows of racional_gsheet."""
    for symbol, asset_type, is_active in rows:
        conn.execute(
            "INSERT INTO stocks_origin (source_code, symbol, normalized_symbol, asset_type, is_active) "
            "VALUES ('racional_gsheet', ?, ?, ?, ?)",
            (symbol, symbol, asset_type, is_active),
        )
    conn.commit()


def _snapshot(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return {r["symbol"]: r for r in conn.execute("SELECT * FROM stock_screen_snapshot")}


def test_asks_only_for_active_equity_symbols_in_chunks_and_pauses_between_them(conn):
    _universe(conn, [("AAPL", "EQUITY", 1), ("MSFT", "EQUITY", 1), ("NVDA", "EQUITY", 1),
                     ("SPY", "ETF", 1), ("OLD", "EQUITY", 0)])
    poster = StubPoster([
        {"totalCount": 2, "data": [_scan_row("NASDAQ:AAPL", "AAPL"), _scan_row("NASDAQ:MSFT", "MSFT")]},
        {"totalCount": 1, "data": [_scan_row("NASDAQ:NVDA", "NVDA")]},
    ])
    slept: list[float] = []
    source = TradingViewScannerSource(poster=poster, sleep=slept.append, chunk_size=2)

    result = source.sync(conn, trigger="cli")

    assert result.status == "success"
    assert [call[0] for call in poster.calls] == [SCANNER_URL, SCANNER_URL]
    assert poster.calls[0][1]["filter"][0]["right"] == ["AAPL", "MSFT"]
    assert poster.calls[1][1]["filter"][0]["right"] == ["NVDA"]
    assert poster.calls[0][1]["columns"] == list(SCANNER_COLUMNS)
    assert slept and min(slept) >= 1.0
    assert set(_snapshot(conn)) == {"AAPL", "MSFT", "NVDA"}


def test_stores_every_scanner_column_and_the_raw_row(conn):
    _universe(conn, [("AAPL", "EQUITY", 1)])
    poster = StubPoster([{"data": [_scan_row("NASDAQ:AAPL", "AAPL", close=344.63, RSI=55.3)]}])

    TradingViewScannerSource(poster=poster, sleep=lambda _s: None).sync(conn)

    row = _snapshot(conn)["AAPL"]
    assert row["tv_symbol"] == "NASDAQ:AAPL"
    assert row["name"] == "AAPL Inc."
    assert row["sector"] == "Electronic Technology"
    assert row["close"] == 344.63
    assert row["rsi"] == 55.3
    assert row["roic"] == 18.0
    assert row["market_cap"] == 100_000_000_000.0
    assert row["recommendation_total"] == 20
    assert row["update_mode"] == "delayed_streaming_900"
    assert row["fetched_at"]
    assert json.loads(row["raw_row"])["close"] == 344.63


def test_keeps_dotted_share_classes_and_prefers_the_primary_listing(conn):
    _universe(conn, [("BRK.B", "EQUITY", 1)])
    poster = StubPoster([{"data": [
        _scan_row("OTC:BRKB", "BRK.B", is_primary=False, close=1.0),
        _scan_row("NYSE:BRK.B", "BRK.B", is_primary=True, close=542.49),
    ]}])

    TradingViewScannerSource(poster=poster, sleep=lambda _s: None).sync(conn)

    row = _snapshot(conn)["BRK.B"]
    assert row["tv_symbol"] == "NYSE:BRK.B"
    assert row["close"] == 542.49


def test_replaces_the_previous_snapshot_row_of_a_symbol(conn):
    _universe(conn, [("AAPL", "EQUITY", 1)])
    first = StubPoster([{"data": [_scan_row("NASDAQ:AAPL", "AAPL", close=100.0)]}])
    TradingViewScannerSource(poster=first, sleep=lambda _s: None).sync(conn)
    second = StubPoster([{"data": [_scan_row("NASDAQ:AAPL", "AAPL", close=120.0)]}])

    result = TradingViewScannerSource(poster=second, sleep=lambda _s: None).sync(conn)

    rows = list(conn.execute("SELECT close FROM stock_screen_snapshot WHERE symbol = 'AAPL'"))
    assert rows == [(120.0,)]
    assert result.updated == 1 and result.inserted == 0


def test_symbols_the_scanner_did_not_return_are_rejected_and_reported(conn):
    _universe(conn, [("AAPL", "EQUITY", 1), ("GHOST", "EQUITY", 1)])
    poster = StubPoster([{"data": [_scan_row("NASDAQ:AAPL", "AAPL")]}])

    result = TradingViewScannerSource(poster=poster, sleep=lambda _s: None).sync(conn)

    assert result.status == "success"
    assert result.rejected == 1
    details = json.loads(conn.execute(
        "SELECT details FROM source_sync_run WHERE source_code = 'tradingview_scanner'"
    ).fetchone()[0])
    assert details["rejected_sample"] == [{"symbol": "GHOST", "reason": "not_returned_by_scanner"}]


def test_a_failed_post_writes_no_snapshot_row(conn):
    _universe(conn, [("AAPL", "EQUITY", 1)])

    def boom(_url: str, _payload: dict) -> dict:
        raise RuntimeError("scanner down")

    result = TradingViewScannerSource(poster=boom, sleep=lambda _s: None).sync(conn)

    assert result.status == "failed" and "scanner down" in (result.error or "")
    assert _snapshot(conn) == {}


def test_never_writes_investment_price(conn):
    _universe(conn, [("AAPL", "EQUITY", 1)])
    poster = StubPoster([{"data": [_scan_row("NASDAQ:AAPL", "AAPL")]}])

    TradingViewScannerSource(poster=poster, sleep=lambda _s: None).sync(conn)

    assert conn.execute("SELECT COUNT(*) FROM investment_price").fetchone()[0] == 0


def test_registered_under_its_source_code():
    assert registry.get_source("tradingview_scanner") is TradingViewScannerSource
    assert {"source_code": "tradingview_scanner",
            "display_name": "TradingView – métricas del screener"} in registry.list_sources()
