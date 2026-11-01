#!/usr/bin/env python3
"""price_risk.py — fill stock_risk_metrics with the three-year risk reading of each symbol (S11/S14).

Purpose:
    Step 5 of the opportunities funnel ("¿Es una caída sana?") needs, per instrument, how it
    paid for its risk and how hard it fell when the market fell. This source downloads three
    years of daily closes from yfinance in batches (one request per batch of symbols, at least
    a second apart), plus SPY as the benchmark, hands them to ``risk_metrics`` (rule 19: the
    formulas live there and nowhere else) and replaces the ``stock_risk_metrics`` row of every
    symbol it could measure, inside one transaction.

    It is an ``InvestmentSource`` like any other, so the CLI, the ``source_sync_run`` ledger,
    the Express sync route and the scheduler treat it exactly like the connectors.

    Two rules it never breaks: it never writes ``investment_price`` (rule 25 keeps
    tv_price_refresh.py the only price writer), and a symbol with less than two years of
    history is reported in ``rejected`` instead of being stored with an invented number.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    python3 sync_cli.py --source price_risk
    PriceRiskSource(batch_size=50).sync(conn, trigger="manual")

Key Classes / Functions (Index):
    - RiskRecord: frozen DTO with one symbol's computed metrics (or why there are none)
    - yfinance_closes(symbols, period): the default bulk download (yf.download, auto_adjust)
    - PriceRiskSource: fetch/normalize/validate/upsert for the risk pass

Key Input Dependencies:
    - stocks_origin (active EQUITY of racional_gsheet) joined to stock_screen_snapshot
    - yfinance (only when no downloader is injected; tests always inject one)
    - py_services/risk_metrics.py

Key Output Dependencies:
    - stock_risk_metrics rows (migration 0016)
    - source_sync_run rows under source_code 'price_risk'
"""
from __future__ import annotations

import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import risk_metrics  # noqa: E402

from .base import (  # noqa: E402
    InvestmentSource,
    SourceError,
    SyncResult,
    log_event,
    utc_now,
)
from .yfinance_enrichment import yfinance_symbol  # noqa: E402

#: How many symbols one yfinance request asks for (yf.download takes a list of tickers).
DEFAULT_BATCH_SIZE = 50
#: Politeness: never two downloads closer than this (yfinance is unofficial).
MIN_INTERVAL_SECONDS = 1.0
#: Three years of daily closes, so the two-year minimum of risk_metrics is comfortably met.
DEFAULT_PERIOD = "3y"
#: The market the downside beta is measured against (S11).
BENCHMARK_SYMBOL = "SPY"
RISK_COLUMNS = ("symbol", "sortino_3y", "sharpe_3y", "downside_beta_3y", "max_drawdown_3y",
                "recovery_days", "volatility_ann", "history_days", "as_of", "fetched_at")


@dataclass(frozen=True)
class RiskRecord:
    """One symbol's three-year risk metrics, or the reason it has none."""

    symbol: str
    metrics: dict | None = None
    reason: str | None = None


def yfinance_closes(symbols: Sequence[str], period: str = DEFAULT_PERIOD) -> pd.DataFrame:
    """Download daily adjusted closes of several tickers at once (the default downloader)."""
    import yfinance as yf  # local import: tests inject a downloader and never touch the network

    data = yf.download(list(symbols), period=period, interval="1d", auto_adjust=True,
                       threads=False, progress=False)
    if data is None or data.empty:
        return pd.DataFrame()
    if isinstance(data.columns, pd.MultiIndex):
        return data["Close"] if "Close" in data.columns.get_level_values(0) else pd.DataFrame()
    if "Close" not in data.columns:
        return pd.DataFrame()
    return data[["Close"]].rename(columns={"Close": symbols[0]})


class PriceRiskSource(InvestmentSource):
    """Three-year risk metrics of every screened symbol, from yfinance closes."""

    source_code = "price_risk"
    display_name = "yfinance – riesgo 3 años"

    def __init__(
        self,
        *,
        downloader: Callable[[Sequence[str], str], pd.DataFrame] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        batch_size: int = DEFAULT_BATCH_SIZE,
        min_interval: float = MIN_INTERVAL_SECONDS,
        period: str = DEFAULT_PERIOD,
        benchmark: str = BENCHMARK_SYMBOL,
        limit: int | None = None,
    ) -> None:
        self.downloader = downloader or yfinance_closes
        self.sleep = sleep
        self.batch_size = max(1, batch_size)
        self.min_interval = min_interval
        self.period = period
        self.benchmark = benchmark
        self.limit = limit
        self._conn: sqlite3.Connection | None = None

    # --- sync: the base contract plus the connection fetch() needs --------------------

    def sync(self, conn: sqlite3.Connection, trigger: str = "cli") -> SyncResult:
        """Stash the connection fetch() reads its to-do list from, then run the shared sync."""
        self._conn = conn
        try:
            return super().sync(conn, trigger)
        finally:
            self._conn = None

    # --- fetch / normalize / validate / upsert ---------------------------------------

    def fetch(self) -> dict:
        """Download the benchmark and then every symbol in batches, >= min_interval apart."""
        conn = self._conn
        if conn is None:  # pragma: no cover — sync() always sets it before the base calls fetch()
            raise SourceError("fetch() needs the connection stashed by sync()")
        symbols = self._pending_symbols(conn)
        if not symbols:
            raise SourceError("no screened symbols to measure (sync 'tradingview_scanner' first)")
        benchmark = self._download([self.benchmark]).get(self.benchmark)
        if benchmark is None:
            log_event("risk_benchmark_missing", benchmark=self.benchmark)
        series: dict[str, pd.Series] = {}
        for position in range(0, len(symbols), self.batch_size):
            batch = symbols[position:position + self.batch_size]
            self.sleep(self.min_interval)
            series.update(self._download(batch))
            log_event("risk_batch_fetched", requested=len(batch), measured=len(series))
        return {"benchmark": benchmark, "closes": series, "symbols": symbols}

    def _download(self, symbols: Sequence[str]) -> dict[str, pd.Series]:
        """One download call, mapped back from yfinance tickers to normalized symbols."""
        lookups = {symbol: yfinance_symbol(symbol) for symbol in symbols}
        frame = self.downloader(list(lookups.values()), self.period)
        if frame is None or len(frame) == 0:
            return {}
        frame = pd.DataFrame(frame)
        out: dict[str, pd.Series] = {}
        for symbol, lookup in lookups.items():
            if lookup in frame.columns:
                column = pd.to_numeric(frame[lookup], errors="coerce").dropna()
                if len(column):
                    out[symbol] = column
        return out

    def normalize(self, raw: dict) -> list[RiskRecord]:
        """Compute every symbol's metrics with the canonical formulas (rule 19)."""
        benchmark = raw.get("benchmark")
        closes = raw.get("closes") or {}
        records: list[RiskRecord] = []
        for symbol in raw.get("symbols") or []:
            series = closes.get(symbol)
            if series is None:
                records.append(RiskRecord(symbol, reason="no_price_history"))
                continue
            metrics = risk_metrics.compute(series, benchmark)
            records.append(RiskRecord(symbol, metrics=metrics,
                                      reason=None if metrics else "insufficient_history"))
        return records

    def validate(self, items: Sequence[RiskRecord]) -> tuple[list[RiskRecord], list[dict]]:
        """Keep the symbols that produced metrics; report the rest with their reason."""
        valid = [item for item in items if item.metrics]
        rejected = [{"symbol": item.symbol, "reason": item.reason}
                    for item in items if not item.metrics]
        return valid, rejected

    def upsert(self, items: Sequence[RiskRecord], conn: sqlite3.Connection) -> dict:
        """Replace the risk row of every measured symbol; never delete, never touch prices."""
        now = utc_now()
        inserted = 0
        updated = 0
        for item in items:
            existed = conn.execute(
                "SELECT 1 FROM stock_risk_metrics WHERE symbol = ?", (item.symbol,)
            ).fetchone() is not None
            metrics = item.metrics or {}
            conn.execute(
                f"INSERT OR REPLACE INTO stock_risk_metrics ({', '.join(RISK_COLUMNS)}) "
                f"VALUES ({', '.join('?' for _ in RISK_COLUMNS)})",
                [item.symbol, metrics.get("sortino"), metrics.get("sharpe"),
                 metrics.get("downside_beta"), metrics.get("max_drawdown"),
                 metrics.get("recovery_days"), metrics.get("volatility"),
                 metrics.get("history_days"), metrics.get("as_of"), now],
            )
            updated += 1 if existed else 0
            inserted += 0 if existed else 1
        return {"inserted": inserted, "updated": updated, "reactivated": 0, "deactivated": 0}

    # --- the to-do list ---------------------------------------------------------------

    def _pending_symbols(self, conn: sqlite3.Connection) -> list[str]:
        """Active Racional equities that the scanner already screened (optionally capped)."""
        sql = (
            "SELECT DISTINCT o.normalized_symbol FROM stocks_origin o "
            "JOIN stock_screen_snapshot s ON s.symbol = o.normalized_symbol "
            "WHERE o.source_code = 'racional_gsheet' AND o.is_active = 1 "
            "AND o.asset_type = 'EQUITY' ORDER BY o.normalized_symbol"
        )
        params: list[Any] = []
        if self.limit:
            sql += " LIMIT ?"
            params.append(int(self.limit))
        return [row[0] for row in conn.execute(sql, params).fetchall()]


__all__ = ["PriceRiskSource", "RiskRecord", "yfinance_closes", "BENCHMARK_SYMBOL"]
