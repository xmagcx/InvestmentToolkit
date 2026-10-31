-- 0013_investment_sources: add stocks_origin and source_sync_run so external investment
-- sources (Racional Google Sheet first, Dataroma later) can be synced into the domain model.
--
-- `stocks_origin` is the raw, per-source catalogue of investable instruments: one row per
-- (source, instrument). It is an append/upsert table — the sync never DELETEs. Instruments
-- that disappear from a source are flipped to is_active = 0 so history and foreign readers
-- survive, and they are reactivated if the source lists them again.
--
-- `exchange` is NOT NULL DEFAULT '' on purpose: it is part of the uniqueness key, and SQLite
-- treats NULLs as distinct inside a UNIQUE index, so a nullable exchange would let the same
-- instrument be inserted over and over. The empty string collides as intended for sources
-- (like the Racional sheet) that do not publish an exchange.
--
-- `enriched_at` / `enrichment_status` are written later by the yfinance enrichment task
-- (S10); the connectors added here leave them NULL.
--
-- `source_sync_run` is the run ledger behind the UI's Sync button: one row per attempt, with
-- the metrics the connectors report and a JSON `details` blob (e.g. a sample of rejected rows).
-- A row left in status 'running' is also the in-flight lock a second sync of the same source
-- checks before it starts.

CREATE TABLE IF NOT EXISTS stocks_origin (
    id                INTEGER PRIMARY KEY,
    source_code       TEXT    NOT NULL,
    external_id       TEXT,
    symbol            TEXT    NOT NULL,
    normalized_symbol TEXT    NOT NULL,
    exchange          TEXT    NOT NULL DEFAULT '',
    company_name      TEXT,
    asset_type        TEXT,
    currency          TEXT,
    country           TEXT,
    sector            TEXT,
    industry          TEXT,
    is_active         INTEGER NOT NULL DEFAULT 1,
    source_metadata   TEXT,
    source_created_at TEXT,
    source_updated_at TEXT,
    first_seen_at     TEXT,
    last_seen_at      TEXT,
    last_synced_at    TEXT,
    content_hash      TEXT,
    enriched_at       TEXT,
    enrichment_status TEXT,
    created_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at        TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (source_code, normalized_symbol, exchange)
);

CREATE INDEX IF NOT EXISTS idx_stocks_origin_normalized_symbol
    ON stocks_origin (normalized_symbol);

CREATE INDEX IF NOT EXISTS idx_stocks_origin_source_active
    ON stocks_origin (source_code, is_active);

CREATE TABLE IF NOT EXISTS source_sync_run (
    id            INTEGER PRIMARY KEY,
    source_code   TEXT    NOT NULL,
    trigger       TEXT    NOT NULL DEFAULT 'cli' CHECK (trigger IN ('manual', 'scheduled', 'cli')),
    started_at    TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
    finished_at   TEXT,
    status        TEXT    NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'success', 'failed')),
    fetched       INTEGER NOT NULL DEFAULT 0,
    inserted      INTEGER NOT NULL DEFAULT 0,
    updated       INTEGER NOT NULL DEFAULT 0,
    reactivated   INTEGER NOT NULL DEFAULT 0,
    deactivated   INTEGER NOT NULL DEFAULT 0,
    rejected      INTEGER NOT NULL DEFAULT 0,
    duration_ms   INTEGER,
    error_message TEXT,
    details       TEXT
);

CREATE INDEX IF NOT EXISTS idx_source_sync_run_source_started
    ON source_sync_run (source_code, started_at);
