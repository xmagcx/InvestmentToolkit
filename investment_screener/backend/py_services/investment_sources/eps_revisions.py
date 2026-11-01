#!/usr/bin/env python3
"""eps_revisions.py — fill stock_eps_revisions with the analysts' current-year revisions (S11/S14).

Purpose:
    Step 5 of the opportunities funnel also asks whether the analysts are cutting their
    earnings estimates. yfinance publishes that per symbol as a small table (one row per
    period, columns upLast7days / upLast30days / downLast7days / downLast30days); this source
    reads the current-year row ('0y', falling back to the current quarter '0q' and recording
    which one it used) for every symbol that passes step 4 on the latest scanner snapshot —
    the ones that actually fell — and replaces their ``stock_eps_revisions`` row.

    Step 4 is not re-implemented here: the to-do list asks ``opportunity_screener`` itself
    (rule 19), so "cayó y está bajo su promedio de 200 días" has exactly one definition.

    It is an ``InvestmentSource`` like any other. Two rules it never breaks: one lookup per
    symbol with at least half a second between them (yfinance is unofficial), and a symbol
    whose lookup raises or whose table has no usable row is reported in ``rejected`` instead
    of being stored as zero revisions.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    python3 sync_cli.py --source eps_revisions
    EpsRevisionsSource(limit=50).sync(conn, trigger="manual")

Key Classes / Functions (Index):
    - RevisionRecord: frozen DTO with one symbol's revisions (or why there are none)
    - yfinance_revisions(symbol): the default lookup (get_eps_revisions / .eps_revisions)
    - EpsRevisionsSource: fetch/normalize/validate/upsert for the revisions pass

Key Input Dependencies:
    - stock_screen_snapshot + stocks_origin, read through opportunity_screener (step 4)
    - yfinance (only when no provider is injected; tests always inject one)

Key Output Dependencies:
    - stock_eps_revisions rows (migration 0016)
    - source_sync_run rows under source_code 'eps_revisions'
"""
from __future__ import annotations

import math
import re
import sqlite3
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Sequence

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import opportunity_screener as screener  # noqa: E402

from .base import (  # noqa: E402
    InvestmentSource,
    SourceError,
    SyncResult,
    log_event,
    utc_now,
)

#: Politeness: never two yfinance lookups closer than this.
MIN_INTERVAL_SECONDS = 0.5
#: The row to read, in order of preference: the current year, then the current quarter (S11).
PERIOD_PREFERENCE = ("0y", "0q")
#: Normalised column name -> stored column (yfinance has shipped several spellings).
REVISION_COLUMNS = {
    "uplast7days": "up_7d", "uplast30days": "up_30d",
    "downlast7days": "down_7d", "downlast30days": "down_30d",
}
REVISION_DB_COLUMNS = ("symbol", "up_7d", "down_7d", "up_30d", "down_30d", "period", "fetched_at")


@dataclass(frozen=True)
class RevisionRecord:
    """One symbol's analyst revisions for a period, or the reason there are none."""

    symbol: str
    period: str | None = None
    up_7d: int | None = None
    up_30d: int | None = None
    down_7d: int | None = None
    down_30d: int | None = None
    reason: str | None = None


def yfinance_revisions(symbol: str) -> Any:
    """Return the symbol's EPS-revisions table (the default lookup; tests inject their own)."""
    import yfinance as yf  # local import: tests never reach this, so yfinance stays optional

    ticker = yf.Ticker(symbol)
    getter = getattr(ticker, "get_eps_revisions", None)
    return getter() if callable(getter) else getattr(ticker, "eps_revisions", None)


class EpsRevisionsSource(InvestmentSource):
    """Current-year analyst revisions of every symbol that passed step 4 of the screener."""

    source_code = "eps_revisions"
    display_name = "yfinance – revisiones de analistas"

    def __init__(
        self,
        *,
        provider: Callable[[str], Any] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        min_interval: float = MIN_INTERVAL_SECONDS,
        limit: int | None = None,
    ) -> None:
        self.provider = provider or yfinance_revisions
        self.sleep = sleep
        self.min_interval = min_interval
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

    def fetch(self) -> list[dict]:
        """Look every fallen symbol up sequentially; a failing symbol is recorded, not raised."""
        conn = self._conn
        if conn is None:  # pragma: no cover — sync() always sets it before the base calls fetch()
            raise SourceError("fetch() needs the connection stashed by sync()")
        symbols = self._pending_symbols(conn)
        if not symbols:
            raise SourceError("no symbols passed step 4 on the latest snapshot")
        payloads: list[dict] = []
        for position, symbol in enumerate(symbols):
            if position:
                self.sleep(self.min_interval)
            try:
                payloads.append({"symbol": symbol, "table": self.provider(symbol)})
            except Exception as exc:  # noqa: BLE001 — one bad symbol must not lose the batch
                log_event("eps_revisions_lookup_failed", symbol=symbol, error=str(exc))
                payloads.append({"symbol": symbol, "table": None, "error": str(exc)})
        return payloads

    def normalize(self, raw: Sequence[dict]) -> list[RevisionRecord]:
        """Turn each lookup into a DTO holding the current-year (or quarter) revisions."""
        return [self._record(payload) for payload in raw]

    def _record(self, payload: dict) -> RevisionRecord:
        """One DTO: the preferred period's row, or the reason the lookup produced nothing."""
        symbol = payload["symbol"]
        if payload.get("error"):
            return RevisionRecord(symbol, reason=f"lookup_failed: {payload['error']}")
        row, period = _preferred_row(payload.get("table"))
        if row is None:
            return RevisionRecord(symbol, reason="no_current_period_row")
        values = {column: _count(row.get(key)) for key, column in REVISION_COLUMNS.items()}
        if all(value is None for value in values.values()):
            return RevisionRecord(symbol, period=period, reason="no_revision_columns")
        return RevisionRecord(symbol, period=period, **values)

    def validate(self, items: Sequence[RevisionRecord]) -> tuple[list[RevisionRecord], list[dict]]:
        """Keep the symbols with a usable row; report the rest with their reason."""
        valid = [item for item in items if item.reason is None]
        rejected = [{"symbol": item.symbol, "reason": item.reason}
                    for item in items if item.reason is not None]
        return valid, rejected

    def upsert(self, items: Sequence[RevisionRecord], conn: sqlite3.Connection) -> dict:
        """Replace the revisions row of every symbol read in this pass."""
        now = utc_now()
        inserted = 0
        updated = 0
        for item in items:
            existed = conn.execute(
                "SELECT 1 FROM stock_eps_revisions WHERE symbol = ?", (item.symbol,)
            ).fetchone() is not None
            conn.execute(
                f"INSERT OR REPLACE INTO stock_eps_revisions ({', '.join(REVISION_DB_COLUMNS)}) "
                f"VALUES ({', '.join('?' for _ in REVISION_DB_COLUMNS)})",
                [item.symbol, item.up_7d, item.down_7d, item.up_30d, item.down_30d,
                 item.period, now],
            )
            updated += 1 if existed else 0
            inserted += 0 if existed else 1
        return {"inserted": inserted, "updated": updated, "reactivated": 0, "deactivated": 0}

    # --- the to-do list ---------------------------------------------------------------

    def _pending_symbols(self, conn: sqlite3.Connection) -> list[str]:
        """The screened symbols that answer step 4 ("¿Cayó por causas externas?") today.

        The rule itself is never restated here: the snapshot rows are judged by
        ``opportunity_screener``'s own step-4 items with the engine's default thresholds.
        """
        symbols = screener.fallen_symbols(conn)
        return symbols[: self.limit] if self.limit else symbols


def _preferred_row(table: Any) -> tuple[dict | None, str | None]:
    """The '0y' row of the revisions table (or '0q'), as a plain dict of normalised keys."""
    rows = _rows_by_period(table)
    for period in PERIOD_PREFERENCE:
        if period in rows:
            return rows[period], period
    return None, None


def _rows_by_period(table: Any) -> dict[str, dict]:
    """Accept a DataFrame or a dict-of-rows and return {period: {normalised column: value}}."""
    if table is None:
        return {}
    records: dict[str, dict] = {}
    to_dict = getattr(table, "to_dict", None)
    if callable(to_dict):
        try:
            raw = to_dict("index")
        except TypeError:
            raw = to_dict()
    else:
        raw = table
    if not isinstance(raw, dict):
        return {}
    for period, values in raw.items():
        if isinstance(values, dict):
            records[str(period).strip()] = {_key(name): value for name, value in values.items()}
    return records


def _key(name: Any) -> str:
    """Normalise a column name so naming variants collapse ('upLast7Days' -> 'uplast7days')."""
    return re.sub(r"[^a-z0-9]", "", str(name).lower())


def _count(value: Any) -> int | None:
    """A revision count as an integer; anything unusable (NaN, text, None) is missing."""
    if value is None or isinstance(value, bool):
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return int(number)


__all__ = ["EpsRevisionsSource", "RevisionRecord", "yfinance_revisions", "PERIOD_PREFERENCE"]
