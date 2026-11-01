"""test_dataroma_holdings.py — behaviour tests for the superinvestor-holdings source (C2, S12/S14).

Purpose:
    Drives ``DataromaHoldingsSource`` through its public interface (``sync()`` result +
    SELECTs against a real migrated SQLite file) using saved HTML fixtures only — no
    network, ever. Pins what the stock page exposes (ownership count, the holders grid,
    the hold price), what it does not (the previous quarter's count stays NULL), the
    per-symbol rejection of an unexpected page, the S11 scraping etiquette and the
    idempotent upsert into ``stock_superinvestor_holdings``.

Key Input Dependencies:
    - fixtures/investment_sources/dataroma_stock_tmo.html (trimmed real page, 13 holders)
    - fixtures/investment_sources/dataroma_stock_one_holder.html (VITL: no hold price)
    - fixtures/investment_sources/dataroma_stock_no_holders.html (KOPN: ownership count 0)
    - fixtures/investment_sources/dataroma_stock_malformed.html (grid lost a column)
    - investment_screener/backend/schema/domain_model/*.sql (real migrator builds the tmp DB)
    - the S14 DDL of stock_superinvestor_holdings (created here while migration 0016 lands)
"""
import json
import sqlite3
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from domain_model.db_client import initialize_db  # noqa: E402
from investment_sources.dataroma_holdings import (  # noqa: E402
    MAX_SYMBOLS_PER_RUN,
    TABLE,
    DataromaHoldingsSource,
    select_symbols,
    stock_url,
)

FIXTURES = Path(__file__).parent / "fixtures" / "investment_sources"

#: S14 DDL; migration 0016 (owned by another worker) creates the same table.
HOLDINGS_DDL = """
CREATE TABLE IF NOT EXISTS stock_superinvestor_holdings (
    symbol TEXT PRIMARY KEY,
    holders INTEGER NOT NULL,
    holders_prev INTEGER,
    max_portfolio_pct REAL,
    avg_hold_price REAL,
    net_activity INTEGER,
    top_holders TEXT,
    fetched_at TEXT NOT NULL
)
"""


def _fixture(name: str) -> str:
    return (FIXTURES / f"{name}.html").read_text()


class StubFetcher:
    """Returns a saved page per symbol URL; records the call order."""

    def __init__(self, pages: dict[str, str]) -> None:
        self.pages = {stock_url(symbol): html for symbol, html in pages.items()}
        self.calls: list[str] = []

    def get_text(self, url: str) -> str:
        self.calls.append(url)
        if url not in self.pages:
            raise AssertionError(f"unexpected URL requested: {url}")
        return self.pages[url]


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    c = initialize_db(str(tmp_path / "domain_model.sqlite"))
    c.execute(HOLDINGS_DDL)
    c.commit()
    c.row_factory = sqlite3.Row
    yield c
    c.close()


def _source(pages: dict[str, str]):
    fetcher = StubFetcher(pages)
    return DataromaHoldingsSource(symbols=list(pages), fetcher=fetcher), fetcher


def _row(conn: sqlite3.Connection, symbol: str):
    return conn.execute(f"SELECT * FROM {TABLE} WHERE symbol = ?", (symbol,)).fetchone()


# --- S12: what the stock page exposes -------------------------------------------------


def test_tmo_page_values_are_stored(conn):
    source, _ = _source({"TMO": _fixture("dataroma_stock_tmo")})
    result = source.sync(conn)
    row = _row(conn, "TMO")
    assert result.status == "success"
    assert (result.fetched, result.inserted, result.rejected) == (1, 1, 0)
    assert row["holders"] == 13
    assert row["holders_prev"] is None  # the page does not publish the previous quarter
    assert row["max_portfolio_pct"] == 9.81
    assert row["avg_hold_price"] == 521.83
    assert row["net_activity"] == 6  # 9 buys/adds - 3 reduces
    assert row["fetched_at"]


def test_tmo_top_holders_are_the_five_largest_positions(conn):
    source, _ = _source({"TMO": _fixture("dataroma_stock_tmo")})
    source.sync(conn)
    top = json.loads(_row(conn, "TMO")["top_holders"])
    assert [entry["manager"] for entry in top] == [
        "Lindsell Train",
        "Wallace Weitz - Weitz Investment Management",
        "Viking Global Investors",
        "Harry Burn - Sound Shore",
        "First Pacific Advisors",
    ]
    assert top[0] == {"manager": "Lindsell Train", "pct": 9.81, "activity": "Reduce 16.64%"}
    assert top[3]["activity"] == "Buy"


def test_page_without_a_hold_price_stores_null(conn):
    source, _ = _source({"VITL": _fixture("dataroma_stock_one_holder")})
    source.sync(conn)
    row = _row(conn, "VITL")
    assert (row["holders"], row["max_portfolio_pct"]) == (1, 0.01)
    assert row["avg_hold_price"] is None  # Dataroma publishes it only from two investors on
    assert row["net_activity"] == 1


def test_page_with_no_holders_stores_zero(conn):
    source, _ = _source({"KOPN": _fixture("dataroma_stock_no_holders")})
    result = source.sync(conn)
    row = _row(conn, "KOPN")
    assert (result.status, result.rejected) == ("success", 0)
    assert row["holders"] == 0
    assert (row["max_portfolio_pct"], row["avg_hold_price"]) == (None, None)
    assert (row["net_activity"], json.loads(row["top_holders"])) == (0, [])


# --- strict parsing: one bad page never costs the others ------------------------------


def test_malformed_page_is_rejected_and_the_other_symbols_are_stored(conn):
    source, _ = _source({
        "TMO": _fixture("dataroma_stock_tmo"),
        "BAD": _fixture("dataroma_stock_malformed"),
    })
    result = source.sync(conn)
    assert (result.status, result.fetched) == ("success", 2)
    assert (result.inserted, result.rejected) == (1, 1)
    assert _row(conn, "TMO") is not None and _row(conn, "BAD") is None
    run = conn.execute(
        "SELECT details FROM source_sync_run WHERE source_code = 'dataroma_holdings' ORDER BY id DESC"
    ).fetchone()
    rejected = json.loads(run["details"])["rejected_sample"]
    assert rejected[0]["symbol"] == "BAD"
    assert "% of portfolio" in rejected[0]["reason"]


# --- S11 etiquette --------------------------------------------------------------------


def test_source_is_configured_with_a_polite_min_interval():
    assert DataromaHoldingsSource().fetcher.min_interval >= 2.0


def test_symbols_are_fetched_one_at_a_time_in_order():
    source, fetcher = _source({
        "TMO": _fixture("dataroma_stock_tmo"),
        "VITL": _fixture("dataroma_stock_one_holder"),
    })
    source.fetch()
    assert fetcher.calls == [stock_url("TMO"), stock_url("VITL")]


def test_source_identity_follows_the_spec():
    assert DataromaHoldingsSource.source_code == "dataroma_holdings"
    assert DataromaHoldingsSource.display_name == "Dataroma – tenencia de superinversores"
    assert stock_url("TMO") == "https://www.dataroma.com/m/stock.php?sym=TMO"


# --- the symbol selection -------------------------------------------------------------


def test_selection_includes_the_latest_quarter_buys(conn):
    for symbol in ("TMO", "KDP"):
        conn.execute(
            "INSERT INTO recent_buys_q (quarter, symbol, normalized_symbol, first_seen_at, "
            "last_synced_at) VALUES (?, ?, ?, '2026-11-01', '2026-11-01')",
            ("2026Q3", symbol, symbol),
        )
    conn.execute(
        "INSERT INTO recent_buys_q (quarter, symbol, normalized_symbol, first_seen_at, "
        "last_synced_at) VALUES ('2026Q2', 'OLD', 'OLD', '2026-08-01', '2026-08-01')"
    )
    conn.commit()
    assert select_symbols(conn) == ["KDP", "TMO"]


def test_selection_is_capped_per_run(conn):
    rows = [(f"S{n:04d}",) for n in range(MAX_SYMBOLS_PER_RUN + 50)]
    conn.executemany(
        "INSERT INTO recent_buys_q (quarter, symbol, normalized_symbol, first_seen_at, "
        "last_synced_at) VALUES ('2026Q3', ?, ?, '2026-11-01', '2026-11-01')",
        [(symbol, symbol) for (symbol,) in rows],
    )
    conn.commit()
    assert len(select_symbols(conn)) == MAX_SYMBOLS_PER_RUN


# --- the upsert -----------------------------------------------------------------------


def test_second_sync_updates_the_same_row(conn):
    pages = {"TMO": _fixture("dataroma_stock_tmo")}
    _source(pages)[0].sync(conn)
    first = _row(conn, "TMO")["fetched_at"]
    second = _source(pages)[0].sync(conn)
    assert (second.status, second.inserted, second.updated) == ("success", 0, 1)
    assert conn.execute(f"SELECT COUNT(*) FROM {TABLE}").fetchone()[0] == 1
    assert _row(conn, "TMO")["fetched_at"] >= first


def test_selection_includes_fallen_snapshot_symbols_through_the_real_engine(conn):
    """No mocks: the step-4 survivors come from opportunity_screener.fallen_symbols."""
    conn.execute(
        "INSERT INTO stocks_origin (source_code, symbol, normalized_symbol, asset_type, is_active) "
        "VALUES ('racional_gsheet', 'FELL', 'FELL', 'EQUITY', 1)"
    )
    conn.execute(
        "INSERT INTO stock_screen_snapshot (symbol, tv_symbol, name, close, price_52_week_high, "
        "sma200, fetched_at) VALUES ('FELL', 'NYSE:FELL', 'Fell Inc.', 70, 100, 90, '2026-11-01')"
    )
    conn.commit()
    assert select_symbols(conn) == ["FELL"]
