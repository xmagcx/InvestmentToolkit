-- 0012_universe_candidate: own the branch-built candidate pool in the schema, idempotently.
--
-- `universe_candidate` is the curated pool of potential investments kept apart from
-- investment/watchlist thesis state (ADR-039, formerly ADR-032 on the opportunity-screener
-- branch): one row per ticker, upserted by ingest and read by the maintainer UI.
--
-- That branch created the table by hand in `db_client.py` while it pre-dated the migrator, so
-- databases opened there already contain it. IF NOT EXISTS makes this migration a no-op over
-- such a file: the adopter keeps the existing rows only when their shape matches this DDL
-- exactly, and refuses otherwise. A database that has never seen the branch gets the table here.
--
-- When the opportunity-screener branch merges, delete its `CREATE TABLE IF NOT EXISTS
-- universe_candidate` block from `db_client.py`; this file is the only owner from then on.

CREATE TABLE IF NOT EXISTS universe_candidate (
    ticker      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    source      TEXT NOT NULL,
    asset_class TEXT,
    added_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
