/**
 * PortfolioRepository.ts - SQLite persistence for the shared `account` and
 * `account_investment` tables.
 *
 * Purpose:
 *   TS-side counterpart to `py_services/domain_model/account_investment_repository.py`
 *   (ADR-029/030), reading/writing the same physical `data/domain_model.sqlite` file
 *   via `better-sqlite3`. Mirrors `InvestmentRepository.ts`'s Wave 2 pattern: a thin
 *   repository class wrapping the Node SQLite driver for these two tables, with
 *   `ensureSchema()` transcribing the same `CREATE TABLE IF NOT EXISTS` DDL as
 *   `db_client.py::initialize_db` (idempotent no-op against the real file;
 *   load-bearing for fresh temp/test databases). No script or service should open
 *   its own connection against `account`/`account_investment` outside this class.
 *
 *   `investment` rows themselves (the FK target of `account_investment.investment_id`)
 *   remain InvestmentRepository.ts's exclusive concern per its own module docstring —
 *   callers here resolve/pass an already-known `investmentId` (e.g. via
 *   `InvestmentRepository.resolveInvestmentId(symbol)`) rather than this class
 *   duplicating that write path.
 *
 * Layer:
 *   Backend / Services / Data Persistence (SQLite-backed repository)
 *
 * Key Functions (Index):
 *   - upsertAccount(accountId, accountName, accountType?, baseCurrency?) - Idempotent
 *     lookup-or-insert/update of an `account` row, mirrors
 *     account_repository.py::upsert_account
 *   - upsertAccountInvestment(accountId, investmentId, quantity, ...) - Insert-or-update
 *     one `account_investment` row keyed by (account_id, investment_id), mirrors
 *     account_investment_repository.py::upsert_account_investment
 *   - listAccountInvestments(accountId?) - Read helper for tests/verification
 *   - upsertInvestmentPrice(investmentId, price, currency, fetchedAt) - Insert-or-update
 *     one `investment_price` row, mirrors
 *     investment_price_repository.py::upsert_investment_price. Nothing in the TS
 *     producer rewire (Wave 3 Task 5) writes prices yet -- this exists so tests and
 *     any future TS price-writer have a single, non-duplicated write path, per
 *     ADR-029's "one writer per table" rule.
 *   - getAccountMarketValues() - SUM(quantity*price) GROUP BY account_id, mirrors
 *     portfolio_repository.py::get_account_market_values (Wave 3 Task 6)
 *   - getPortfolioTotalValue() - sum of getAccountMarketValues()'s own values, never
 *     an independent flat query, mirrors portfolio_repository.py::get_portfolio_total_value
 *   - listPositionsBySymbol() - per-symbol aggregate (quantity summed across accounts,
 *     latest average_cost, price) for weights/strategy-allocation call sites
 *   - getPerAccountPositions(symbol) - per-account quantity/average_cost for one
 *     symbol, used by /position/:ticker and /holdings/:ticker
 *   - upsertExchangeRate(rate, syncedAt?) / getExchangeRate() - the single
 *     broker-reported USD->CAD FX fact (broker_exchange_rate singleton), mirrors
 *     exchange_rate_repository.py (Wave 3 Task 8, ADR-030 addendum)
 */
import Database from 'better-sqlite3';

export interface AccountInvestmentRow {
    account_investment_id: string;
    account_id: string;
    investment_id: string;
    quantity: number;
    average_cost: number | null;
    book_value: number | null;
    currency: string;
    last_synced_at: string;
}

export class PortfolioRepository {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.ensureSchema();
    }

    close(): void {
        this.db.close();
    }

    /** Transcribed from `py_services/domain_model/db_client.py::initialize_db` —
     * see `InvestmentRepository.ts`'s module docstring for the sync contract this
     * mirrors. Idempotent against the real, already-initialized file. */
    private ensureSchema(): void {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');

        this.db.exec(`
            CREATE TABLE IF NOT EXISTS account (
                account_id      TEXT PRIMARY KEY,
                account_name    TEXT NOT NULL,
                account_type    TEXT,
                base_currency   TEXT NOT NULL DEFAULT 'CAD'
            );

            CREATE TABLE IF NOT EXISTS investment (
                investment_id              TEXT PRIMARY KEY,
                symbol                      TEXT NOT NULL,
                name                        TEXT,
                sector                      TEXT,
                industry                    TEXT,
                pillar_id                   TEXT,
                asset_class                 TEXT NOT NULL,
                currency                    TEXT NOT NULL DEFAULT 'USD',
                updated_at                  TEXT NOT NULL,
                UNIQUE(symbol)
            );

            CREATE TABLE IF NOT EXISTS investment_price (
                investment_id   TEXT PRIMARY KEY REFERENCES investment(investment_id),
                price           REAL NOT NULL,
                currency        TEXT NOT NULL DEFAULT 'USD',
                fetched_at      TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS account_investment (
                account_investment_id   TEXT PRIMARY KEY,
                account_id              TEXT NOT NULL REFERENCES account(account_id),
                investment_id           TEXT NOT NULL REFERENCES investment(investment_id),
                quantity                REAL NOT NULL DEFAULT 0,
                average_cost            REAL,
                book_value              REAL,
                currency                TEXT NOT NULL DEFAULT 'USD',
                last_synced_at          TEXT NOT NULL,
                UNIQUE(account_id, investment_id)
            );

            CREATE INDEX IF NOT EXISTS idx_account_investment_account ON account_investment(account_id);
            CREATE INDEX IF NOT EXISTS idx_account_investment_investment ON account_investment(investment_id);

            CREATE TABLE IF NOT EXISTS broker_exchange_rate (
                id              INTEGER PRIMARY KEY CHECK (id = 1),
                usd_to_cad_rate REAL NOT NULL,
                synced_at       TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS broker_reported_total (
                id              INTEGER PRIMARY KEY CHECK (id = 1),
                total_usd       REAL NOT NULL,
                total_cad       REAL,
                synced_at       TEXT NOT NULL,
                source          TEXT
            );

            CREATE TABLE IF NOT EXISTS portfolio_policy (
                policy_id                                TEXT PRIMARY KEY,
                rebalance_frequency                      TEXT,
                portfolio_value_usd_target               REAL,
                max_marginal_risk_contribution_pct        REAL,
                max_cluster_variance_contribution_pct      REAL,
                rebalance_band_relative_pct                REAL,
                rebalance_band_absolute_pct                REAL,
                rebalance_band_critical_multiplier          REAL,
                account_preference_rules_json                TEXT,
                psu_funding_rule_json                          TEXT,
                updated_at                                      TEXT NOT NULL
            );
        `);
    }

    /** Mirrors `broker_reported_total_repository.py::upsert_broker_reported_total`
     * — idempotently store the broker's OWN last-reported portfolio total
     * (singleton row id=1, overwritten each sync). Per ADR-030's Wave 3 addendum
     * pattern this is the audited-against comparison source for
     * verify_portfolio_total.py's reconciliation, never a substitute for the
     * computed getPortfolioTotalValue(). */
    upsertBrokerReportedTotal(totalUsd: number, totalCad: number | null, syncedAt: string, source: string | null = null): void {
        this.db
            .prepare(
                `INSERT INTO broker_reported_total (id, total_usd, total_cad, synced_at, source)
                 VALUES (1, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                 total_usd = excluded.total_usd,
                 total_cad = excluded.total_cad,
                 synced_at = excluded.synced_at,
                 source = excluded.source`
            )
            .run(totalUsd, totalCad, syncedAt, source);
    }

    /** Mirrors `broker_reported_total_repository.py::get_broker_reported_total` —
     * the stored broker-reported total row, or null if never synced. */
    getBrokerReportedTotal(): { total_usd: number; total_cad: number | null; synced_at: string; source: string | null } | null {
        const row = this.db
            .prepare('SELECT total_usd, total_cad, synced_at, source FROM broker_reported_total WHERE id = 1')
            .get() as { total_usd: number; total_cad: number | null; synced_at: string; source: string | null } | undefined;
        return row ?? null;
    }

    /** Mirrors `exchange_rate_repository.py::upsert_exchange_rate` — idempotently
     * store the single broker-reported USD->CAD FX fact (singleton row id=1,
     * overwritten each sync). Per ADR-030's Wave 3 addendum only this scalar is
     * stored; CAD totals are computed as usd*rate at read time, never persisted. */
    upsertExchangeRate(usdToCadRate: number, syncedAt: string = new Date().toISOString()): void {
        this.db
            .prepare(
                `INSERT INTO broker_exchange_rate (id, usd_to_cad_rate, synced_at)
                 VALUES (1, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET
                 usd_to_cad_rate = excluded.usd_to_cad_rate,
                 synced_at = excluded.synced_at`
            )
            .run(usdToCadRate, syncedAt);
    }

    /** Mirrors `exchange_rate_repository.py::get_exchange_rate` — the stored
     * USD->CAD rate, or null if never synced (caller falls back to a static rate). */
    getExchangeRate(): number | null {
        const row = this.db
            .prepare('SELECT usd_to_cad_rate FROM broker_exchange_rate WHERE id = 1')
            .get() as { usd_to_cad_rate: number } | undefined;
        return row ? row.usd_to_cad_rate : null;
    }

    /** Mirrors `portfolio_policy_repository.py::get_portfolio_policy` — the single
     * account/portfolio policy row (Wave 5E), or null if never written. TS is
     * read-only for this table: only Python's update_portfolio_policy.py CLI
     * writes it (matches this migration's manually-maintained-domain pattern). */
    getPortfolioPolicy(): Record<string, unknown> | null {
        const row = this.db
            .prepare(`SELECT * FROM portfolio_policy WHERE policy_id = 'default'`)
            .get() as Record<string, unknown> | undefined;
        return row ?? null;
    }

    /** Mirrors `account_repository.py::upsert_account` — idempotent
     * lookup-or-insert/update of the `account` row for `accountId`. */
    upsertAccount(accountId: string, accountName: string, accountType: string | null = null, baseCurrency = 'CAD'): void {
        this.db
            .prepare(
                `INSERT INTO account (account_id, account_name, account_type, base_currency)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(account_id) DO UPDATE SET
                 account_name = excluded.account_name,
                 account_type = excluded.account_type,
                 base_currency = excluded.base_currency`
            )
            .run(accountId, accountName, accountType, baseCurrency);
    }

    /** Mirrors `account_investment_repository.py::upsert_account_investment` —
     * insert-or-update one row keyed by (account_id, investment_id). Calling
     * twice for the same (account, investment) pair updates in place rather
     * than inserting a duplicate row. Assumes `investmentId` already resolved
     * (e.g. via `InvestmentRepository.resolveInvestmentId(symbol)`) — this
     * class never writes the `investment` table itself. */
    upsertAccountInvestment(
        accountId: string,
        investmentId: string,
        quantity: number,
        averageCost: number | null,
        bookValue: number | null,
        currency: string,
        lastSyncedAt: string
    ): string {
        const accountInvestmentId = `${accountId}:${investmentId}`;
        this.db
            .prepare(
                `INSERT INTO account_investment
                 (account_investment_id, account_id, investment_id, quantity, average_cost, book_value, currency, last_synced_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(account_id, investment_id) DO UPDATE SET
                 quantity = excluded.quantity,
                 average_cost = excluded.average_cost,
                 book_value = excluded.book_value,
                 currency = excluded.currency,
                 last_synced_at = excluded.last_synced_at`
            )
            .run(accountInvestmentId, accountId, investmentId, quantity, averageCost, bookValue, currency, lastSyncedAt);
        return accountInvestmentId;
    }

    /**
     * Delete every `account_investment` row for one account.
     *
     * A fresh TV snapshot for an account is the complete, authoritative current
     * state — not a partial diff. Without this, a position fully closed/sold in
     * that account (no longer present in the snapshot) would never be removed by
     * `upsertAccountInvestment` alone (insert-or-update never deletes), leaving a
     * stale nonzero-quantity row that silently inflates every future computed
     * portfolio total. Call this immediately before re-upserting an account's
     * fresh positions/cash for the same sync.
     */
    clearAccountInvestments(accountId: string): void {
        this.db.prepare('DELETE FROM account_investment WHERE account_id = ?').run(accountId);
    }

    /** Read helper: all `account_investment` rows, optionally filtered by account. */
    listAccountInvestments(accountId?: string): AccountInvestmentRow[] {
        if (accountId) {
            return this.db
                .prepare('SELECT * FROM account_investment WHERE account_id = ? ORDER BY investment_id')
                .all(accountId) as AccountInvestmentRow[];
        }
        return this.db.prepare('SELECT * FROM account_investment ORDER BY account_id, investment_id').all() as AccountInvestmentRow[];
    }

    /** List all `account` rows. Read helper for the portfolio-maintainer surface
     * (the manual web entry routes consume this via the maintainer service, which
     * owns the single transactional connection; this method is a standalone
     * non-transactional read utility for call sites that do not hold a service). */
    listAccounts(): Array<{ accountId: string; name: string; type: string | null; currency: string }> {
        return this.db
            .prepare('SELECT account_id, account_name, account_type, base_currency FROM account ORDER BY account_id')
            .all()
            .map((r: any) => ({
                accountId: r.account_id,
                name: r.account_name,
                type: r.account_type ?? null,
                currency: r.base_currency,
            }));
    }

    /** Read one `account` row by id, or null if absent. */
    getAccount(accountId: string): { accountId: string; name: string; type: string | null; currency: string } | null {
        const row = this.db
            .prepare('SELECT account_id, account_name, account_type, base_currency FROM account WHERE account_id = ?')
            .get(accountId) as { account_id: string; account_name: string; account_type: string | null; base_currency: string } | undefined;
        if (!row) return null;
        return {
            accountId: row.account_id,
            name: row.account_name,
            type: row.account_type ?? null,
            currency: row.base_currency,
        };
    }

    /** Delete one `account_investment` row by (account, investment), returning
     * whether a row was removed. Standalone non-transactional utility; the
     * portfolio-maintainer write path uses the service's own transactional
     * deletePosition instead. */
    deleteAccountInvestment(accountId: string, investmentId: string): boolean {
        const res = this.db
            .prepare('DELETE FROM account_investment WHERE account_id = ? AND investment_id = ?')
            .run(accountId, investmentId);
        return res.changes > 0;
    }

    /** Mirrors `investment_price_repository.py::upsert_investment_price` — insert-
     * or-update the single `investment_price` row for `investmentId`. */
    upsertInvestmentPrice(investmentId: string, price: number, currency = 'USD', fetchedAt: string = new Date().toISOString()): void {
        this.db
            .prepare(
                `INSERT INTO investment_price (investment_id, price, currency, fetched_at)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(investment_id) DO UPDATE SET
                 price = excluded.price,
                 currency = excluded.currency,
                 fetched_at = excluded.fetched_at`
            )
            .run(investmentId, price, currency, fetchedAt);
    }

    /** Delete the `investment_price` row for `investmentId`, if any. Called before a
     * refresh fetch so a symbol whose fetch fails/is skipped reads as missing (0/unknown)
     * afterward rather than silently continuing to serve yesterday's stale price forever. */
    clearInvestmentPrice(investmentId: string): void {
        this.db.prepare('DELETE FROM investment_price WHERE investment_id = ?').run(investmentId);
    }

    /** Read the single `investment_price` row for `investmentId`, or `null` if none exists. */
    getInvestmentPrice(investmentId: string): { price: number; currency: string; fetched_at: string } | null {
        const row = this.db
            .prepare('SELECT price, currency, fetched_at FROM investment_price WHERE investment_id = ?')
            .get(investmentId) as { price: number; currency: string; fetched_at: string } | undefined;
        return row ?? null;
    }

    /** Mirrors `portfolio_repository.py::get_account_market_values` — SUM(quantity*price)
     * GROUP BY account_id via an INNER JOIN against investment_price (a position with no
     * price row yet contributes zero rather than a fabricated value, matching the Python
     * reference's documented behavior). */
    getAccountMarketValues(): Record<string, number> {
        const rows = this.db
            .prepare(
                `SELECT ai.account_id AS account_id, SUM(ai.quantity * ip.price) AS market_value
                 FROM account_investment ai
                 JOIN investment_price ip ON ip.investment_id = ai.investment_id
                 GROUP BY ai.account_id`
            )
            .all() as Array<{ account_id: string; market_value: number }>;
        const result: Record<string, number> = {};
        for (const r of rows) result[r.account_id] = r.market_value;
        return result;
    }

    /** Mirrors `portfolio_repository.py::get_portfolio_total_value` — the sum of
     * getAccountMarketValues()'s own results. Deliberately NOT an independent flat
     * query with no GROUP BY: the portfolio total must always be traceable as a
     * rollup of account-level totals, never a query that can silently cross
     * account lines (this migration's standing rule). */
    getPortfolioTotalValue(): number {
        return Object.values(this.getAccountMarketValues()).reduce((a, b) => a + b, 0);
    }

    /** The most recent `account_investment.last_synced_at` across every row — the
     * real, per-sync "when was this data last refreshed" timestamp. Unlike
     * `portfolio.json`'s `totals.timestamp`/`positions[].last_updated` (which Wave 3
     * stopped writing entirely once sync cut over to SQLite-only writes), this
     * value updates on every real sync because `upsertAccountInvestment` always
     * writes a fresh `last_synced_at`. Returns null when there are no rows yet
     * (matches `getPortfolioTotalUsdFromDb`'s null-not-zero convention). */
    getLastSyncedAt(): string | null {
        const row = this.db
            .prepare('SELECT MAX(last_synced_at) AS latest FROM account_investment')
            .get() as { latest: string | null } | undefined;
        return row?.latest ?? null;
    }

    /** Per-symbol aggregate across all accounts: summed quantity, a representative
     * average_cost, and the latest price (LEFT JOIN — a symbol with no price row
     * yet still appears, with price = null), for /weights and /strategy-allocation
     * call sites which need one row per ticker rather than per (account, ticker). */
    listPositionsBySymbol(): Array<{ symbol: string; quantity: number; averageCost: number | null; price: number | null }> {
        const rows = this.db
            .prepare(
                `SELECT i.symbol AS symbol,
                        SUM(ai.quantity) AS quantity,
                        MAX(ai.average_cost) AS average_cost,
                        MAX(ip.price) AS price
                 FROM account_investment ai
                 JOIN investment i ON i.investment_id = ai.investment_id
                 LEFT JOIN investment_price ip ON ip.investment_id = ai.investment_id
                 GROUP BY i.symbol
                 ORDER BY i.symbol`
            )
            .all() as Array<{ symbol: string; quantity: number; average_cost: number | null; price: number | null }>;
        return rows.map(r => ({ symbol: r.symbol, quantity: r.quantity, averageCost: r.average_cost, price: r.price }));
    }

    /** Per-account quantity/average_cost for one symbol (resolved via `investment`),
     * used by /position/:ticker and /holdings/:ticker to replace tvSnapshot.positions[]
     * reads. Returns [] if the symbol has no investment row at all. */
    getPerAccountPositions(symbol: string): Array<{ accountId: string; quantity: number; averageCost: number | null }> {
        const rows = this.db
            .prepare(
                `SELECT ai.account_id AS account_id, ai.quantity AS quantity, ai.average_cost AS average_cost
                 FROM account_investment ai
                 JOIN investment i ON i.investment_id = ai.investment_id
                 WHERE i.symbol = ?
                 ORDER BY ai.account_id`
            )
            .all(symbol) as Array<{ account_id: string; quantity: number; average_cost: number | null }>;
        return rows.map(r => ({ accountId: r.account_id, quantity: r.quantity, averageCost: r.average_cost }));
    }
}
