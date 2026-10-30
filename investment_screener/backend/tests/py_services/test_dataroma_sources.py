"""test_dataroma_sources.py — behaviour tests for the two Dataroma connectors (T4/T5, S6/S7/S11).

Purpose:
    Drives ``DataromaQuarterlyBuysSource`` and ``DataromaInsiderBuysSource`` through their
    public interface (``sync()`` result + SELECTs against a real migrated SQLite file) using
    saved HTML fixtures only — no network, ever. Also pins the shared parsing helpers
    (numbers, dates, quarter, pagination) and the scraping etiquette of S11 (identifiable
    User-Agent, >= 2 s between requests, sequential pages).

Key Input Dependencies:
    - fixtures/investment_sources/dataroma_quarterly_p1.html (real page 1) + trimmed pages
    - fixtures/investment_sources/dataroma_insider_p1.html (real page 1) + trimmed pages
    - investment_screener/backend/schema/domain_model/*.sql (real migrator builds the tmp DB)
"""
import json
import sqlite3
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from domain_model.db_client import initialize_db  # noqa: E402
from investment_sources import dataroma, registry  # noqa: E402
from investment_sources.base import USER_AGENT, HttpFetcher, SourceError  # noqa: E402
from investment_sources.dataroma_insider_buys import DataromaInsiderBuysSource  # noqa: E402
from investment_sources.dataroma_quarterly_buys import DataromaQuarterlyBuysSource  # noqa: E402

FIXTURES = Path(__file__).parent / "fixtures" / "investment_sources"


def _fixture(name: str) -> str:
    return (FIXTURES / f"{name}.html").read_text()


class StubFetcher:
    """Returns saved HTML per URL (or a default page); records the call order."""

    def __init__(self, pages: dict[str, str], default: str | None = None) -> None:
        self.pages = pages
        self.default = default
        self.calls: list[str] = []

    def get_text(self, url: str) -> str:
        self.calls.append(url)
        if url in self.pages:
            return self.pages[url]
        if self.default is not None:
            return self.default
        raise AssertionError(f"unexpected URL requested: {url}")


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    c = initialize_db(str(tmp_path / "domain_model.sqlite"))
    c.row_factory = sqlite3.Row
    yield c
    c.close()


def _quarterly(p1: str = "dataroma_quarterly_p1", p2: str = "dataroma_quarterly_p2"):
    base = DataromaQuarterlyBuysSource.url
    fetcher = StubFetcher({
        dataroma.page_url(base, 1): _fixture(p1),
        dataroma.page_url(base, 2): _fixture(p2),
    })
    return DataromaQuarterlyBuysSource(fetcher=fetcher), fetcher


def _insider(p1: str = "dataroma_insider_p1"):
    base = DataromaInsiderBuysSource.url
    fetcher = StubFetcher(
        {
            dataroma.page_url(base, 1): _fixture(p1),
            dataroma.page_url(base, 2): _fixture("dataroma_insider_p2"),
        },
        default=_fixture("dataroma_insider_empty"),
    )
    return DataromaInsiderBuysSource(fetcher=fetcher), fetcher


# --- shared parsers (dataroma.py) -----------------------------------------------------


@pytest.mark.parametrize(
    "text,expected",
    [("$521.83", 521.83), ("8,671,495", 8671495.0), ("59.79", 59.79), ("", None), ("-", None), ("n/a", None)],
)
def test_parse_number(text, expected):
    assert dataroma.parse_number(text) == expected


@pytest.mark.parametrize("text,expected", [("245,898", 245898), ("3", 3), ("", None), ("-", None)])
def test_parse_int(text, expected):
    assert dataroma.parse_int(text) == expected


def test_parse_filing_datetime():
    assert dataroma.parse_filing_datetime("30 Oct 2026 18:06") == "2026-10-30T18:06"
    assert dataroma.parse_filing_datetime("not a date") is None


def test_parse_transaction_date():
    assert dataroma.parse_transaction_date("29 Oct 2026") == "2026-10-29"
    assert dataroma.parse_transaction_date("") is None


def test_parse_quarter():
    assert dataroma.parse_quarter("No. of buys/adds (reported so far): 172 Q3 2026") == "2026Q3"
    assert dataroma.parse_quarter("No quarter here") is None


def test_page_url_appends_the_L_parameter():
    assert dataroma.page_url("https://www.dataroma.com/m/g/portfolio_b.php?q=q&o=c", 2) == (
        "https://www.dataroma.com/m/g/portfolio_b.php?q=q&o=c&L=2"
    )


def test_page_count_discovery_reads_the_pagination_links():
    assert dataroma.discover_page_count(_fixture("dataroma_quarterly_p1")) == 2
    assert dataroma.discover_page_count(_fixture("dataroma_insider_p1")) == 14


def test_page_count_without_pagination_is_one_and_is_capped():
    assert dataroma.discover_page_count("<html><body>no pages</body></html>") == 1
    links = "".join(f'<a href="x.php?o=c&L={n}">{n}</a>' for n in range(1, 200))
    assert dataroma.discover_page_count(f'<div id="pages">{links}</div>') == dataroma.MAX_PAGES


def test_required_columns_missing_raises_source_error():
    with pytest.raises(SourceError):
        dataroma.require_columns(["Symbol", "Stock"], ["Symbol", "Stock", "Buys"], "grid")


# --- S11 scraping etiquette -----------------------------------------------------------


def test_sources_are_configured_with_a_polite_min_interval():
    for source in (DataromaQuarterlyBuysSource(), DataromaInsiderBuysSource()):
        assert source.fetcher.min_interval >= 2.0


def test_fetcher_sends_the_identifiable_user_agent():
    class FakeResponse:
        text = "<html></html>"

        def raise_for_status(self):
            return None

    class FakeSession:
        def __init__(self):
            self.headers_seen = []

        def get(self, url, timeout=None, headers=None):
            self.headers_seen.append(headers)
            return FakeResponse()

    session = FakeSession()
    HttpFetcher(session=session, sleep=lambda _: None).get_text("https://www.dataroma.com/")
    assert session.headers_seen[0]["User-Agent"] == USER_AGENT
    assert "InvestmentToolkit" in USER_AGENT


def test_pages_are_fetched_sequentially_in_order():
    source, fetcher = _quarterly()
    source.fetch()
    base = DataromaQuarterlyBuysSource.url
    assert fetcher.calls == [dataroma.page_url(base, 1), dataroma.page_url(base, 2)]


# --- S6: quarterly buys ---------------------------------------------------------------


def test_quarterly_sync_stores_every_page_under_one_quarter(conn):
    source, _ = _quarterly()
    result = source.sync(conn)
    rows = list(conn.execute("SELECT * FROM recent_buys_q"))
    assert result.status == "success"
    assert result.fetched == 102
    assert result.inserted == len(rows) == 102
    assert result.deactivated == 0 and result.reactivated == 0
    assert {r["quarter"] for r in rows} == {"2026Q3"}


def test_quarterly_tmo_row_keeps_every_published_column(conn):
    source, _ = _quarterly()
    source.sync(conn)
    row = conn.execute("SELECT * FROM recent_buys_q WHERE normalized_symbol = 'TMO'").fetchone()
    assert row["company_name"] == "Thermo Fisher Scientific"
    assert (row["portfolio_pct"], row["buys_count"]) == (0.017, 3)
    assert (row["hold_price"], row["current_price"]) == (521.83, 694.28)
    assert (row["low_52w"], row["pct_above_low_52w"], row["high_52w"]) == (434.50, 59.79, 714.02)
    assert row["source_url"].endswith("L=1")
    assert json.loads(row["raw_row"])["Symbol"] == "TMO"
    assert row["first_seen_at"] and row["last_synced_at"]


def test_quarterly_page_two_rows_are_stored(conn):
    source, _ = _quarterly()
    source.sync(conn)
    row = conn.execute("SELECT * FROM recent_buys_q WHERE normalized_symbol = 'KDP'").fetchone()
    assert (row["company_name"], row["hold_price"]) == ("Keurig Dr Pepper Inc.", 27.10)
    assert row["source_url"].endswith("L=2")


def test_quarterly_second_sync_inserts_nothing(conn):
    _quarterly()[0].sync(conn)
    second = _quarterly()[0].sync(conn)
    assert second.status == "success"
    assert second.inserted == 0
    assert conn.execute("SELECT COUNT(*) FROM recent_buys_q").fetchone()[0] == 102


def test_quarterly_missing_quarter_fails_without_writes(conn):
    source = DataromaQuarterlyBuysSource(
        fetcher=StubFetcher({}, default=_fixture("dataroma_quarterly_no_quarter"))
    )
    result = source.sync(conn)
    assert result.status == "failed"
    assert "quarter" in (result.error or "").lower()
    assert conn.execute("SELECT COUNT(*) FROM recent_buys_q").fetchone()[0] == 0


def test_quarterly_quarter_mismatch_between_pages_fails_without_writes(conn):
    source, _ = _quarterly(p2="dataroma_quarterly_p2_other_quarter")
    result = source.sync(conn)
    assert result.status == "failed"
    assert "quarter" in (result.error or "").lower()
    assert conn.execute("SELECT COUNT(*) FROM recent_buys_q").fetchone()[0] == 0


def test_quarterly_missing_column_fails_without_writes(conn):
    source = DataromaQuarterlyBuysSource(
        fetcher=StubFetcher({}, default=_fixture("dataroma_quarterly_missing_column"))
    )
    result = source.sync(conn)
    assert result.status == "failed"
    assert "52 Week High" in (result.error or "")
    assert conn.execute("SELECT COUNT(*) FROM recent_buys_q").fetchone()[0] == 0


def test_quarterly_ledger_row_records_the_run(conn):
    _quarterly()[0].sync(conn)
    run = conn.execute(
        "SELECT * FROM source_sync_run WHERE source_code = 'dataroma_quarterly_buys' ORDER BY id DESC"
    ).fetchone()
    assert (run["status"], run["inserted"]) == ("success", 102)


# --- S7: insider buys -----------------------------------------------------------------


def test_insider_sync_keeps_only_purchases(conn):
    source, _ = _insider()
    result = source.sync(conn)
    stored = conn.execute("SELECT COUNT(*) FROM recent_buys_insider").fetchone()[0]
    assert result.status == "success"
    assert result.fetched == 102
    # the PFE "Sale" row on page 2 and the ELVR filing page 1 publishes twice, verbatim
    assert result.rejected == 2
    assert result.inserted == stored == 100
    run = conn.execute(
        "SELECT details FROM source_sync_run WHERE source_code = 'dataroma_insider_buys' ORDER BY id DESC"
    ).fetchone()
    reasons = {entry["reason"] for entry in json.loads(run["details"])["rejected_sample"]}
    assert reasons == {"not_a_purchase", "duplicate_filing"}
    assert conn.execute(
        "SELECT COUNT(*) FROM recent_buys_insider WHERE normalized_symbol = 'PFE'"
    ).fetchone()[0] == 0
    assert {r[0] for r in conn.execute("SELECT DISTINCT transaction_type FROM recent_buys_insider")} == {"Purchase"}


def test_insider_nbis_row_matches_the_published_filing(conn):
    source, _ = _insider()
    source.sync(conn)
    row = conn.execute("SELECT * FROM recent_buys_insider WHERE normalized_symbol = 'NBIS'").fetchone()
    assert row["filing_at"] == "2026-10-30T18:06"
    assert row["security_name"] == "Nebius Group N.V."
    assert (row["reporting_name"], row["reporting_id"]) == ("GRIMME ARNE", "2091395")
    assert (row["relationship"], row["transaction_date"]) == ("Director", "2026-10-29")
    assert (row["shares"], row["price"], row["amount"]) == (148, 169.42, 25074.0)
    assert (row["ownership_type"], row["is_ten_pct_owner"], row["is_amendment"]) == ("D", 0, 0)
    assert row["filing_url"].startswith("https://www.sec.gov/")
    assert row["source_url"].endswith("L=1")


def test_insider_ten_percent_owner_and_indirect_ownership(conn):
    source, _ = _insider()
    source.sync(conn)
    crbg = conn.execute("SELECT * FROM recent_buys_insider WHERE normalized_symbol = 'CRBG'").fetchone()
    ecf = conn.execute("SELECT * FROM recent_buys_insider WHERE normalized_symbol = 'ECF'").fetchone()
    assert (crbg["is_ten_pct_owner"], crbg["shares"], crbg["price"]) == (1, 245898, 35.2646)
    assert ecf["ownership_type"] == "I"


def test_insider_amendment_row_is_flagged(conn):
    source, _ = _insider()
    source.sync(conn)
    row = conn.execute("SELECT * FROM recent_buys_insider WHERE normalized_symbol = 'XOM'").fetchone()
    assert row["is_amendment"] == 1
    assert (row["shares"], row["price"]) == (1000, 110.50)
    assert row["source_url"].endswith("L=2")


def test_insider_second_sync_inserts_nothing(conn):
    _insider()[0].sync(conn)
    before = conn.execute("SELECT COUNT(*) FROM recent_buys_insider").fetchone()[0]
    second = _insider()[0].sync(conn)
    assert (second.status, second.inserted) == ("success", 0)
    assert conn.execute("SELECT COUNT(*) FROM recent_buys_insider").fetchone()[0] == before


def test_insider_missing_column_fails_without_writes(conn):
    source = DataromaInsiderBuysSource(
        fetcher=StubFetcher({}, default=_fixture("dataroma_insider_missing_column"))
    )
    result = source.sync(conn)
    assert result.status == "failed"
    assert "sh" in (result.error or "")
    assert conn.execute("SELECT COUNT(*) FROM recent_buys_insider").fetchone()[0] == 0


# --- registry -------------------------------------------------------------------------


def test_both_dataroma_sources_are_registered():
    codes = {entry["source_code"] for entry in registry.list_sources()}
    assert {"racional_gsheet", "dataroma_quarterly_buys", "dataroma_insider_buys"} <= codes
    assert registry.get_source("dataroma_quarterly_buys") is DataromaQuarterlyBuysSource
    assert registry.get_source("dataroma_insider_buys") is DataromaInsiderBuysSource


def test_source_urls_follow_the_spec():
    assert DataromaQuarterlyBuysSource.url == "https://www.dataroma.com/m/g/portfolio_b.php?q=q&o=c"
    assert DataromaInsiderBuysSource.url == (
        "https://www.dataroma.com/m/ins/ins.php?t=m&po=1&am=0&sym=&o=fd&d=d"
    )
    assert DataromaQuarterlyBuysSource.display_name == "Dataroma – Superinvestor quarter buys"
    assert DataromaInsiderBuysSource.display_name == "Dataroma – Insider purchases"
