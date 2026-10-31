"""test_fred_aaa.py — behaviour tests for the FRED AAA corporate-bond yield source (B1a, S7).

Purpose:
    Covers ``FredAaaSource`` through its public interface (``sync()`` result + SELECTs on a
    real migrated SQLite file): the CSV it parses, the "latest non-empty observation" rule
    (FRED publishes trailing rows with a '.' placeholder), the upsert of the single
    ``market_rate`` row for series AAA, and the failure path that writes nothing. No network:
    the CSV text is injected through a stub fetcher.

Key Input Dependencies:
    - investment_screener/backend/schema/domain_model/*.sql (real migrator builds the tmp DB)
    - investment_sources.fred_aaa (the source under test)
"""
import sqlite3
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from domain_model.db_client import initialize_db  # noqa: E402
from investment_sources import registry  # noqa: E402
from investment_sources.base import FetchError  # noqa: E402
from investment_sources.fred_aaa import FRED_AAA_URL, FredAaaSource  # noqa: E402

CSV = "observation_date,AAA\n2026-07-01,5.91\n2026-08-01,5.98\n2026-09-01,6.03\n2026-10-01,.\n"


class StubFetcher:
    """Stands in for HttpFetcher: returns canned CSV text (or raises) without touching the network."""

    def __init__(self, text: str = CSV, error: Exception | None = None) -> None:
        self.text = text
        self.error = error
        self.calls: list[str] = []

    def get_text(self, url: str) -> str:
        self.calls.append(url)
        if self.error is not None:
            raise self.error
        return self.text


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    c = initialize_db(str(tmp_path / "domain_model.sqlite"))
    yield c
    c.close()


def _rate(conn: sqlite3.Connection) -> sqlite3.Row | None:
    conn.row_factory = sqlite3.Row
    return conn.execute("SELECT * FROM market_rate WHERE series_id = 'AAA'").fetchone()


def test_stores_the_latest_non_empty_observation(conn):
    fetcher = StubFetcher()

    result = FredAaaSource(fetcher=fetcher).sync(conn, trigger="cli")

    assert result.status == "success" and result.inserted == 1
    assert fetcher.calls == [FRED_AAA_URL]
    row = _rate(conn)
    assert row["value"] == 6.03
    assert row["observed_at"] == "2026-09-01"
    assert row["fetched_at"]


def test_a_second_sync_updates_the_single_row_in_place(conn):
    FredAaaSource(fetcher=StubFetcher()).sync(conn)

    result = FredAaaSource(fetcher=StubFetcher(CSV + "2026-11-01,6.21\n")).sync(conn)

    assert result.updated == 1 and result.inserted == 0
    assert conn.execute("SELECT COUNT(*) FROM market_rate").fetchone()[0] == 1
    assert _rate(conn)["value"] == 6.21


def test_a_failed_fetch_writes_nothing(conn):
    result = FredAaaSource(fetcher=StubFetcher(error=FetchError("timeout"))).sync(conn)

    assert result.status == "failed" and "timeout" in (result.error or "")
    assert _rate(conn) is None


def test_a_csv_without_a_usable_observation_fails(conn):
    result = FredAaaSource(fetcher=StubFetcher("observation_date,AAA\n2026-10-01,.\n")).sync(conn)

    assert result.status == "failed"
    assert _rate(conn) is None


def test_registered_under_its_source_code():
    assert registry.get_source("fred_aaa") is FredAaaSource
    assert {"source_code": "fred_aaa",
            "display_name": "FRED – rendimiento bonos AAA"} in registry.list_sources()
