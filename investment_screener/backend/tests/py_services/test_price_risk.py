"""test_price_risk.py — behaviour tests for the three-year risk source (C1, S11/S14).

Purpose:
    Covers ``PriceRiskSource`` through its public interface (``sync()`` result + SELECTs
    against a real migrated SQLite file): the to-do list (active EQUITY symbols that have a
    scanner snapshot row), the batched downloads with their politeness pause and the SPY
    benchmark, the ``stock_risk_metrics`` upsert, and the symbols rejected for having less
    than two years of history. No network: the downloader is injected.

Key Input Dependencies:
    - investment_screener/backend/schema/domain_model/*.sql (real migrator builds the tmp DB)
    - investment_sources.price_risk (the source under test), risk_metrics
"""
import sqlite3
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

import risk_metrics  # noqa: E402
from domain_model.db_client import initialize_db  # noqa: E402
from investment_sources import registry  # noqa: E402
from investment_sources.price_risk import PriceRiskSource  # noqa: E402

DAYS = 760


def closes(days: int = DAYS, seed: int = 1, start: float = 100.0) -> pd.Series:
    """A random-walk close series with a fixed seed, long enough to be computable."""
    rng = np.random.default_rng(seed)
    values = start * np.cumprod(1 + rng.normal(0.0004, 0.012, days))
    return pd.Series(values, index=pd.bdate_range("2023-01-02", periods=days))


class StubDownloader:
    """Stands in for yfinance: returns canned closes per requested batch, records the calls."""

    def __init__(self, series: dict[str, pd.Series]) -> None:
        self.series = series
        self.calls: list[list[str]] = []

    def __call__(self, symbols, period: str) -> pd.DataFrame:
        self.calls.append(list(symbols))
        available = {s: self.series[s] for s in symbols if s in self.series}
        return pd.DataFrame(available)


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    c = initialize_db(str(tmp_path / "domain_model.sqlite"))
    yield c
    c.close()


def seed(conn: sqlite3.Connection, symbol: str, asset_type: str = "EQUITY",
         is_active: int = 1, snapshot: bool = True) -> None:
    conn.execute(
        "INSERT INTO stocks_origin (source_code, symbol, normalized_symbol, asset_type, is_active) "
        "VALUES ('racional_gsheet', ?, ?, ?, ?)",
        (symbol, symbol, asset_type, is_active),
    )
    if snapshot:
        conn.execute(
            "INSERT INTO stock_screen_snapshot (symbol, close, fetched_at) VALUES (?, 100.0, ?)",
            (symbol, "2026-10-31T12:00:00+00:00"),
        )
    conn.commit()


def _rows(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    conn.row_factory = sqlite3.Row
    return {r["symbol"]: r for r in conn.execute("SELECT * FROM stock_risk_metrics")}


def test_downloads_only_active_equities_with_a_snapshot_in_batches_with_the_benchmark(conn):
    seed(conn, "AAA")
    seed(conn, "BBB")
    seed(conn, "CCC")
    seed(conn, "SPYX", asset_type="ETF")
    seed(conn, "OLD", is_active=0)
    seed(conn, "NOSNAP", snapshot=False)
    downloader = StubDownloader({s: closes(seed=i) for i, s in enumerate(["AAA", "BBB", "CCC", "SPY"])})
    slept: list[float] = []

    result = PriceRiskSource(downloader=downloader, sleep=slept.append, batch_size=2).sync(conn)

    assert result.status == "success"
    assert downloader.calls[0] == ["SPY"]
    assert downloader.calls[1:] == [["AAA", "BBB"], ["CCC"]]
    assert slept and min(slept) >= 1.0
    assert set(_rows(conn)) == {"AAA", "BBB", "CCC"}


def test_stores_exactly_what_the_canonical_formulas_return(conn):
    seed(conn, "AAA")
    series, benchmark = closes(seed=4), closes(seed=9)
    downloader = StubDownloader({"AAA": series, "SPY": benchmark})

    PriceRiskSource(downloader=downloader, sleep=lambda _s: None).sync(conn)

    expected = risk_metrics.compute(series, benchmark)
    row = _rows(conn)["AAA"]
    assert row["sortino_3y"] == pytest.approx(expected["sortino"])
    assert row["sharpe_3y"] == pytest.approx(expected["sharpe"])
    assert row["downside_beta_3y"] == pytest.approx(expected["downside_beta"])
    assert row["max_drawdown_3y"] == pytest.approx(expected["max_drawdown"])
    assert row["recovery_days"] == expected["recovery_days"]
    assert row["volatility_ann"] == pytest.approx(expected["volatility"])
    assert row["history_days"] == DAYS
    assert row["as_of"] == series.index[-1].date().isoformat()
    assert row["fetched_at"]


def test_a_symbol_without_two_years_of_history_is_rejected_and_writes_nothing(conn):
    seed(conn, "AAA")
    seed(conn, "SHORT")
    seed(conn, "GONE")
    downloader = StubDownloader({"AAA": closes(), "SHORT": closes(days=200), "SPY": closes(seed=3)})

    result = PriceRiskSource(downloader=downloader, sleep=lambda _s: None).sync(conn)

    assert result.status == "success"
    assert result.rejected == 2
    assert set(_rows(conn)) == {"AAA"}
    reasons = {r["symbol"]: r["reason"] for r in _rejected_sample(conn)}
    assert reasons["SHORT"] == "insufficient_history"
    assert reasons["GONE"] == "no_price_history"


def test_a_second_run_replaces_the_row_instead_of_adding_one(conn):
    seed(conn, "AAA")
    first = StubDownloader({"AAA": closes(seed=1), "SPY": closes(seed=2)})
    PriceRiskSource(downloader=first, sleep=lambda _s: None).sync(conn)

    second = StubDownloader({"AAA": closes(seed=5), "SPY": closes(seed=2)})
    result = PriceRiskSource(downloader=second, sleep=lambda _s: None).sync(conn)

    assert result.inserted == 0 and result.updated == 1
    assert len(_rows(conn)) == 1
    assert _rows(conn)["AAA"]["sortino_3y"] == pytest.approx(
        risk_metrics.compute(closes(seed=5), closes(seed=2))["sortino"])


def test_without_the_benchmark_the_downside_beta_is_missing_but_the_rest_is_stored(conn):
    seed(conn, "AAA")
    downloader = StubDownloader({"AAA": closes()})

    result = PriceRiskSource(downloader=downloader, sleep=lambda _s: None).sync(conn)

    assert result.status == "success"
    row = _rows(conn)["AAA"]
    assert row["downside_beta_3y"] is None
    assert row["sortino_3y"] is not None


def test_a_failing_download_fails_the_sync_without_writing(conn):
    seed(conn, "AAA")

    def boom(symbols, period):
        raise RuntimeError("yfinance down")

    result = PriceRiskSource(downloader=boom, sleep=lambda _s: None).sync(conn)

    assert result.status == "failed"
    assert "yfinance down" in (result.error or "")
    assert _rows(conn) == {}


def test_the_source_is_registered_under_price_risk():
    assert registry.get_source("price_risk") is PriceRiskSource
    assert PriceRiskSource.source_code == "price_risk"
    assert PriceRiskSource.display_name == "yfinance – riesgo 3 años"


def _rejected_sample(conn: sqlite3.Connection) -> list[dict]:
    import json

    row = conn.execute(
        "SELECT details FROM source_sync_run WHERE source_code = 'price_risk' ORDER BY id DESC LIMIT 1"
    ).fetchone()
    return json.loads(row[0])["rejected_sample"]
