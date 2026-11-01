-- 0016_opportunity_risk: add the three tables step 5 ("¿Es una caída sana?") and the enriched
-- step 6 ("¿Lo compran los expertos?") of the opportunities screener read (S11, S12, S14).
--
-- `stock_risk_metrics` is the latest three-year risk reading of one instrument, one row per
-- symbol, computed by py_services/risk_metrics.py from daily closes (source `price_risk`).
-- It is a snapshot, not history: a new run replaces the row. Every metric is nullable because
-- a symbol with less than two years of history has no meaningful three-year figure, and the
-- engine reports that as "Datos insuficientes" rather than as a failed condition.
-- `max_drawdown_3y` is a NEGATIVE fraction (-0.38 = the price fell 38 % from its peak);
-- `recovery_days` is NULL while the instrument has not recovered its previous peak;
-- `history_days` is how many daily closes the computation actually used.
--
-- `stock_eps_revisions` is the current-year analyst-revision row yfinance publishes per symbol
-- (source `eps_revisions`, only symbols that pass step 4 on the latest snapshot). `period` is
-- the yfinance row it came from ('0y', or '0q' when the yearly row is absent).
--
-- `stock_superinvestor_holdings` is what Dataroma says the superinvestors hold of one symbol
-- (source `dataroma_holdings`): how many managers hold it, how many held it the previous
-- quarter, the largest weight it has in any of their portfolios, their average purchase price,
-- the net quarterly activity (buys - sells) and the per-manager detail as JSON.
--
-- None of these tables feeds `investment_price` (rule 25) or any recommendation (rule 23):
-- they are screening inputs only.

CREATE TABLE IF NOT EXISTS stock_risk_metrics (
    symbol             TEXT PRIMARY KEY,   -- normalized symbol (ticker_aliases)
    sortino_3y         REAL,
    sharpe_3y          REAL,
    downside_beta_3y   REAL,               -- vs SPY, on the days the benchmark fell
    max_drawdown_3y    REAL,               -- negative fraction (-0.38 = -38 %)
    recovery_days      INTEGER,            -- NULL while the previous peak is not recovered
    volatility_ann     REAL,               -- annualised standard deviation of daily returns
    history_days       INTEGER,            -- daily closes used by the computation
    as_of              TEXT,               -- date of the last close used
    fetched_at         TEXT
);

CREATE TABLE IF NOT EXISTS stock_eps_revisions (
    symbol      TEXT PRIMARY KEY,
    up_7d       INTEGER,
    down_7d     INTEGER,
    up_30d      INTEGER,
    down_30d    INTEGER,
    period      TEXT,                      -- yfinance row used ('0y' or '0q')
    fetched_at  TEXT
);

CREATE TABLE IF NOT EXISTS stock_superinvestor_holdings (
    symbol            TEXT PRIMARY KEY,
    holders           INTEGER NOT NULL,
    holders_prev      INTEGER,
    max_portfolio_pct REAL,
    avg_hold_price    REAL,
    net_activity      INTEGER,
    top_holders       TEXT,                -- JSON [{manager, pct, activity}]
    fetched_at        TEXT NOT NULL
);
