#!/usr/bin/env python3
"""yfinance_enrichment.py — fill sector/industry/country/currency of stocks_origin from yfinance (S10).

Purpose:
    Racional's sheet publishes only symbol, name and type, so every ``stocks_origin`` row
    starts without a sector. This source walks the catalogue incrementally (``YF_ENRICH_BATCH``
    symbols per run, >= 1 s between lookups) and writes back what yfinance knows about each
    instrument. It is an ``InvestmentSource`` like any other, so the CLI, the ``source_sync_run``
    ledger, the Express sync route and the scheduler treat it exactly like the connectors.

    Two rules it never breaks: a non-empty stored value is never replaced by an empty one, and
    the ``exchange`` column (part of the stocks_origin uniqueness key) is never rewritten — the
    yfinance exchange code and its TradingView prefix land in ``source_metadata`` instead.

    Unlike a catalogue connector it writes no new rows, deactivates nothing, and a symbol whose
    lookup raises is recorded as ``enrichment_status = 'error'`` without aborting the batch.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    python3 sync_cli.py --source yfinance_enrichment
    YFinanceProfileEnrichment(limit=5).sync(conn, trigger="manual")

Key Classes / Functions (Index):
    - ProfileRecord: frozen DTO with one symbol's yfinance profile and its status
    - YFinanceProfileEnrichment: fetch/normalize/validate/upsert for the enrichment pass
    - TV_EXCHANGE_BY_YF_CODE: yfinance exchange code -> TradingView prefix
    - yfinance_info(symbol): the default lookup (yf.Ticker(symbol).info)

Key Input Dependencies:
    - env YF_ENRICH_BATCH (symbols per run, default 150)
    - stocks_origin rows (is_active = 1) and their enriched_at / enrichment_status
    - yfinance (only when no info_provider is injected; tests always inject one)

Key Output Dependencies:
    - stocks_origin sector/industry/country/currency/enriched_at/enrichment_status/source_metadata
    - source_sync_run rows under source_code 'yfinance_enrichment'
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Sequence

from .base import (
    InvestmentSource,
    SourceError,
    SyncResult,
    _elapsed_ms,
    _finish_run,
    _running_run_id,
    _start_run,
    log_event,
    utc_now,
)

DEFAULT_BATCH_LIMIT = 150
#: yfinance is unofficial: one sequential lookup per second, like the rest of the scraping (S11).
MIN_INTERVAL_SECONDS = 1.0
#: A row enriched longer ago than this is refreshed; a failed one is retried after a day.
STALE_AFTER_DAYS = 90
ERROR_RETRY_HOURS = 24
#: yfinance exchange code -> TradingView symbol prefix. NYSE Arca ETFs are 'AMEX' on TradingView.
TV_EXCHANGE_BY_YF_CODE = {
    "NMS": "NASDAQ", "NGM": "NASDAQ", "NCM": "NASDAQ", "NASDAQ": "NASDAQ",
    "NYQ": "NYSE", "NYSE": "NYSE",
    "ASE": "AMEX", "AMEX": "AMEX", "PCX": "AMEX", "NYSEARCA": "AMEX",
    "BTS": "CBOE", "BATS": "CBOE",
}
#: Columns filled from the profile, and only when the fetched value is non-empty (S10).
PROFILE_COLUMNS = ("sector", "industry", "country", "currency")
VALID_STATUSES = ("ok", "no_data", "error")


@dataclass(frozen=True)
class ProfileRecord:
    """One symbol's yfinance profile, already reduced to what stocks_origin stores."""

    normalized_symbol: str
    sector: str | None = None
    industry: str | None = None
    country: str | None = None
    currency: str | None = None
    exchange: str | None = None
    quote_type: str | None = None
    status: str = "ok"
    error: str | None = None


def yfinance_info(symbol: str) -> dict:
    """Return ``yf.Ticker(symbol).info`` (the default lookup; tests inject their own)."""
    import yfinance as yf  # local import: tests never reach this, so yfinance stays optional here

    return yf.Ticker(symbol).info or {}


class YFinanceProfileEnrichment(InvestmentSource):
    """Incremental sector/industry/country/currency enrichment of stocks_origin from yfinance."""

    source_code = "yfinance_enrichment"
    display_name = "yfinance – sector/industry enrichment"

    def __init__(
        self,
        *,
        info_provider: Callable[[str], dict] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        limit: int | None = None,
        min_interval: float = MIN_INTERVAL_SECONDS,
    ) -> None:
        self.info_provider = info_provider or yfinance_info
        self.sleep = sleep
        self.limit = limit if limit is not None else _batch_limit_from_env()
        self.min_interval = min_interval
        self._conn: sqlite3.Connection | None = None

    # --- sync: the base contract plus the connection fetch() needs --------------------

    def sync(self, conn: sqlite3.Connection, trigger: str = "cli") -> SyncResult:
        """Stash the connection fetch() reads from, then run the shared sync (or the empty pass).

        The base ``sync()`` calls ``fetch()`` without arguments and fails a batch with no valid
        rows; neither fits an incremental pass whose to-do list comes from the database and is
        legitimately empty once every symbol is fresh. Both are handled here, around the base.
        """
        self._conn = conn
        try:
            if not self._pending_symbols(conn):
                return self._empty_success(conn, trigger)
            return super().sync(conn, trigger)
        finally:
            self._conn = None

    def _empty_success(self, conn: sqlite3.Connection, trigger: str) -> SyncResult:
        """Record a successful no-op run (nothing to enrich) through the shared ledger helpers."""
        started = time.monotonic()
        if _running_run_id(conn, self.source_code) is not None:
            log_event("sync_refused", source=self.source_code, reason="already running")
            return SyncResult(self.source_code, "failed", error="sync already running")
        run_id = _start_run(conn, self.source_code, trigger)
        result = SyncResult(self.source_code, "success", duration_ms=_elapsed_ms(started), run_id=run_id)
        _finish_run(conn, run_id, result, [])
        log_event("sync_finished", **result.to_dict())
        return result

    # --- fetch / normalize / validate / upsert ---------------------------------------

    def fetch(self) -> list[dict]:
        """Look every pending symbol up sequentially; a failing symbol is recorded, not raised."""
        conn = self._conn
        if conn is None:  # pragma: no cover — sync() always sets it before the base calls fetch()
            raise SourceError("fetch() needs the connection stashed by sync()")
        payloads: list[dict] = []
        for position, symbol in enumerate(self._pending_symbols(conn)):
            if position:
                self.sleep(self.min_interval)
            lookup = yfinance_symbol(symbol)
            try:
                payloads.append({"symbol": symbol, "info": dict(self.info_provider(lookup) or {})})
            except Exception as exc:  # noqa: BLE001 — one bad symbol must not lose the batch
                log_event("enrichment_lookup_failed", symbol=symbol, lookup=lookup, error=str(exc))
                payloads.append({"symbol": symbol, "info": None, "error": str(exc)})
        return payloads

    def normalize(self, raw: Sequence[dict]) -> list[ProfileRecord]:
        """Turn each lookup payload into a DTO carrying the profile and its status."""
        return [self._record(payload) for payload in raw]

    def _record(self, payload: dict) -> ProfileRecord:
        """Build one DTO: 'error' when the lookup raised, 'no_data' when yfinance knows no sector."""
        symbol = payload["symbol"]
        if payload.get("info") is None:
            return ProfileRecord(symbol, status="error", error=payload.get("error"))
        info = payload["info"]
        sector = _text(info.get("sector"))
        industry = _text(info.get("industry"))
        return ProfileRecord(
            normalized_symbol=symbol,
            sector=sector,
            industry=industry,
            country=_text(info.get("country")),
            currency=_text(info.get("currency")),
            exchange=_text(info.get("exchange")),
            quote_type=_text(info.get("quoteType")),
            status="ok" if (sector or industry) else "no_data",
        )

    def validate(self, items: Sequence[ProfileRecord]) -> tuple[list[ProfileRecord], list[dict]]:
        """Keep every DTO; only a malformed one (no symbol, unknown status) is rejected."""
        valid: list[ProfileRecord] = []
        rejected: list[dict] = []
        for item in items:
            if not isinstance(item, ProfileRecord) or not item.normalized_symbol:
                rejected.append({"symbol": getattr(item, "normalized_symbol", ""), "reason": "malformed_record"})
            elif item.status not in VALID_STATUSES:
                rejected.append({"symbol": item.normalized_symbol, "reason": f"bad_status:{item.status}"})
            else:
                valid.append(item)
        return valid, rejected

    def upsert(self, items: Sequence[ProfileRecord], conn: sqlite3.Connection) -> dict:
        """Update every active row of each symbol, across sources; insert/deactivate nothing."""
        now = utc_now()
        updated = 0
        for item in items:
            rows = conn.execute(
                "SELECT id, source_metadata FROM stocks_origin WHERE normalized_symbol = ? AND is_active = 1",
                (item.normalized_symbol,),
            ).fetchall()
            for row_id, metadata_json in rows:
                assignments, values = _profile_assignments(item)
                assignments += ["enriched_at = ?", "enrichment_status = ?", "source_metadata = ?", "updated_at = ?"]
                values += [now, item.status, _merged_metadata(metadata_json, item), now]
                conn.execute(
                    f"UPDATE stocks_origin SET {', '.join(assignments)} WHERE id = ?", [*values, row_id]
                )
                updated += 1
        return {"inserted": 0, "updated": updated, "reactivated": 0, "deactivated": 0}

    # --- the to-do list ---------------------------------------------------------------

    def _pending_symbols(self, conn: sqlite3.Connection) -> list[str]:
        """Up to ``limit`` active symbols that were never enriched, failed, or went stale; oldest first."""
        rows = conn.execute(
            "SELECT normalized_symbol, MIN(COALESCE(enriched_at, '')) AS oldest FROM stocks_origin "
            "WHERE is_active = 1 AND (enriched_at IS NULL "
            "  OR (enrichment_status = 'error' AND enriched_at < ?) OR enriched_at < ?) "
            "GROUP BY normalized_symbol ORDER BY oldest ASC, normalized_symbol ASC LIMIT ?",
            (_ago(hours=ERROR_RETRY_HOURS), _ago(days=STALE_AFTER_DAYS), self.limit),
        ).fetchall()
        return [row[0] for row in rows]


def yfinance_symbol(symbol: str) -> str:
    """yfinance writes share classes with a dash (BRK.B -> BRK-B); only the lookup is rewritten."""
    head, _, tail = symbol.rpartition(".")
    # shortcut: only 1-letter class suffixes are rewritten, so market suffixes (.TO) survive;
    # revisit when a source publishes non-US multi-letter class tickers.
    if head and len(tail) == 1 and tail.isalpha():
        return f"{head}-{tail}"
    return symbol


def _batch_limit_from_env() -> int:
    """How many symbols one run may look up (env YF_ENRICH_BATCH, default 150)."""
    raw = os.environ.get("YF_ENRICH_BATCH", "").strip()
    return int(raw) if raw.isdigit() and int(raw) > 0 else DEFAULT_BATCH_LIMIT


def _ago(**delta) -> str:
    """A cutoff timestamp in the same format utc_now() stores, so string compares are valid."""
    return (datetime.now(timezone.utc) - timedelta(**delta)).isoformat(timespec="seconds")


def _text(value: Any) -> str | None:
    """yfinance returns '', None or a string; collapse the empty ones to None."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _profile_assignments(item: ProfileRecord) -> tuple[list[str], list]:
    """SET clauses for the profile columns the lookup actually returned (never empty, S10)."""
    assignments: list[str] = []
    values: list = []
    for column in PROFILE_COLUMNS:
        value = getattr(item, column)
        if value:
            assignments.append(f"{column} = ?")
            values.append(value)
    return assignments, values


def _merged_metadata(metadata_json: str | None, item: ProfileRecord) -> str:
    """Merge the yfinance exchange/quote type (and its TradingView prefix) into the stored JSON."""
    try:
        metadata = json.loads(metadata_json) if metadata_json else {}
    except (TypeError, ValueError):
        metadata = {}
    if not isinstance(metadata, dict):
        metadata = {}
    if item.exchange:
        metadata["yf_exchange"] = item.exchange
        tv_exchange = TV_EXCHANGE_BY_YF_CODE.get(item.exchange.upper())
        if tv_exchange:
            metadata["tv_exchange"] = tv_exchange
    if item.quote_type:
        metadata["yf_quote_type"] = item.quote_type
    return json.dumps(metadata, sort_keys=True, ensure_ascii=False)


__all__ = ["YFinanceProfileEnrichment", "ProfileRecord", "TV_EXCHANGE_BY_YF_CODE", "yfinance_symbol"]
