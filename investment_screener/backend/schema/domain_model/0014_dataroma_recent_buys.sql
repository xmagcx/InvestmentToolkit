-- 0014_dataroma_recent_buys: add recent_buys_q and recent_buys_insider so the Dataroma
-- connectors (S6, S7) can store superinvestor quarter buys and insider purchases.
--
-- Both tables are insert/update only: a sync never DELETEs and never deactivates. Quarter
-- history therefore accumulates (one row per quarter per instrument) and an insider filing
-- stays readable long after Dataroma drops it from page 1.
--
-- `recent_buys_q` is keyed by (quarter, normalized_symbol): Dataroma publishes one aggregated
-- row per instrument per quarter, and re-running the sync inside the same quarter refreshes
-- the price columns in place.
--
-- `recent_buys_insider` is keyed by the published filing identity
-- (filing_at, normalized_symbol, reporting_name, transaction_date, shares, price) because
-- Dataroma exposes no filing id. Every column of that key is NOT NULL (with DEFAULT '' for
-- transaction_date) since SQLite treats NULLs as distinct inside a UNIQUE index, which would
-- let the same filing be inserted over and over; a row whose shares or price cannot be parsed
-- is rejected by the connector instead of stored with a placeholder.
--
-- `raw_row` keeps the parsed cells of the source row as JSON so a later column change can be
-- diagnosed without re-scraping, and `source_url` records the exact page the row came from.

CREATE TABLE IF NOT EXISTS recent_buys_q (
    id                INTEGER PRIMARY KEY,
    quarter           TEXT    NOT NULL,            -- '2026Q3'
    symbol            TEXT    NOT NULL,
    normalized_symbol TEXT    NOT NULL,
    company_name      TEXT,
    portfolio_pct     REAL,
    buys_count        INTEGER,
    hold_price        REAL,
    current_price     REAL,
    low_52w           REAL,
    pct_above_low_52w REAL,
    high_52w          REAL,
    source_url        TEXT,
    raw_row           TEXT,                        -- JSON of the published cells
    first_seen_at     TEXT    NOT NULL,
    last_synced_at    TEXT    NOT NULL,
    UNIQUE (quarter, normalized_symbol)
);

CREATE INDEX IF NOT EXISTS idx_recent_buys_q_normalized_symbol
    ON recent_buys_q (normalized_symbol);

CREATE TABLE IF NOT EXISTS recent_buys_insider (
    id                INTEGER PRIMARY KEY,
    filing_at         TEXT    NOT NULL,            -- '2026-10-30T18:06', US/Eastern as published
    symbol            TEXT    NOT NULL,
    normalized_symbol TEXT    NOT NULL,
    security_name     TEXT,
    reporting_name    TEXT    NOT NULL,
    reporting_id      TEXT,                        -- Dataroma rid=
    relationship      TEXT,
    transaction_date  TEXT    NOT NULL DEFAULT '', -- '2026-10-29'
    transaction_type  TEXT,                        -- 'Purchase'
    shares            INTEGER NOT NULL,
    price             REAL    NOT NULL,
    amount            REAL,
    ownership_type    TEXT,                        -- 'D' | 'I'
    is_ten_pct_owner  INTEGER NOT NULL DEFAULT 0,
    is_amendment      INTEGER NOT NULL DEFAULT 0,  -- SEC Form 4/A
    filing_url        TEXT,
    source_url        TEXT,
    raw_row           TEXT,                        -- JSON of the published cells
    first_seen_at     TEXT    NOT NULL,
    last_synced_at    TEXT    NOT NULL,
    UNIQUE (filing_at, normalized_symbol, reporting_name, transaction_date, shares, price)
);

CREATE INDEX IF NOT EXISTS idx_recent_buys_insider_normalized_symbol
    ON recent_buys_insider (normalized_symbol);

CREATE INDEX IF NOT EXISTS idx_recent_buys_insider_transaction_date
    ON recent_buys_insider (transaction_date);

CREATE INDEX IF NOT EXISTS idx_recent_buys_insider_filing_at
    ON recent_buys_insider (filing_at);
