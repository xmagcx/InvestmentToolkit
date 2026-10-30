"""test_yfinance_enrichment.py — behaviour tests for the yfinance profile enrichment (T6, S10).

Purpose:
    Covers ``YFinanceProfileEnrichment`` through its public interface (``sync()`` result +
    SELECTs against a real migrated SQLite file): which rows are picked for a batch, how
    sector/industry/country/currency are filled without ever being overwritten by an empty
    value, the per-symbol error isolation, the rate limiting, the source_metadata exchange
    mapping and the ``source_sync_run`` ledger row. No network: yfinance's ``Ticker().info``
    is injected as a callable and ``sleep`` is captured.

Key Input Dependencies:
    - investment_screener/backend/schema/domain_model/*.sql (real migrator builds the tmp DB)
    - investment_sources.yfinance_enrichment.YFinanceProfileEnrichment
"""
import json
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from domain_model.db_client import initialize_db  # noqa: E402
from investment_sources import registry, sync_cli  # noqa: E402
from investment_sources.yfinance_enrichment import YFinanceProfileEnrichment  # noqa: E402

APPLE_INFO = {
    "sector": "Technology",
    "industry": "Consumer Electronics",
    "country": "United States",
    "currency": "USD",
    "exchange": "NMS",
    "quoteType": "EQUITY",
}
ETF_INFO = {"currency": "USD", "exchange": "PCX", "quoteType": "ETF"}


def _ago(**delta) -> str:
    return (datetime.now(timezone.utc) - timedelta(**delta)).isoformat(timespec="seconds")


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    c = initialize_db(str(tmp_path / "domain_model.sqlite"))
    yield c
    c.close()


def _seed(conn: sqlite3.Connection, symbol: str, *, source_code: str = "racional_gsheet", **columns) -> None:
    """Insert one stocks_origin row (the shape GoogleSheetStocksSource leaves behind)."""
    columns.setdefault("is_active", 1)
    names = ", ".join(columns)
    placeholders = ", ".join("?" for _ in columns)
    conn.execute(
        f"INSERT INTO stocks_origin (source_code, symbol, normalized_symbol, exchange, {names}) "
        f"VALUES (?, ?, ?, '', {placeholders})",
        [source_code, symbol, symbol, *columns.values()],
    )
    conn.commit()


def _rows(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return {r["normalized_symbol"]: r for r in conn.execute("SELECT * FROM stocks_origin")}


def _runs(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return list(conn.execute("SELECT * FROM source_sync_run ORDER BY id"))


class StubInfo:
    """Stands in for yfinance's ``Ticker(symbol).info``: canned dicts, optional exceptions."""

    def __init__(self, infos: dict, errors: dict | None = None) -> None:
        self.infos = infos
        self.errors = errors or {}
        self.calls: list[str] = []

    def __call__(self, symbol: str) -> dict:
        self.calls.append(symbol)
        if symbol in self.errors:
            raise self.errors[symbol]
        return self.infos.get(symbol, {})


def _source(infos: dict, errors: dict | None = None, slept: list | None = None, **kwargs):
    return YFinanceProfileEnrichment(
        info_provider=StubInfo(infos, errors),
        sleep=(slept if slept is not None else []).append,
        **kwargs,
    )


# --- S10: filling the profile columns -------------------------------------------------


def test_sector_industry_country_currency_are_filled(conn):
    _seed(conn, "AAPL")
    result = _source({"AAPL": APPLE_INFO}).sync(conn)
    row = _rows(conn)["AAPL"]
    assert (result.status, result.fetched, result.updated) == ("success", 1, 1)
    assert row["sector"] == "Technology"
    assert row["industry"] == "Consumer Electronics"
    assert row["country"] == "United States"
    assert row["currency"] == "USD"
    assert row["enrichment_status"] == "ok"
    assert row["enriched_at"]


def test_every_source_row_of_the_same_symbol_is_enriched(conn):
    _seed(conn, "AAPL")
    _seed(conn, "AAPL", source_code="dataroma_q")
    result = _source({"AAPL": APPLE_INFO}).sync(conn)
    assert (result.fetched, result.updated) == (1, 2)
    sectors = [r[0] for r in conn.execute("SELECT sector FROM stocks_origin")]
    assert sectors == ["Technology", "Technology"]


def test_etf_without_sector_keeps_null_and_is_marked_no_data(conn):
    _seed(conn, "SPY")
    assert _source({"SPY": ETF_INFO}).sync(conn).status == "success"
    row = _rows(conn)["SPY"]
    assert row["sector"] is None and row["industry"] is None
    assert row["currency"] == "USD"
    assert row["enrichment_status"] == "no_data"


def test_empty_value_never_overwrites_an_existing_sector(conn):
    _seed(conn, "AAPL", sector="Technology", industry="Consumer Electronics", country="United States")
    _source({"AAPL": {"sector": "", "industry": None, "currency": "USD"}}).sync(conn)
    row = _rows(conn)["AAPL"]
    assert row["sector"] == "Technology"
    assert row["industry"] == "Consumer Electronics"
    assert row["country"] == "United States"
    assert row["currency"] == "USD"


def test_exchange_column_is_never_touched(conn):
    _seed(conn, "AAPL")
    _source({"AAPL": APPLE_INFO}).sync(conn)
    assert _rows(conn)["AAPL"]["exchange"] == ""


# --- S10: per-symbol failure isolation ------------------------------------------------


def test_one_failing_symbol_does_not_abort_the_batch(conn):
    _seed(conn, "AAPL")
    _seed(conn, "BOOM")
    result = _source({"AAPL": APPLE_INFO}, errors={"BOOM": RuntimeError("yf exploded")}).sync(conn)
    rows = _rows(conn)
    assert result.status == "success" and result.fetched == 2
    assert rows["AAPL"]["sector"] == "Technology"
    assert rows["BOOM"]["enrichment_status"] == "error"
    assert rows["BOOM"]["sector"] is None
    assert rows["BOOM"]["enriched_at"]


# --- S10: incremental batches ---------------------------------------------------------


def test_batch_limit_is_respected_and_oldest_rows_go_first(conn):
    _seed(conn, "OLD", enriched_at=_ago(days=200), enrichment_status="ok")
    _seed(conn, "MID", enriched_at=_ago(days=120), enrichment_status="ok")
    _seed(conn, "FRESH", enriched_at=_ago(days=1), enrichment_status="ok")
    _seed(conn, "NEVER")
    source = _source({})
    source.limit = 2
    result = source.sync(conn)
    assert result.fetched == 2
    assert source.info_provider.calls == ["NEVER", "OLD"]


def test_rerun_skips_fresh_rows_and_still_succeeds(conn):
    _seed(conn, "AAPL")
    _source({"AAPL": APPLE_INFO}).sync(conn)
    source = _source({"AAPL": APPLE_INFO})
    result = source.sync(conn)
    assert (result.status, result.fetched, result.updated, result.rejected) == ("success", 0, 0, 0)
    assert (result.inserted, result.deactivated, result.reactivated, result.error) == (0, 0, 0, None)
    assert source.info_provider.calls == []
    assert _runs(conn)[-1]["status"] == "success"


def test_failed_symbol_is_retried_after_a_day_not_before(conn):
    _seed(conn, "YOUNGERROR", enriched_at=_ago(hours=2), enrichment_status="error")
    _seed(conn, "OLDERROR", enriched_at=_ago(days=2), enrichment_status="error")
    source = _source({"OLDERROR": APPLE_INFO})
    source.sync(conn)
    assert source.info_provider.calls == ["OLDERROR"]


def test_dotted_class_symbol_is_looked_up_with_a_dash(conn):
    _seed(conn, "BRK.B")
    source = _source({"BRK-B": APPLE_INFO})
    source.sync(conn)
    assert source.info_provider.calls == ["BRK-B"]
    assert _rows(conn)["BRK.B"]["sector"] == "Technology"


# --- S10: metadata and rate limiting --------------------------------------------------


@pytest.mark.parametrize(
    "yf_code,tv_prefix",
    [("NMS", "NASDAQ"), ("NGM", "NASDAQ"), ("NCM", "NASDAQ"), ("NYQ", "NYSE"),
     ("ASE", "AMEX"), ("PCX", "AMEX"), ("BATS", "CBOE")],
)
def test_tv_exchange_is_mapped_from_the_yfinance_exchange_code(conn, yf_code, tv_prefix):
    _seed(conn, "X")
    _source({"X": {**APPLE_INFO, "exchange": yf_code}}).sync(conn)
    meta = json.loads(_rows(conn)["X"]["source_metadata"])
    assert meta["yf_exchange"] == yf_code
    assert meta["yf_quote_type"] == "EQUITY"
    assert meta["tv_exchange"] == tv_prefix


def test_unknown_exchange_code_omits_tv_exchange_and_keeps_existing_metadata(conn):
    _seed(conn, "X", source_metadata=json.dumps({"platform_url": "https://app.racional.cl/app/z"}))
    _source({"X": {**APPLE_INFO, "exchange": "ZZZ"}}).sync(conn)
    meta = json.loads(_rows(conn)["X"]["source_metadata"])
    assert "tv_exchange" not in meta
    assert meta["yf_exchange"] == "ZZZ"
    assert meta["platform_url"] == "https://app.racional.cl/app/z"


def test_a_minimum_interval_is_slept_between_lookups(conn):
    for symbol in ("A", "B", "C"):
        _seed(conn, symbol)
    slept: list[float] = []
    _source({}, slept=slept).sync(conn)
    assert slept == [1.0, 1.0]


# --- S1/S4: ledger and CLI ------------------------------------------------------------


def test_run_row_is_written_under_the_enrichment_source_code(conn):
    _seed(conn, "AAPL")
    result = _source({"AAPL": APPLE_INFO}).sync(conn, trigger="manual")
    run = _runs(conn)[-1]
    assert (run["source_code"], run["trigger"], run["status"]) == ("yfinance_enrichment", "manual", "success")
    assert (run["fetched"], run["updated"]) == (1, 1)
    assert run["finished_at"] and result.run_id == run["id"]


def test_source_identity_matches_the_spec():
    assert YFinanceProfileEnrichment.source_code == "yfinance_enrichment"
    assert YFinanceProfileEnrichment.display_name == "yfinance – sector/industry enrichment"


def test_batch_limit_defaults_to_the_env_variable(monkeypatch):
    monkeypatch.setenv("YF_ENRICH_BATCH", "7")
    assert YFinanceProfileEnrichment().limit == 7
    monkeypatch.delenv("YF_ENRICH_BATCH")
    assert YFinanceProfileEnrichment().limit == 150


class FixtureEnrichmentSource(YFinanceProfileEnrichment):
    """Registry-installable enrichment that answers from a canned info dict."""

    source_code = "test_enrichment"
    display_name = "Fixture enrichment"

    def __init__(self, **kwargs):
        super().__init__(info_provider=StubInfo({"AAPL": APPLE_INFO}), sleep=lambda _s: None, **kwargs)


def test_cli_runs_the_enrichment_and_prints_one_json_object(tmp_path, capsys, monkeypatch):
    monkeypatch.setitem(registry.SOURCES, "test_enrichment", FixtureEnrichmentSource)
    db = str(tmp_path / "cli.sqlite")
    seed_conn = initialize_db(db)
    _seed(seed_conn, "AAPL")
    seed_conn.close()

    assert sync_cli.main(["--source", "test_enrichment", "--db", db, "--trigger", "manual"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert (payload["status"], payload["fetched"], payload["updated"]) == ("success", 1, 1)
    check = sqlite3.connect(db)
    assert check.execute("SELECT sector FROM stocks_origin").fetchone()[0] == "Technology"
    check.close()
