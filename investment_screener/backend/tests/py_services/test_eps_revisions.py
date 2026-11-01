"""test_eps_revisions.py — behaviour tests for the analyst-revisions source (C1, S11/S14).

Purpose:
    Covers ``EpsRevisionsSource`` through its public interface (``sync()`` result + SELECTs
    against a real migrated SQLite file): the to-do list (only the symbols that pass step 4
    of the screener on the latest snapshot, using the engine's own rule), the per-symbol
    yfinance call with its politeness pause, the current-year row ('0y', falling back to
    '0q'), the defensive column naming, the ``stock_eps_revisions`` upsert and the isolation
    of a symbol whose lookup raises. No network: the provider is injected.

Key Input Dependencies:
    - investment_screener/backend/schema/domain_model/*.sql (real migrator builds the tmp DB)
    - investment_sources.eps_revisions (the source under test), opportunity_screener (step 4)
"""
import sqlite3
import sys
from pathlib import Path

import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from domain_model.db_client import initialize_db  # noqa: E402
from investment_sources import registry  # noqa: E402
from investment_sources.eps_revisions import EpsRevisionsSource  # noqa: E402

#: A snapshot row that passes step 4: it fell 25 % from its high and trades under its SMA200.
FALLEN = dict(close=75.0, price_52_week_high=100.0, sma200=90.0, sma50=70.0, eps_ttm=4.0)


class StubProvider:
    """Stands in for yf.Ticker(sym).get_eps_revisions(): canned frames, recorded calls."""

    def __init__(self, frames: dict) -> None:
        self.frames = frames
        self.calls: list[str] = []

    def __call__(self, symbol: str):
        self.calls.append(symbol)
        value = self.frames.get(symbol, KeyError(f"no data for {symbol}"))
        if isinstance(value, Exception):
            raise value
        return value


def frame(up7=1, up30=3, down7=0, down30=1, periods=("0y",), columns=None) -> pd.DataFrame:
    names = columns or ["upLast7days", "upLast30days", "downLast7days", "downLast30days"]
    data = [[up7, up30, down7, down30] for _ in periods]
    return pd.DataFrame(data, index=list(periods), columns=names)


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    c = initialize_db(str(tmp_path / "domain_model.sqlite"))
    yield c
    c.close()


def seed(conn: sqlite3.Connection, symbol: str, **snapshot) -> None:
    values = {**FALLEN, **snapshot}
    columns = ["symbol", "fetched_at", *values]
    conn.execute(
        "INSERT INTO stocks_origin (source_code, symbol, normalized_symbol, asset_type, is_active) "
        "VALUES ('racional_gsheet', ?, ?, 'EQUITY', 1)",
        (symbol, symbol),
    )
    conn.execute(
        f"INSERT INTO stock_screen_snapshot ({', '.join(columns)}) "
        f"VALUES ({', '.join('?' for _ in columns)})",
        [symbol, "2026-10-31T12:00:00+00:00", *values.values()],
    )
    conn.commit()


def _rows(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return {r["symbol"]: r for r in conn.execute("SELECT * FROM stock_eps_revisions")}


def test_asks_only_for_the_symbols_that_passed_step_four(conn):
    seed(conn, "FALLEN")
    seed(conn, "NOFALL", close=99.0, sma200=50.0)       # never fell, trades above its SMA200
    seed(conn, "ABOVE200", close=95.0, sma200=90.0)     # fell, but is not under its SMA200
    provider = StubProvider({"FALLEN": frame()})
    slept: list[float] = []

    result = EpsRevisionsSource(provider=provider, sleep=slept.append).sync(conn)

    assert result.status == "success"
    assert provider.calls == ["FALLEN"]
    assert set(_rows(conn)) == {"FALLEN"}


def test_pauses_at_least_half_a_second_between_symbols(conn):
    seed(conn, "AAA")
    seed(conn, "BBB")
    provider = StubProvider({"AAA": frame(), "BBB": frame()})
    slept: list[float] = []

    EpsRevisionsSource(provider=provider, sleep=slept.append).sync(conn)

    assert provider.calls == ["AAA", "BBB"]
    assert slept and min(slept) >= 0.5


def test_stores_the_current_year_row(conn):
    seed(conn, "AAA")
    provider = StubProvider({"AAA": frame(up7=2, up30=5, down7=1, down30=2,
                                          periods=("0q", "0y", "+1y"))})

    EpsRevisionsSource(provider=provider, sleep=lambda _s: None).sync(conn)

    row = _rows(conn)["AAA"]
    assert (row["up_7d"], row["up_30d"], row["down_7d"], row["down_30d"]) == (2, 5, 1, 2)
    assert row["period"] == "0y"
    assert row["fetched_at"]


def test_falls_back_to_the_current_quarter_row_and_records_the_period(conn):
    seed(conn, "AAA")
    provider = StubProvider({"AAA": frame(up30=4, periods=("0q", "+1q"))})

    EpsRevisionsSource(provider=provider, sleep=lambda _s: None).sync(conn)

    row = _rows(conn)["AAA"]
    assert row["period"] == "0q"
    assert row["up_30d"] == 4


def test_column_naming_variants_are_understood(conn):
    seed(conn, "AAA")
    provider = StubProvider({"AAA": frame(columns=["upLast7Days", "up_last_30days",
                                                   "downLast7Days", "DownLast30Days"])})

    EpsRevisionsSource(provider=provider, sleep=lambda _s: None).sync(conn)

    row = _rows(conn)["AAA"]
    assert (row["up_7d"], row["up_30d"], row["down_7d"], row["down_30d"]) == (1, 3, 0, 1)


def test_a_failing_symbol_does_not_lose_the_batch(conn):
    seed(conn, "AAA")
    seed(conn, "BOOM")
    provider = StubProvider({"AAA": frame(), "BOOM": RuntimeError("yfinance exploded")})

    result = EpsRevisionsSource(provider=provider, sleep=lambda _s: None).sync(conn)

    assert result.status == "success"
    assert set(_rows(conn)) == {"AAA"}
    reasons = {r["symbol"]: r["reason"] for r in _rejected_sample(conn)}
    assert "yfinance exploded" in reasons["BOOM"]


def test_an_empty_or_unusable_frame_is_rejected_not_stored_as_zero(conn):
    seed(conn, "AAA")
    seed(conn, "EMPTY")
    seed(conn, "NOYEAR")
    provider = StubProvider({"AAA": frame(), "EMPTY": pd.DataFrame(),
                             "NOYEAR": frame(periods=("+1y",))})

    EpsRevisionsSource(provider=provider, sleep=lambda _s: None).sync(conn)

    assert set(_rows(conn)) == {"AAA"}


def test_a_second_run_replaces_the_row(conn):
    seed(conn, "AAA")
    EpsRevisionsSource(provider=StubProvider({"AAA": frame(up30=3)}),
                       sleep=lambda _s: None).sync(conn)

    result = EpsRevisionsSource(provider=StubProvider({"AAA": frame(up30=9)}),
                                sleep=lambda _s: None).sync(conn)

    assert result.inserted == 0 and result.updated == 1
    assert _rows(conn)["AAA"]["up_30d"] == 9


def test_the_source_is_registered_under_eps_revisions():
    assert registry.get_source("eps_revisions") is EpsRevisionsSource
    assert EpsRevisionsSource.source_code == "eps_revisions"
    assert EpsRevisionsSource.display_name == "yfinance – revisiones de analistas"


def _rejected_sample(conn: sqlite3.Connection) -> list[dict]:
    import json

    row = conn.execute(
        "SELECT details FROM source_sync_run WHERE source_code = 'eps_revisions' "
        "ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return json.loads(row[0])["rejected_sample"]
