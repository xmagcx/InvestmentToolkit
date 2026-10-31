#!/usr/bin/env python3
"""fred_aaa.py — store Moody's AAA corporate-bond yield from FRED (S7).

Purpose:
    Graham's intrinsic value V = EPS x (8.5 + 2g) x 4.4 / Y needs Y, the current AAA
    corporate-bond yield. FRED publishes that series as a plain CSV with no API key
    (``fredgraph.csv?id=AAA``), so this source downloads it, keeps the latest observation
    that actually carries a number (FRED pads the tail of a monthly series with '.') and
    upserts the single ``market_rate`` row the screening engine reads.

    It is an ``InvestmentSource`` like any other: same CLI, same ``source_sync_run`` ledger,
    same scheduler. One row in, one row out; a failed download writes nothing.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    python3 sync_cli.py --source fred_aaa
    FredAaaSource().sync(conn, trigger="manual")

Key Classes / Functions (Index):
    - FRED_AAA_URL / SERIES_ID: the CSV endpoint and the market_rate key it writes
    - RateRecord: frozen DTO with one observation (value + observation date)
    - FredAaaSource: fetch/normalize/validate/upsert for the AAA yield

Key Input Dependencies:
    - https://fred.stlouisfed.org/graph/fredgraph.csv?id=AAA (no API key)
    - requests (only when no fetcher is injected; tests always inject one)

Key Output Dependencies:
    - market_rate row series_id 'AAA' (migration 0015)
    - source_sync_run rows under source_code 'fred_aaa'
"""
from __future__ import annotations

import csv
import io
import sqlite3
from dataclasses import dataclass
from typing import Any, Sequence

from .base import HttpFetcher, InvestmentSource, utc_now

FRED_AAA_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=AAA"
SERIES_ID = "AAA"
#: FRED is a public government service, but one request per sync is still spaced like the rest.
MIN_INTERVAL_SECONDS = 1.0


@dataclass(frozen=True)
class RateRecord:
    """One published observation of a FRED series, already parsed."""

    series_id: str
    value: float
    observed_at: str


class FredAaaSource(InvestmentSource):
    """The AAA corporate-bond yield behind Graham's Y, refreshed from FRED's CSV export."""

    source_code = "fred_aaa"
    display_name = "FRED – rendimiento bonos AAA"

    def __init__(self, *, fetcher: Any = None, url: str = FRED_AAA_URL) -> None:
        self.fetcher = fetcher or HttpFetcher(min_interval=MIN_INTERVAL_SECONDS)
        self.url = url

    def fetch(self) -> str:
        """Download the series CSV exactly as FRED publishes it."""
        return self.fetcher.get_text(self.url)

    def normalize(self, raw: str) -> list[RateRecord]:
        """Return the latest observation that carries a number (ignoring FRED's '.' padding)."""
        latest: RateRecord | None = None
        for row in csv.DictReader(io.StringIO(raw)):
            date = (row.get("observation_date") or row.get("DATE") or "").strip()
            value = _number(row.get(SERIES_ID))
            if date and value is not None:
                latest = RateRecord(SERIES_ID, value, date)
        return [latest] if latest else []

    def validate(self, items: Sequence[RateRecord]) -> tuple[list[RateRecord], list[dict]]:
        """A yield must be a positive number; anything else is rejected (and the sync fails)."""
        valid = [item for item in items if item.value > 0]
        rejected = [{"symbol": item.series_id, "reason": "non_positive_yield"}
                    for item in items if item.value <= 0]
        return valid, rejected

    def upsert(self, items: Sequence[RateRecord], conn: sqlite3.Connection) -> dict:
        """Insert or update the one market_rate row of this series."""
        now = utc_now()
        inserted = 0
        updated = 0
        for item in items:
            existed = conn.execute(
                "SELECT 1 FROM market_rate WHERE series_id = ?", (item.series_id,)
            ).fetchone() is not None
            conn.execute(
                "INSERT OR REPLACE INTO market_rate (series_id, value, observed_at, fetched_at) "
                "VALUES (?, ?, ?, ?)",
                (item.series_id, item.value, item.observed_at, now),
            )
            updated += 1 if existed else 0
            inserted += 0 if existed else 1
        return {"inserted": inserted, "updated": updated, "reactivated": 0, "deactivated": 0}


def _number(text: str | None) -> float | None:
    """Parse a FRED cell; its '.' placeholder (and anything unparseable) means "no observation"."""
    try:
        return float((text or "").strip())
    except ValueError:
        return None
