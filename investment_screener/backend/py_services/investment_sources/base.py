#!/usr/bin/env python3
"""base.py — the investment-source framework: DTOs, HTTP fetching and the sync contract.

Purpose:
    One shape for every external catalogue of investable instruments (Racional's Google
    Sheet today, Dataroma next). A connector subclasses ``InvestmentSource`` (or
    ``StocksOriginSource`` when it writes ``stocks_origin``) and implements fetch /
    normalize / validate / upsert; ``sync()`` owns the parts no connector should
    reinvent: the in-flight lock, the ``source_sync_run`` ledger row, one transaction
    around the writes, metrics and structured JSON logging to stderr.

    Connectors return typed DTOs (``StockRecord``), never DataFrames (S1), and a failed
    fetch or an empty batch writes nothing and deactivates nothing (S2).

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    from investment_sources.google_sheet_stocks import GoogleSheetStocksSource
    result = GoogleSheetStocksSource().sync(conn, trigger="manual")
    print(result.to_dict())

Key Classes / Functions (Index):
    - SourceError / FetchError: connector failures (FetchError = network/HTTP exhausted)
    - StockRecord: frozen DTO for one instrument, with content_hash()
    - SyncResult: metrics of one sync run, with to_dict()
    - HttpFetcher: requests GET with timeout, 3 attempts, exponential backoff, min interval
    - InvestmentSource: abstract source contract (fetch/normalize/validate/upsert/sync)
    - StocksOriginUpsert: the reusable stocks_origin insert/update/reactivate/deactivate
    - StocksOriginSource: InvestmentSource whose upsert() writes stocks_origin
    - utc_now(): the timestamp format every column in these tables uses

Key Input Dependencies:
    - domain_model.sqlite tables stocks_origin and source_sync_run (migration 0013)
    - requests (only when no session/fetcher is injected)

Key Output Dependencies:
    - stocks_origin, source_sync_run rows; JSON log lines on stderr
"""
from __future__ import annotations

import hashlib
import json
import logging
import sqlite3
import time
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Iterable, Sequence

USER_AGENT = "InvestmentToolkit-screener/1.0 (informational research)"
HTTP_TIMEOUT_SECONDS = 15.0
MAX_ATTEMPTS = 3
#: A 'running' run row older than this is stale (crashed process) and no longer blocks a sync.
RUNNING_LOCK_MINUTES = 15
#: How many rejected rows are kept in source_sync_run.details (the ledger is not a dump).
REJECTED_SAMPLE_SIZE = 20

_LOGGER = logging.getLogger("investment_sources")


class SourceError(RuntimeError):
    """A source could not produce a usable batch; the sync fails without writing."""


class FetchError(SourceError):
    """The remote document could not be retrieved (timeout, HTTP error, retries exhausted)."""


def utc_now() -> str:
    """Return the UTC timestamp string stored in every stocks_origin/source_sync_run column."""
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def log_event(event: str, **fields: Any) -> None:
    """Emit one structured JSON log line (stderr via logging; stdout stays machine-readable)."""
    _LOGGER.info(json.dumps({"event": event, **fields}, default=str, ensure_ascii=False))


# Frozen DTO: connectors hand these to the upsert, nothing else crosses the boundary.
@dataclass(frozen=True)
class StockRecord:
    """One instrument as a source publishes it, already normalized for stocks_origin."""

    source_code: str
    symbol: str
    normalized_symbol: str
    exchange: str = ""
    external_id: str | None = None
    company_name: str | None = None
    asset_type: str | None = None
    currency: str | None = None
    country: str | None = None
    sector: str | None = None
    industry: str | None = None
    source_created_at: str | None = None
    source_updated_at: str | None = None
    source_metadata: dict = field(default_factory=dict)

    def content_hash(self) -> str:
        """Hash of the fields a sync may change, so an unchanged row is not rewritten."""
        payload = [
            self.symbol, self.normalized_symbol, self.exchange, self.external_id or "",
            self.company_name or "", self.asset_type or "", self.currency or "",
            self.country or "", self.sector or "", self.industry or "",
            json.dumps(self.source_metadata, sort_keys=True, ensure_ascii=False),
        ]
        return hashlib.sha256("\x1f".join(payload).encode("utf-8")).hexdigest()


# Returned by sync() and printed verbatim by the CLI / HTTP route.
@dataclass
class SyncResult:
    """Outcome and metrics of one sync attempt."""

    source_code: str
    status: str
    fetched: int = 0
    inserted: int = 0
    updated: int = 0
    reactivated: int = 0
    deactivated: int = 0
    rejected: int = 0
    duration_ms: int = 0
    error: str | None = None
    run_id: int | None = None

    def to_dict(self) -> dict:
        """JSON-serialisable view (the CLI prints exactly this object)."""
        return {
            "source_code": self.source_code,
            "status": self.status,
            "fetched": self.fetched,
            "inserted": self.inserted,
            "updated": self.updated,
            "reactivated": self.reactivated,
            "deactivated": self.deactivated,
            "rejected": self.rejected,
            "duration_ms": self.duration_ms,
            "error": self.error,
            "run_id": self.run_id,
        }


# Polite HTTP: identifiable agent, bounded retries, optional spacing between requests (S11).
class HttpFetcher:
    """GET a text document with a timeout, bounded retries and an optional min interval."""

    def __init__(
        self,
        *,
        timeout: float = HTTP_TIMEOUT_SECONDS,
        max_attempts: int = MAX_ATTEMPTS,
        backoff_base: float = 1.0,
        min_interval: float = 0.0,
        session: Any = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.timeout = timeout
        self.max_attempts = max_attempts
        self.backoff_base = backoff_base
        self.min_interval = min_interval
        self.sleep = sleep
        self.clock = clock
        self._session = session
        self._last_request_at: float | None = None

    def _get_session(self) -> Any:
        """Lazily build a requests session so injected sessions need no requests install."""
        if self._session is None:
            import requests  # local import: tests inject a session and never touch the network

            self._session = requests.Session()
        return self._session

    def _respect_min_interval(self) -> None:
        """Sleep so consecutive requests are at least ``min_interval`` seconds apart."""
        if self.min_interval <= 0 or self._last_request_at is None:
            return
        waited = self.clock() - self._last_request_at
        if waited < self.min_interval:
            self.sleep(self.min_interval - waited)

    def get_text(self, url: str) -> str:
        """Return the response body, retrying with exponential backoff; raise FetchError if exhausted."""
        last_error: Exception | None = None
        for attempt in range(1, self.max_attempts + 1):
            self._respect_min_interval()
            self._last_request_at = self.clock()
            try:
                response = self._get_session().get(
                    url, timeout=self.timeout, headers={"User-Agent": USER_AGENT}
                )
                response.raise_for_status()
                return response.text
            except Exception as exc:  # noqa: BLE001 — any transport/HTTP error is retryable
                last_error = exc
                log_event("http_attempt_failed", url=url, attempt=attempt, error=str(exc))
                if attempt < self.max_attempts:
                    self.sleep(self.backoff_base * (2 ** (attempt - 1)))
        raise FetchError(f"GET {url} failed after {self.max_attempts} attempts: {last_error}")


class InvestmentSource(ABC):
    """Contract every external investment catalogue implements; ``sync()`` is shared."""

    source_code: str = ""
    display_name: str = ""

    @abstractmethod
    def fetch(self) -> Any:
        """Return the raw payload (text, HTML, JSON) exactly as the source published it."""

    @abstractmethod
    def normalize(self, raw: Any) -> list:
        """Turn the raw payload into typed DTOs (one per row the source published)."""

    @abstractmethod
    def validate(self, items: Sequence) -> tuple[list, list[dict]]:
        """Split DTOs into (valid, rejected); rejected entries carry a reason."""

    @abstractmethod
    def upsert(self, items: Sequence, conn: sqlite3.Connection) -> dict:
        """Write the valid DTOs; return inserted/updated/reactivated/deactivated counts."""

    def sync(self, conn: sqlite3.Connection, trigger: str = "cli") -> SyncResult:
        """Run one full sync: lock, ledger row, fetch/normalize/validate, one transaction, metrics."""
        started = time.monotonic()
        if _running_run_id(conn, self.source_code) is not None:
            log_event("sync_refused", source=self.source_code, reason="already running")
            return SyncResult(self.source_code, "failed", error="sync already running")

        run_id = _start_run(conn, self.source_code, trigger)
        log_event("sync_started", source=self.source_code, trigger=trigger, run_id=run_id)
        rejected: list[dict] = []
        fetched = 0
        try:
            items = self.normalize(self.fetch())
            fetched = len(items)
            valid, rejected = self.validate(items)
            if not valid:
                raise SourceError("no valid rows in the fetched batch")
            counts = self._upsert_in_transaction(valid, conn)
        except Exception as exc:  # noqa: BLE001 — every failure is reported, none is written
            return self._fail_run(conn, run_id, started, fetched, rejected, exc)

        result = SyncResult(
            self.source_code, "success", fetched=fetched, rejected=len(rejected),
            duration_ms=_elapsed_ms(started), run_id=run_id, **counts,
        )
        _finish_run(conn, run_id, result, rejected)
        log_event("sync_finished", **result.to_dict())
        return result

    def _upsert_in_transaction(self, items: Sequence, conn: sqlite3.Connection) -> dict:
        """Apply every write of this sync inside a single BEGIN IMMEDIATE transaction."""
        previous_isolation = conn.isolation_level
        conn.isolation_level = None
        try:
            conn.execute("BEGIN IMMEDIATE")
            try:
                counts = self.upsert(items, conn)
                conn.execute("COMMIT")
            except Exception:
                conn.execute("ROLLBACK")
                raise
        finally:
            conn.isolation_level = previous_isolation
        return counts

    def _fail_run(
        self,
        conn: sqlite3.Connection,
        run_id: int,
        started: float,
        fetched: int,
        rejected: list[dict],
        exc: Exception,
    ) -> SyncResult:
        """Close the ledger row as failed and return the matching SyncResult (nothing written)."""
        result = SyncResult(
            self.source_code, "failed", fetched=fetched, rejected=len(rejected),
            duration_ms=_elapsed_ms(started), error=str(exc), run_id=run_id,
        )
        _finish_run(conn, run_id, result, rejected)
        log_event("sync_failed", **result.to_dict())
        return result


# --- source_sync_run ledger -----------------------------------------------------------


def _elapsed_ms(started: float) -> int:
    """Milliseconds since a time.monotonic() mark."""
    return int((time.monotonic() - started) * 1000)


def _running_run_id(conn: sqlite3.Connection, source_code: str) -> int | None:
    """Return the id of a fresh 'running' row for this source, or None (stale rows do not lock)."""
    row = conn.execute(
        "SELECT id FROM source_sync_run WHERE source_code = ? AND status = 'running' "
        "AND started_at >= datetime('now', ?) ORDER BY id DESC LIMIT 1",
        (source_code, f"-{RUNNING_LOCK_MINUTES} minutes"),
    ).fetchone()
    return row[0] if row else None


def _start_run(conn: sqlite3.Connection, source_code: str, trigger: str) -> int:
    """Insert and commit the 'running' ledger row that also acts as the in-flight lock."""
    cursor = conn.execute(
        "INSERT INTO source_sync_run (source_code, trigger, started_at, status) VALUES (?, ?, ?, 'running')",
        (source_code, trigger, utc_now()),
    )
    conn.commit()
    return int(cursor.lastrowid)


def _finish_run(
    conn: sqlite3.Connection, run_id: int, result: SyncResult, rejected: Iterable[dict]
) -> None:
    """Close a ledger row with the run's status, metrics and a sample of the rejected rows."""
    details = json.dumps({"rejected_sample": list(rejected)[:REJECTED_SAMPLE_SIZE]}, ensure_ascii=False)
    conn.execute(
        "UPDATE source_sync_run SET finished_at = ?, status = ?, fetched = ?, inserted = ?, "
        "updated = ?, reactivated = ?, deactivated = ?, rejected = ?, duration_ms = ?, "
        "error_message = ?, details = ? WHERE id = ?",
        (
            utc_now(), result.status, result.fetched, result.inserted, result.updated,
            result.reactivated, result.deactivated, result.rejected, result.duration_ms,
            result.error, details, run_id,
        ),
    )
    conn.commit()


# --- stocks_origin upsert -------------------------------------------------------------

_WRITABLE_COLUMNS = (
    "external_id", "symbol", "normalized_symbol", "exchange", "company_name", "asset_type",
    "currency", "country", "sector", "industry", "source_created_at", "source_updated_at",
)


def _values(item: StockRecord) -> list:
    """The writable column values of a DTO, in _WRITABLE_COLUMNS order."""
    return [getattr(item, column) for column in _WRITABLE_COLUMNS]


class StocksOriginUpsert:
    """The one way rows reach stocks_origin: insert, update, reactivate, never delete."""

    def apply(
        self,
        conn: sqlite3.Connection,
        source_code: str,
        items: Sequence[StockRecord],
        *,
        deactivate_absent: bool = True,
    ) -> dict:
        """Upsert a complete batch and return the insert/update/reactivate/deactivate counts.

        ``deactivate_absent`` is only True when the whole fetch succeeded: a partial batch
        must never flip rows it simply did not see to is_active = 0 (S2).
        """
        now = utc_now()
        counts = {"inserted": 0, "updated": 0, "reactivated": 0, "deactivated": 0}
        seen_ids: list[int] = []
        for item in items:
            row = conn.execute(
                "SELECT id, content_hash, is_active FROM stocks_origin "
                "WHERE source_code = ? AND normalized_symbol = ? AND exchange = ?",
                (source_code, item.normalized_symbol, item.exchange),
            ).fetchone()
            if row is None:
                seen_ids.append(self._insert(conn, source_code, item, now))
                counts["inserted"] += 1
                continue
            row_id, old_hash, is_active = row
            seen_ids.append(row_id)
            new_hash = item.content_hash()
            if not is_active:
                self._update(conn, row_id, item, now, new_hash)
                counts["reactivated"] += 1
            elif old_hash != new_hash:
                self._update(conn, row_id, item, now, new_hash)
                counts["updated"] += 1
            else:
                self._touch(conn, row_id, now)
        if deactivate_absent:
            counts["deactivated"] = self._deactivate_absent(conn, source_code, seen_ids, now)
        return counts

    def _insert(self, conn: sqlite3.Connection, source_code: str, item: StockRecord, now: str) -> int:
        """Insert a brand-new instrument row and return its id."""
        columns = ", ".join(_WRITABLE_COLUMNS)
        placeholders = ", ".join("?" for _ in _WRITABLE_COLUMNS)
        cursor = conn.execute(
            f"INSERT INTO stocks_origin (source_code, {columns}, source_metadata, is_active, "
            "first_seen_at, last_seen_at, last_synced_at, content_hash, created_at, updated_at) "
            f"VALUES (?, {placeholders}, ?, 1, ?, ?, ?, ?, ?, ?)",
            [source_code, *_values(item), _metadata_json(item), now, now, now, item.content_hash(), now, now],
        )
        return int(cursor.lastrowid)

    def _update(
        self,
        conn: sqlite3.Connection,
        row_id: int,
        item: StockRecord,
        now: str,
        content_hash: str,
    ) -> None:
        """Rewrite a changed (or returning) row; a row present in the batch is always active."""
        assignments = ", ".join(f"{column} = ?" for column in _WRITABLE_COLUMNS)
        conn.execute(
            f"UPDATE stocks_origin SET {assignments}, source_metadata = ?, content_hash = ?, "
            "is_active = 1, last_seen_at = ?, last_synced_at = ?, updated_at = ? WHERE id = ?",
            [*_values(item), _metadata_json(item), content_hash, now, now, now, row_id],
        )

    def _touch(self, conn: sqlite3.Connection, row_id: int, now: str) -> None:
        """Record that an unchanged row was seen again in this sync."""
        conn.execute(
            "UPDATE stocks_origin SET last_seen_at = ?, last_synced_at = ?, updated_at = ? WHERE id = ?",
            (now, now, now, row_id),
        )

    def _deactivate_absent(
        self, conn: sqlite3.Connection, source_code: str, seen_ids: Sequence[int], now: str
    ) -> int:
        """Flip this source's active rows that the complete batch did not contain to is_active = 0."""
        placeholders = ", ".join("?" for _ in seen_ids)
        cursor = conn.execute(
            "UPDATE stocks_origin SET is_active = 0, updated_at = ? "
            f"WHERE source_code = ? AND is_active = 1 AND id NOT IN ({placeholders or 'SELECT NULL'})",
            [now, source_code, *seen_ids],
        )
        return cursor.rowcount


def _metadata_json(item: StockRecord) -> str:
    """Serialise a DTO's source_metadata for the stocks_origin JSON column."""
    return json.dumps(item.source_metadata, sort_keys=True, ensure_ascii=False)


class StocksOriginSource(InvestmentSource):
    """An InvestmentSource whose instruments land in stocks_origin (Racional, Dataroma, ...)."""

    upserter = StocksOriginUpsert()

    def upsert(self, items: Sequence[StockRecord], conn: sqlite3.Connection) -> dict:
        """Delegate to the shared stocks_origin upsert (reached only after a complete fetch)."""
        return self.upserter.apply(conn, self.source_code, items)
