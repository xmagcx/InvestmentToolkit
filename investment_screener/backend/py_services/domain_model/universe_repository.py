"""Read/write operations for the ``universe_candidate`` table.

One-writer-per-table contract: only this module and ``ingest_universe_csv.py``
(via this module) write to ``universe_candidate``. TS-side reads/writes go
through ``UniverseRepository.ts`` against the same physical SQLite file.

Layer: Backend / Python Services / Domain Model
"""

import sqlite3

from ticker_aliases import normalize_ticker


def upsert_universe_candidate(
    conn: sqlite3.Connection,
    ticker: str,
    name: str,
    source: str,
    asset_class: str | None = None,
) -> bool:
    """Insert or update a universe_candidate row. Returns True if inserted, False if skipped (already exists)."""
    normalized = normalize_ticker(ticker)
    conn.execute(
        "INSERT INTO universe_candidate (ticker, name, source, asset_class) "
        "VALUES (?, ?, ?, ?) "
        "ON CONFLICT(ticker) DO UPDATE SET "
        "name=excluded.name, source=excluded.source, asset_class=excluded.asset_class;",
        (normalized, name, source, asset_class),
    )
    conn.commit()
    return True


def list_universe_candidates(conn: sqlite3.Connection) -> list[dict]:
    """Return all universe_candidate rows ordered by added_at DESC."""
    conn.row_factory = sqlite3.Row
    cursor = conn.execute(
        "SELECT ticker, name, source, asset_class, added_at "
        "FROM universe_candidate ORDER BY added_at DESC;"
    )
    return [dict(row) for row in cursor.fetchall()]


def delete_universe_candidate(conn: sqlite3.Connection, ticker: str) -> bool:
    """Delete one universe_candidate by ticker. Returns True if a row was removed."""
    normalized = normalize_ticker(ticker)
    cursor = conn.execute(
        "DELETE FROM universe_candidate WHERE ticker = ?;", (normalized,)
    )
    conn.commit()
    return cursor.rowcount > 0
