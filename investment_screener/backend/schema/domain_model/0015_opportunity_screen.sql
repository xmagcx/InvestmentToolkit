-- 0015_opportunity_screen: add stock_screen_snapshot and market_rate so the opportunities
-- screener (S3-S8) can score the Racional universe without re-fetching anything per request.
--
-- `stock_screen_snapshot` is the latest TradingView scanner reading of one instrument, one row
-- per instrument, keyed by the canonical normalized symbol (ticker_aliases.normalize_ticker,
-- so BRK.B stays BRK.B). It is a *snapshot*, not history: the scanner source replaces the row
-- of every symbol it gets back, and a symbol the scanner did not return keeps its previous
-- (stale) row instead of being deleted — the sync reports it as rejected instead.
--
-- It deliberately does NOT feed `investment_price`: rule 25 keeps tv_price_refresh.py the only
-- writer of prices. `close` here is screening input, never the portfolio's price of record.
--
-- Columns map 1:1 to the scanner fields listed in S7 (close, price_52_week_high, SMA50, SMA200,
-- RSI, MACD.macd, MACD.signal, price_earnings_ttm, earnings_per_share_diluted_ttm,
-- earnings_per_share_diluted_yoy_growth_ttm, book_value_per_share_fq, return_on_equity,
-- return_on_assets, return_on_invested_capital, free_cash_flow, market_cap_basic,
-- debt_to_equity, price_earnings_growth_ttm, total_revenue_yoy_growth_ttm,
-- price_target_average, recommendation_*, sector, update_mode), renamed to the repo's
-- snake_case. Every metric is nullable: TradingView publishes null for a ratio it cannot
-- compute (a loss-making company has no P/E), and the engine reports that as missing data
-- rather than as a failed condition. `raw_row` keeps the scanner's own JSON so a later column
-- change can be diagnosed without re-fetching, and `update_mode` records how delayed the
-- quote was ('delayed_streaming_900' on the anonymous endpoint).
--
-- `market_rate` is the tiny table of external reference rates the valuation formulas need;
-- today exactly one row, series_id 'AAA' (Moody's AAA corporate-bond yield from FRED), which
-- is the Y of Graham's V = EPS x (8.5 + 2g) x 4.4 / Y. `observed_at` is the date FRED
-- published the observation; `fetched_at` is when this toolkit read it.

CREATE TABLE IF NOT EXISTS stock_screen_snapshot (
    symbol                TEXT PRIMARY KEY,       -- normalized symbol (ticker_aliases)
    tv_symbol             TEXT,                   -- 'NASDAQ:AAPL' as TradingView returned it
    name                  TEXT,
    sector                TEXT,                   -- TradingView sector ('Finance', 'Utilities', ...)
    close                 REAL,
    price_52_week_high    REAL,
    sma50                 REAL,
    sma200                REAL,
    rsi                   REAL,
    macd                  REAL,
    macd_signal           REAL,
    pe_ttm                REAL,
    eps_ttm               REAL,
    eps_growth_pct        REAL,                   -- diluted EPS yoy growth, %
    book_value_per_share  REAL,
    roe                   REAL,                   -- %
    roa                   REAL,                   -- %
    roic                  REAL,                   -- %
    free_cash_flow        REAL,                   -- absolute currency units
    market_cap            REAL,
    debt_to_equity        REAL,                   -- ratio, not %
    peg                   REAL,
    revenue_growth_pct    REAL,
    price_target_average  REAL,
    recommendation_buy    INTEGER,
    recommendation_hold   INTEGER,
    recommendation_sell   INTEGER,
    recommendation_total  INTEGER,
    update_mode           TEXT,
    raw_row               TEXT,                   -- JSON of the scanner columns
    fetched_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_screen_snapshot_sector
    ON stock_screen_snapshot (sector);

CREATE TABLE IF NOT EXISTS market_rate (
    series_id   TEXT PRIMARY KEY,                 -- 'AAA'
    value       REAL NOT NULL,                    -- % per year
    observed_at TEXT NOT NULL,                    -- observation date as the publisher dates it
    fetched_at  TEXT NOT NULL
);
