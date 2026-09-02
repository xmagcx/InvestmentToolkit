/**
 * PortfolioMaintainerService.ts — manual web portfolio data entry + maintenance.
 *
 * Purpose:
 *   Pure-TS service that records buy/sell transactions and manages accounts/cash
 *   on `domain_model.sqlite`, replacing broken TV/CDP sync as the manual entry
 *   path. Computes weighted-average cost (REQ-1), keeps avg cost unchanged on
 *   sells + rejects oversell (REQ-2), maintains per-account cash (REQ-3, modeled
 *   as a synthetic `CASH_<CURRENCY>` `account_investment` row, avg_cost=1.0),
 *   manages accounts + initial cash (REQ-4), writes one `trade_log_entry` audit
 *   row per successful transaction (REQ-5), keeps currencies isolated per
 *   account (REQ-6), and supports explicit position removal (REQ-7).
 *
 *   The service OWNS one `better-sqlite3` connection and wraps EVERY write (the
 *   position + the cash row + the audit row) in ONE `db.transaction()` for
 *   atomicity + single-writer serialization. Writes are NEVER scattered across
 *   repositories. On a reject (oversell / overspend) the transaction rolls back
 *   and no position/cash/trade_log change persists.
 *
 * Layer:
 *   Backend / Services / Portfolio Maintainer (single-writer transaction owner)
 *
 * Key Functions:
 *   - createAccount / setInitialCash - account + initial cash setup (REQ-4)
 *   - buy / sell - read → recompute → upsert position + cash + audit (REQ-1..3,5,6)
 *   - deletePosition - remove a position on user confirmation (REQ-7)
 *   - listAccounts / listPositions - read views for the UI
 *
 * Key Input Dependencies:
 *   - better-sqlite3 (single owned connection)
 *   - ./PortfolioMaintainerMath (pure avg-cost + cash arithmetic)
 */
import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import {
    computeFirstBuyAvg,
    computeSubsequentBuyAvg,
    computeBuyCash,
    computeSellQuantity,
    computeSellCash,
    computeSellAvg,
} from './PortfolioMaintainerMath';

export type Side = 'BUY' | 'SELL';
export type AccountType = 'TFSA' | 'RRSP' | 'CASH';

export interface TransactionInput {
    accountId: string;
    ticker: string;
    side: Side;
    qty: number;
    price: number;
    commission?: number;
}

export interface AccountView {
    accountId: string;
    name: string;
    type: string;
    currency: string;
    cash: number;
}

export interface PositionView {
    ticker: string;
    qty: number;
    avgCost: number | null;
}

export interface TransactionResult {
    position: PositionView | null;
    cash: number;
    currency: string;
}

export class PortfolioMaintainerError extends Error {
    status: number;
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

/** Default base currency per account type (REQ-4): TFSA/RRSP=CAD, CASH=USD. */
const DEFAULT_CURRENCY: Record<AccountType, string> = {
    TFSA: 'CAD',
    RRSP: 'CAD',
    CASH: 'USD',
};

export class PortfolioMaintainerService {
    private db: Database.Database;
    private readonly dbPath: string;

    constructor(dbPath: string) {
        this.dbPath = dbPath;
        this.db = new Database(dbPath);
        this.ensureSchema();
    }

    close(): void {
        this.db.close();
    }

    /** Transcribed from `db_client.py::initialize_db` — creates the tables the
     * maintainer touches (account, investment, account_investment,
     * trade_log_entry). Idempotent no-op against the real file; load-bearing for
     * a fresh temp/test database. */
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
                asset_class                 TEXT NOT NULL,
                currency                    TEXT NOT NULL DEFAULT 'USD',
                updated_at                  TEXT NOT NULL,
                UNIQUE(symbol)
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

            CREATE TABLE IF NOT EXISTS trade_log_entry (
                entry_id        TEXT PRIMARY KEY,
                investment_id   TEXT NOT NULL REFERENCES investment(investment_id),
                account_id      TEXT REFERENCES account(account_id),
                action          TEXT,
                shares          REAL,
                price           REAL,
                total_cost      REAL,
                order_type      TEXT,
                limit_price     REAL,
                trade_date      TEXT,
                notes           TEXT,
                status          TEXT,
                source          TEXT,
                priority        TEXT,
                logged_at       TEXT,
                tv_order_id     TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_account_investment_account ON account_investment(account_id);
        `);
    }

    /** Idempotent lookup-or-insert of the `investment` row for a symbol, returning
     * its `investment_id` (mirrors InvestmentRepository.resolveInvestmentId). The
     * account_investment FK requires the row to exist, so every position and the
     * synthetic `CASH_<cur>` row resolve here first. */
    private resolveInvestmentId(symbol: string, assetClass = 'EQUITY', currency = 'USD'): string {
        const existing = this.db
            .prepare('SELECT investment_id FROM investment WHERE symbol = ?')
            .get(symbol) as { investment_id: string } | undefined;
        if (existing) return existing.investment_id;

        const investmentId = symbol.toUpperCase();
        const now = new Date().toISOString();
        this.db
            .prepare(
                `INSERT INTO investment (investment_id, symbol, name, asset_class, currency, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
            )
            .run(investmentId, symbol, symbol, assetClass, currency, now);
        return investmentId;
    }

    /** Look up one account row, throwing 404 if absent. */
    private getAccountRow(accountId: string): { account_id: string; account_name: string; account_type: string | null; base_currency: string } {
        const row = this.db
            .prepare('SELECT account_id, account_name, account_type, base_currency FROM account WHERE account_id = ?')
            .get(accountId) as { account_id: string; account_name: string; account_type: string | null; base_currency: string } | undefined;
        if (!row) {
            throw new PortfolioMaintainerError(404, `Account not found: ${accountId}`);
        }
        return row;
    }

    /** Read the cash amount for a currency in an account: the synthetic CASH_<cur>
     * row's quantity, or 0 if not yet set. */
    private readCash(accountId: string, currency: string): number {
        const investmentId = `CASH_${currency}`;
        const row = this.db
            .prepare('SELECT quantity FROM account_investment WHERE account_id = ? AND investment_id = ?')
            .get(accountId, investmentId) as { quantity: number } | undefined;
        return row?.quantity ?? 0;
    }

    /** Read one position row for (account, investmentId), or null. */
    private readPosition(accountId: string, investmentId: string): { quantity: number; average_cost: number | null } | null {
        const row = this.db
            .prepare('SELECT quantity, average_cost FROM account_investment WHERE account_id = ? AND investment_id = ?')
            .get(accountId, investmentId) as { quantity: number; average_cost: number | null } | undefined;
        return row ?? null;
    }

    /** REQ-4 S1: create an account with type-defaulted base currency (editable via
     * a passed currency). Used both at creation and, idempotently, to ensure a row. */
    createAccount(name: string, type: AccountType, currency?: string): AccountView {
        const accountId = name; // caller-provided account id is the account name
        const resolvedCurrency = (currency || DEFAULT_CURRENCY[type] || 'CAD').toUpperCase();
        this.db
            .prepare(
                `INSERT INTO account (account_id, account_name, account_type, base_currency)
                 VALUES (?, ?, ?, ?)
                 ON CONFLICT(account_id) DO UPDATE SET
                 account_name = excluded.account_name,
                 account_type = excluded.account_type,
                 base_currency = excluded.base_currency`
            )
            .run(accountId, name, type, resolvedCurrency);
        return { accountId, name, type, currency: resolvedCurrency, cash: 0 };
    }

    /** REQ-4 S2: set the initial cash for an account → CASH_<cur> row quantity =
     * amount, avg_cost 1.0. Currency-isolated to the account's base currency. */
    setInitialCash(accountId: string, amount: number): void {
        const account = this.getAccountRow(accountId);
        const currency = account.base_currency;
        const now = new Date().toISOString();
        const investmentId = this.resolveInvestmentId(`CASH_${currency}`, 'CASH', currency);
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
            .run(`${accountId}:${investmentId}`, accountId, investmentId, amount, 1, amount, currency, now);
    }

    /** PATCH /accounts/:id — update account name/currency; returns the updated view. */
    updateAccount(
        accountId: string,
        patch: { name?: string; currency?: string }
    ): AccountView {
        const account = this.getAccountRow(accountId);
        const newName = typeof patch.name === 'string' && patch.name.trim() !== '' ? patch.name.trim() : account.account_name;
        const newCurrency = typeof patch.currency === 'string' && patch.currency.trim() !== ''
            ? patch.currency.trim().toUpperCase()
            : account.base_currency;
        this.db
            .prepare('UPDATE account SET account_name = ?, base_currency = ? WHERE account_id = ?')
            .run(newName, newCurrency, accountId);
        return {
            accountId,
            name: newName,
            type: account.account_type ?? '',
            currency: newCurrency,
            cash: this.readCash(accountId, newCurrency),
        };
    }

    /** Read the current cash for an account (0 if no CASH_<cur> row yet). */
    getAccountCash(accountId: string): number {
        const account = this.getAccountRow(accountId);
        return this.readCash(accountId, account.base_currency);
    }

    /** REQ-1/S1..S3, REQ-3: record a buy. Read position + cash, recompute avg cost
     * and deduct cash, upsert both + write the audit row — all in one transaction. */
    buy(input: TransactionInput): TransactionResult {
        return this.transact(() => {
            const account = this.getAccountRow(input.accountId);
            const currency = account.base_currency;
            const comm = input.commission ?? 0;
            const investmentId = this.resolveInvestmentId(input.ticker);

            const pos = this.readPosition(input.accountId, investmentId);
            const qty = input.qty;
            const price = input.price;

            let newQty: number;
            let newAvg: number;
            let opened = false;
            if (!pos) {
                newQty = qty;
                newAvg = computeFirstBuyAvg(qty, price, comm);
                opened = true;
            } else {
                newQty = pos.quantity + qty;
                newAvg = computeSubsequentBuyAvg(pos.quantity, pos.average_cost ?? 0, qty, price, comm);
            }

            // cash deduction with overspend guard (REQ-3 S2)
            const oldCash = this.readCash(input.accountId, currency);
            const newCash = computeBuyCash(oldCash, qty, price, comm);
            if (newCash === Number.MIN_SAFE_INTEGER) {
                throw new PortfolioMaintainerError(
                    400,
                    `Insufficient ${currency} cash: need ${(qty * price + comm).toFixed(2)}, have ${oldCash.toFixed(2)}`
                );
            }

            const now = new Date().toISOString();
            this.upsertPosition(input.accountId, investmentId, newQty, newAvg, currency, now);
            this.upsertCash(input.accountId, currency, newCash, now);
            this.writeTradeLog(input.accountId, investmentId, 'BUY', qty, price, comm, newAvg, opened, now);

            return { position: { ticker: input.ticker, qty: newQty, avgCost: newAvg }, cash: newCash, currency };
        });
    }

    /** REQ-2, REQ-3: record a sell. Reduce qty (avg UNCHANGED), add proceeds to
     * cash, DELETE on full exit. Oversell throws. All in one transaction. */
    sell(input: TransactionInput): TransactionResult {
        return this.transact(() => {
            const account = this.getAccountRow(input.accountId);
            const currency = account.base_currency;
            const comm = input.commission ?? 0;
            const investmentId = this.resolveInvestmentId(input.ticker);

            const pos = this.readPosition(input.accountId, investmentId);
            if (!pos) {
                throw new PortfolioMaintainerError(404, `Position not found: ${input.ticker} in ${input.accountId}`);
            }

            const newQty = computeSellQuantity(pos.quantity, input.qty);
            if (newQty === Number.MIN_SAFE_INTEGER) {
                throw new PortfolioMaintainerError(
                    400,
                    `Cannot sell ${input.qty} of ${input.ticker} — position holds ${pos.quantity}`
                );
            }

            const oldCash = this.readCash(input.accountId, currency);
            const newCash = computeSellCash(oldCash, input.qty, input.price, comm);

            const now = new Date().toISOString();
            const fullExit = newQty <= 0;
            if (fullExit) {
                this.db.prepare('DELETE FROM account_investment WHERE account_id = ? AND investment_id = ?')
                    .run(input.accountId, investmentId);
            } else {
                this.upsertPosition(input.accountId, investmentId, newQty, computeSellAvg(pos.average_cost ?? 0), currency, now);
            }
            this.upsertCash(input.accountId, currency, newCash, now);
            this.writeTradeLog(input.accountId, investmentId, 'SELL', input.qty, input.price, comm, pos.average_cost ?? 0, false, now, fullExit);

            return {
                position: fullExit ? null : { ticker: input.ticker, qty: newQty, avgCost: computeSellAvg(pos.average_cost ?? 0) },
                cash: newCash,
                currency,
            };
        });
    }

    /** REQ-7: remove a position row (user-confirmed delete); cash unchanged. */
    deletePosition(accountId: string, ticker: string): void {
        this.transact(() => {
            const investmentId = this.resolveInvestmentId(ticker);
            const gone = this.db
                .prepare('DELETE FROM account_investment WHERE account_id = ? AND investment_id = ?')
                .run(accountId, investmentId).changes;
            if (gone === 0) {
                throw new PortfolioMaintainerError(404, `Position not found: ${ticker} in ${accountId}`);
            }
        });
    }

    /** Upsert one position row (REPLACES avg_cost + qty per read→recompute→upsert). */
    private upsertPosition(accountId: string, investmentId: string, qty: number, avgCost: number, currency: string, now: string): void {
        const bookValue = qty * avgCost;
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
            .run(`${accountId}:${investmentId}`, accountId, investmentId, qty, avgCost, bookValue, currency, now);
    }

    /** Upsert the synthetic CASH_<currency> row (avg_cost 1.0, book_value = qty). */
    private upsertCash(accountId: string, currency: string, cash: number, now: string): void {
        const investmentId = `CASH_${currency}`;
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
            .run(`${accountId}:${investmentId}`, accountId, investmentId, cash, 1, cash, currency, now);
    }

    /** REQ-5: write one trade_log_entry per successful transaction, inside the
     * same transaction. Collision-safe entry_id via crypto.randomUUID(). */
    private writeTradeLog(
        accountId: string,
        investmentId: string,
        action: Side,
        qty: number,
        price: number,
        commission: number,
        avgCost: number,
        opened: boolean,
        now: string,
        fullExit = false
    ): void {
        const entryId = randomUUID();
        const totalCost = action === 'BUY' ? qty * price + commission : qty * price - commission;
        const notes = action === 'BUY' ? (opened ? 'opened' : `avg=${Number(avgCost.toFixed(4))}`) : fullExit ? 'exit' : `avg=${Number(avgCost.toFixed(4))}`;
        this.db
            .prepare(
                `INSERT INTO trade_log_entry
                 (entry_id, investment_id, account_id, action, shares, price, total_cost, trade_date, notes, status, source, logged_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(entryId, investmentId, accountId, action, qty, price, totalCost, now, notes, 'EXECUTED', 'MANUAL', now);
    }

    /** Wrap a write closure in ONE db.transaction() (atomicity + single-writer). */
    private transact<T>(fn: () => T): T {
        return this.db.transaction(fn)();
    }

    listAccounts(): AccountView[] {
        const rows = this.db
            .prepare('SELECT account_id, account_name, account_type, base_currency FROM account ORDER BY account_id')
            .all() as Array<{ account_id: string; account_name: string; account_type: string | null; base_currency: string }>;
        return rows.map(r => ({
            accountId: r.account_id,
            name: r.account_name,
            type: r.account_type ?? '',
            currency: r.base_currency,
            cash: this.readCash(r.account_id, r.base_currency),
        }));
    }

    /** Read view for the UI / routes. Filtered variant returns plain positions;
     * the unfiltered variant joins account + position currency for GET /positions. */
    listPositions(accountId: string): PositionView[];
    listPositions(): Array<{ accountId: string; ticker: string; qty: number; avgCost: number | null; currency: string }>;
    listPositions(accountId?: string): PositionView[] | Array<{ accountId: string; ticker: string; qty: number; avgCost: number | null; currency: string }> {
        if (accountId) {
            return this.db
                .prepare(`
                    SELECT i.symbol AS ticker, ai.quantity, ai.average_cost
                    FROM account_investment ai
                    JOIN investment i ON i.investment_id = ai.investment_id
                    WHERE ai.account_id = ?
                    ORDER BY i.symbol`)
                .all(accountId)
                .map((r: any) => ({ ticker: r.ticker, qty: r.quantity, avgCost: r.average_cost ?? null }));
        }
        return this.db
            .prepare(`
                SELECT ai.account_id AS accountId, i.symbol AS ticker, ai.quantity, ai.average_cost, ai.currency
                FROM account_investment ai
                JOIN investment i ON i.investment_id = ai.investment_id
                WHERE i.symbol NOT LIKE 'CASH_%'
                ORDER BY ai.account_id, i.symbol`)
            .all()
            .map((r: any) => ({
                accountId: r.accountId,
                ticker: r.ticker,
                qty: r.quantity,
                avgCost: r.average_cost ?? null,
                currency: r.currency,
            }));
    }
}
