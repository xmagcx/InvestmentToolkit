"""test_investment_sources.py — behaviour tests for the investment-source framework (T1, S1-S3).

Purpose:
    Covers the Racional Google-Sheet connector end to end through its public interface
    (``sync()`` result + SELECTs against a real migrated SQLite file): insert/update/
    reactivate/deactivate semantics of ``stocks_origin``, the ``source_sync_run`` ledger,
    HttpFetcher retry/backoff and the ``sync_cli`` entry point. No network: the fetched
    CSV text is injected through a stub fetcher.

Key Input Dependencies:
    - fixtures/investment_sources/racional_sheet.csv (sheet sample incl. NA, BRK.A/BRK.B,
      an empty symbol and a duplicate AAPL)
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
from investment_sources import registry, sync_cli  # noqa: E402
from investment_sources.base import FetchError, HttpFetcher, SyncResult  # noqa: E402
from investment_sources.google_sheet_stocks import GoogleSheetStocksSource  # noqa: E402

FIXTURE = Path(__file__).parent / "fixtures" / "investment_sources" / "racional_sheet.csv"
SHEET_CSV = FIXTURE.read_text()
VALID_ROWS = 11  # 13 data rows minus the empty symbol and the duplicate AAPL


class StubFetcher:
    """Stands in for HttpFetcher: returns canned text (or raises) without touching the network."""

    def __init__(self, text: str = "", error: Exception | None = None) -> None:
        self.text = text
        self.error = error
        self.calls: list[str] = []

    def get_text(self, url: str) -> str:
        self.calls.append(url)
        if self.error is not None:
            raise self.error
        return self.text


def _source(text: str = SHEET_CSV, error: Exception | None = None) -> GoogleSheetStocksSource:
    return GoogleSheetStocksSource(fetcher=StubFetcher(text, error))


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    c = initialize_db(str(tmp_path / "domain_model.sqlite"))
    yield c
    c.close()


def _rows(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return {r["normalized_symbol"]: r for r in conn.execute("SELECT * FROM stocks_origin")}


def _runs(conn: sqlite3.Connection) -> list[sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return list(conn.execute("SELECT * FROM source_sync_run ORDER BY id"))


# --- S3: sheet parsing and first sync -------------------------------------------------


def test_first_sync_inserts_valid_rows_and_reports_counts(conn):
    result = _source().sync(conn)
    assert (result.status, result.inserted, result.updated, result.rejected) == ("success", VALID_ROWS, 0, 2)
    assert result.fetched == 13
    assert result.deactivated == 0 and result.reactivated == 0
    assert len(_rows(conn)) == VALID_ROWS


def test_ticker_na_survives_and_share_classes_stay_distinct(conn):
    _source().sync(conn)
    rows = _rows(conn)
    assert "NA" in rows
    assert rows["BRK.A"]["company_name"] == "Berkshire Hathaway Inc. Class A"
    assert rows["BRK.B"]["company_name"] == "Berkshire Hathaway Inc. Class B"


def test_apple_row_keeps_name_external_id_and_metadata(conn):
    _source().sync(conn)
    row = _rows(conn)["AAPL"]
    assert row["company_name"] == "Apple, Inc."
    assert row["external_id"] == "ikEJ"
    assert row["asset_type"] == "EQUITY"
    assert row["is_active"] == 1
    meta = json.loads(row["source_metadata"])
    assert meta["platform_url"] == "https://app.racional.cl/app/ikEJ?assetId=AAPL"
    assert meta["asset_id"] == "AAPL"
    assert meta["raw_symbol"] == "AAPL"


def test_etf_rows_keep_their_asset_type(conn):
    _source().sync(conn)
    assert _rows(conn)["AAXJ"]["asset_type"] == "ETF"


def test_sheet_url_follows_the_spec(monkeypatch):
    monkeypatch.delenv("RACIONAL_SHEET_DOCUMENT_ID", raising=False)
    monkeypatch.delenv("RACIONAL_SHEET_TAB_NAME", raising=False)
    assert _source().url == (
        "https://docs.google.com/spreadsheets/d/1Xm3AtWMAlIeGgSXFgmNBBuT5-nCZOA3-oUIPKEvs7t0"
        "/gviz/tq?tqx=out:csv&sheet=Stocks%20disponibles"
    )


def test_sheet_coordinates_come_from_env(monkeypatch):
    monkeypatch.setenv("RACIONAL_SHEET_DOCUMENT_ID", "DOC42")
    monkeypatch.setenv("RACIONAL_SHEET_TAB_NAME", "Otra hoja")
    assert _source().url == "https://docs.google.com/spreadsheets/d/DOC42/gviz/tq?tqx=out:csv&sheet=Otra%20hoja"


def test_rejected_rows_are_sampled_in_the_run_details(conn):
    _source().sync(conn)
    details = json.loads(_runs(conn)[0]["details"])
    reasons = {r["reason"] for r in details["rejected_sample"]}
    assert reasons == {"empty_symbol", "duplicate_symbol"}


def test_malformed_platform_url_is_rejected(conn):
    csv = "Simbolo,Nombre,Tipo,URL\nMSFT,Microsoft,EQUITY,ftp://app.racional.cl/app/zz?assetId=MSFT\n"
    result = _source(csv).sync(conn)
    assert (result.status, result.inserted, result.rejected) == ("failed", 0, 1)
    assert _rows(conn) == {}


# --- S2: upsert semantics -------------------------------------------------------------


def test_second_identical_sync_changes_nothing(conn):
    _source().sync(conn)
    result = _source().sync(conn)
    assert (result.status, result.inserted, result.updated, result.deactivated) == ("success", 0, 0, 0)
    assert len(_rows(conn)) == VALID_ROWS


def test_changed_company_name_is_an_update(conn):
    _source().sync(conn)
    changed = SHEET_CSV.replace('"Apple, Inc."', '"Apple Inc. (renamed)"', 1)
    result = _source(changed).sync(conn)
    assert (result.inserted, result.updated) == (0, 1)
    assert _rows(conn)["AAPL"]["company_name"] == "Apple Inc. (renamed)"


def test_removed_row_is_deactivated_not_deleted(conn):
    _source().sync(conn)
    shrunk = "\n".join(line for line in SHEET_CSV.splitlines() if not line.startswith("AAON,")) + "\n"
    result = _source(shrunk).sync(conn)
    assert result.deactivated == 1
    assert _rows(conn)["AAON"]["is_active"] == 0
    assert len(_rows(conn)) == VALID_ROWS


def test_reappearing_row_is_reactivated(conn):
    _source().sync(conn)
    shrunk = "\n".join(line for line in SHEET_CSV.splitlines() if not line.startswith("AAON,")) + "\n"
    _source(shrunk).sync(conn)
    result = _source().sync(conn)
    assert (result.reactivated, result.inserted, result.deactivated) == (1, 0, 0)
    assert _rows(conn)["AAON"]["is_active"] == 1


def test_last_seen_at_is_bumped_on_every_sync(conn):
    _source().sync(conn)
    before = _rows(conn)["AAPL"]["last_seen_at"]
    _source().sync(conn)
    assert _rows(conn)["AAPL"]["last_seen_at"] >= before
    assert _rows(conn)["AAPL"]["last_synced_at"] >= before


# --- S1/S2: failure paths never write -------------------------------------------------


def test_fetch_error_writes_no_data_and_deactivates_nothing(conn):
    _source().sync(conn)
    result = _source(error=FetchError("boom")).sync(conn)
    assert result.status == "failed"
    assert "boom" in (result.error or "")
    assert len(_rows(conn)) == VALID_ROWS
    assert all(r["is_active"] == 1 for r in _rows(conn).values())
    assert _runs(conn)[-1]["status"] == "failed"


def test_missing_required_header_fails_without_writes(conn):
    result = _source("Simbolo,Nombre,Tipo\nAAPL,Apple,EQUITY\n").sync(conn)
    assert result.status == "failed"
    assert "URL" in (result.error or "")
    assert _rows(conn) == {}
    assert _runs(conn)[-1]["status"] == "failed"


def test_empty_sheet_fails_and_deactivates_nothing(conn):
    _source().sync(conn)
    result = _source("Simbolo,Nombre,Tipo,URL\n").sync(conn)
    assert result.status == "failed"
    assert result.deactivated == 0
    assert all(r["is_active"] == 1 for r in _rows(conn).values())


def test_concurrent_running_sync_is_refused(conn):
    conn.execute(
        "INSERT INTO source_sync_run (source_code, trigger, started_at, status) "
        "VALUES ('racional_gsheet', 'cli', datetime('now'), 'running')"
    )
    conn.commit()
    result = _source().sync(conn)
    assert (result.status, result.error) == ("failed", "sync already running")
    assert _rows(conn) == {}


def test_stale_running_row_does_not_block_a_new_sync(conn):
    conn.execute(
        "INSERT INTO source_sync_run (source_code, trigger, started_at, status) "
        "VALUES ('racional_gsheet', 'cli', datetime('now', '-60 minutes'), 'running')"
    )
    conn.commit()
    assert _source().sync(conn).status == "success"


def test_run_row_records_metrics_and_trigger(conn):
    result = _source().sync(conn, trigger="manual")
    run = _runs(conn)[0]
    assert (run["source_code"], run["trigger"], run["status"]) == ("racional_gsheet", "manual", "success")
    assert (run["fetched"], run["inserted"], run["rejected"]) == (13, VALID_ROWS, 2)
    assert run["finished_at"] and run["duration_ms"] is not None
    assert result.run_id == run["id"]


def test_sync_result_to_dict_is_json_serialisable(conn):
    payload = _source().sync(conn).to_dict()
    assert json.loads(json.dumps(payload))["source_code"] == "racional_gsheet"
    assert set(payload) >= {
        "source_code", "status", "fetched", "inserted", "updated",
        "reactivated", "deactivated", "rejected", "duration_ms", "error", "run_id",
    }


# --- S1/S11: HttpFetcher --------------------------------------------------------------


class FakeResponse:
    def __init__(self, text: str) -> None:
        self.text = text
        self.status_code = 200

    def raise_for_status(self) -> None:
        return None


class FakeSession:
    """Fails `failures` times, then returns `text`."""

    def __init__(self, failures: int, text: str = "ok") -> None:
        self.failures = failures
        self.text = text
        self.calls: list[dict] = []

    def get(self, url, timeout=None, headers=None):
        self.calls.append({"url": url, "timeout": timeout, "headers": headers})
        if len(self.calls) <= self.failures:
            raise OSError("connection reset")
        return FakeResponse(self.text)


def test_http_fetcher_retries_then_succeeds():
    session = FakeSession(failures=2)
    slept: list[float] = []
    fetcher = HttpFetcher(session=session, sleep=slept.append)
    assert fetcher.get_text("https://example.test/x") == "ok"
    assert len(session.calls) == 3
    assert slept == [1.0, 2.0]


def test_http_fetcher_gives_up_after_three_attempts():
    session = FakeSession(failures=5)
    fetcher = HttpFetcher(session=session, sleep=lambda _s: None)
    with pytest.raises(FetchError):
        fetcher.get_text("https://example.test/x")
    assert len(session.calls) == 3


def test_http_fetcher_sends_timeout_and_identifiable_user_agent():
    session = FakeSession(failures=0)
    HttpFetcher(session=session, sleep=lambda _s: None).get_text("https://example.test/x")
    call = session.calls[0]
    assert call["timeout"] == 15.0
    assert call["headers"]["User-Agent"] == "InvestmentToolkit-screener/1.0 (informational research)"


def test_http_fetcher_waits_the_minimum_interval_between_requests():
    session = FakeSession(failures=0)
    slept: list[float] = []
    clock = iter([0.0, 0.5, 2.0])  # request 1 at t=0, interval check at t=0.5, request 2 mark
    fetcher = HttpFetcher(session=session, sleep=slept.append, min_interval=2.0, clock=lambda: next(clock))
    fetcher.get_text("https://example.test/a")
    fetcher.get_text("https://example.test/b")
    assert slept and slept[0] == pytest.approx(1.5)


# --- registry and CLI -----------------------------------------------------------------


def test_registry_exposes_the_google_sheet_source():
    assert registry.get_source("racional_gsheet") is GoogleSheetStocksSource
    listed = {s["source_code"]: s["display_name"] for s in registry.list_sources()}
    assert listed["racional_gsheet"] == "Racional – Stocks disponibles"


def test_registry_rejects_an_unknown_source():
    with pytest.raises(KeyError):
        registry.get_source("nope")


class FixtureSheetSource(GoogleSheetStocksSource):
    """Registry-installable source that reads the fixture instead of the network."""

    source_code = "test_sheet"
    display_name = "Fixture sheet"

    def __init__(self, **kwargs):
        super().__init__(fetcher=StubFetcher(SHEET_CSV), **kwargs)


class BrokenSheetSource(FixtureSheetSource):
    source_code = "broken_sheet"
    display_name = "Broken sheet"

    def __init__(self, **kwargs):
        super().__init__(**kwargs)
        self.fetcher = StubFetcher(error=FetchError("fixture failure"))


def test_cli_list_prints_one_json_object(capsys):
    assert sync_cli.main(["--list"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert any(s["source_code"] == "racional_gsheet" for s in payload["sources"])


def test_cli_sync_prints_one_json_object_and_exits_zero(tmp_path, capsys, monkeypatch):
    monkeypatch.setitem(registry.SOURCES, "test_sheet", FixtureSheetSource)
    db = str(tmp_path / "cli.sqlite")
    assert sync_cli.main(["--source", "test_sheet", "--db", db, "--trigger", "manual"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert (payload["status"], payload["inserted"]) == ("success", VALID_ROWS)
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM stocks_origin").fetchone()[0] == VALID_ROWS
    conn.close()


def test_cli_failed_sync_exits_one_with_json(tmp_path, capsys, monkeypatch):
    monkeypatch.setitem(registry.SOURCES, "broken_sheet", BrokenSheetSource)
    db = str(tmp_path / "cli_fail.sqlite")
    assert sync_cli.main(["--source", "broken_sheet", "--db", db]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "failed" and "fixture failure" in payload["error"]


def test_cli_unknown_source_exits_one_with_json(tmp_path, capsys):
    assert sync_cli.main(["--source", "ghost", "--db", str(tmp_path / "x.sqlite")]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["status"] == "failed"
    assert isinstance(SyncResult(**{k: payload[k] for k in ("source_code", "status")}).source_code, str)


def test_cli_runs_as_a_plain_script_like_the_node_bridge():
    """The Express bridge spawns `python3 <path>/sync_cli.py`, not `python -m`."""
    import subprocess

    script = REPO_ROOT / "investment_screener/backend/py_services/investment_sources/sync_cli.py"
    proc = subprocess.run([sys.executable, str(script), "--list"], capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    codes = [s["source_code"] for s in json.loads(proc.stdout)["sources"]]
    assert "racional_gsheet" in codes
