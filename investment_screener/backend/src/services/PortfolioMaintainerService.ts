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
import { ensureSchemaReady } from '../utils/schemaVersion';
import { normalizeTicker } from '../utils/tickerAliases';
import {
    computeFirstBuyAvg,
    computeSubsequentBuyAvg,
    computeBuyCash,
    computeSellQuantity,
    computeSellCash,
    computeSellAvg,
} from './PortfolioMaintainerMath';

export type Side = 'BUY' | 'SELL';
/** 'PROFILE' is the free-form portfolio profile (S2); the three broker-era
 * account types stay valid so existing accounts keep working. */
export type AccountType = 'TFSA' | 'RRSP' | 'CASH' | 'PROFILE';

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

/** GET /positions row: a position plus its stored market price (null when unpriced). */
export interface MarketPositionView {
    accountId: string;
    ticker: string;
    qty: number;
    avgCost: number | null;
    currency: string;
    price: number | null;
    priceAsOf: string | null;
}

/** One `trade_log_entry` row as the UI sees it (S4). `ticker` is the JSON name
 * of the SQL `symbol` column, per the repo's ticker-vs-symbol rule. */
export interface TransactionView {
    entryId: string;
    ticker: string;
    action: string;
    shares: number | null;
    price: number | null;
    totalCost: number | null;
    notes: string | null;
    loggedAt: string | null;
}

/** A ticker is 1-15 characters of A-Z, 0-9, dot or dash, starting alphanumeric. */
const TICKER_RE = /^[A-Z0-9][A-Z0-9.-]{0,14}$/;

/** Trim, upcase and resolve broker aliases (S5); throws 400 on an unusable ticker. */
export function canonicalTicker(raw: unknown): string {
    const ticker = typeof raw === 'string' ? normalizeTicker(raw.trim().toUpperCase()) : '';
    if (!TICKER_RE.test(ticker)) {
        throw new PortfolioMaintainerError(400, `Invalid ticker: ${String(raw ?? '').trim() || '(empty)'}`);
    }
    return ticker;
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
    PROFILE: 'USD',
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

    /** Connection settings only. The schema itself is owned by Python (see
     * `utils/schemaVersion.ts`): this verifies the version and never creates or
     * alters a table. A brand-new (empty) file is built by the Python migrator,
     * which is what makes a fresh install or a temp test database work. */
    private ensureSchema(): void {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        ensureSchemaReady(this.db, this.dbPath);
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
            const ticker = canonicalTicker(input.ticker);
            if (!(input.qty > 0) || !(input.price > 0)) {
                throw new PortfolioMaintainerError(400, 'Quantity and price must be positive numbers');
            }
            // S5: a new stock enters the platform here, in the profile's currency.
            const investmentId = this.resolveInvestmentId(ticker, 'EQUITY', currency);

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

            return { position: { ticker, qty: newQty, avgCost: newAvg }, cash: newCash, currency };
        });
    }

    /** REQ-2, REQ-3: record a sell. Reduce qty (avg UNCHANGED), add proceeds to
     * cash, DELETE on full exit. Oversell throws. All in one transaction. */
    sell(input: TransactionInput): TransactionResult {
        return this.transact(() => {
            const account = this.getAccountRow(input.accountId);
            const currency = account.base_currency;
            const comm = input.commission ?? 0;
            const ticker = canonicalTicker(input.ticker);
            if (!(input.qty > 0) || !(input.price > 0)) {
                throw new PortfolioMaintainerError(400, 'Quantity and price must be positive numbers');
            }
            const investmentId = this.resolveInvestmentId(ticker, 'EQUITY', currency);

            const pos = this.readPosition(input.accountId, investmentId);
            if (!pos) {
                throw new PortfolioMaintainerError(404, `Position not found: ${ticker} in ${input.accountId}`);
            }

            const newQty = computeSellQuantity(pos.quantity, input.qty);
            if (newQty === Number.MIN_SAFE_INTEGER) {
                throw new PortfolioMaintainerError(
                    400,
                    `Cannot sell ${input.qty} of ${ticker} — position holds ${pos.quantity}`
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
                position: fullExit ? null : { ticker, qty: newQty, avgCost: computeSellAvg(pos.average_cost ?? 0) },
                cash: newCash,
                currency,
            };
        });
    }

    /** S3: wallet movement. `DEPOSIT` adds, `WITHDRAW` subtracts and is rejected
     * when it would overdraw (balance and audit log both unchanged). One
     * `trade_log_entry` per accepted movement, against the CASH_<cur> instrument. */
    private moveCash(accountId: string, amount: number, action: 'DEPOSIT' | 'WITHDRAW', note?: string): { cash: number; currency: string } {
        return this.transact(() => {
            if (!Number.isFinite(amount) || amount <= 0) {
                throw new PortfolioMaintainerError(400, 'Amount must be a positive number');
            }
            const account = this.getAccountRow(accountId);
            const currency = account.base_currency;
            const oldCash = this.readCash(accountId, currency);
            const newCash = action === 'DEPOSIT' ? oldCash + amount : oldCash - amount;
            if (newCash < 0) {
                throw new PortfolioMaintainerError(
                    400,
                    `Insufficient ${currency} cash: withdrawal of ${amount.toFixed(2)}, balance ${oldCash.toFixed(2)}`
                );
            }
            const now = new Date().toISOString();
            const investmentId = this.resolveInvestmentId(`CASH_${currency}`, 'CASH', currency);
            this.upsertCash(accountId, currency, newCash, now);
            this.db
                .prepare(
                    `INSERT INTO trade_log_entry
                     (entry_id, investment_id, account_id, action, shares, price, total_cost, trade_date, notes, status, source, logged_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
                )
                .run(randomUUID(), investmentId, accountId, action, amount, 1, amount, now, note ?? null, 'EXECUTED', 'portfolio-maintainer', now);
            return { cash: newCash, currency };
        });
    }

    deposit(accountId: string, amount: number, note?: string): { cash: number; currency: string } {
        return this.moveCash(accountId, amount, 'DEPOSIT', note);
    }

    withdraw(accountId: string, amount: number, note?: string): { cash: number; currency: string } {
        return this.moveCash(accountId, amount, 'WITHDRAW', note);
    }

    /** S2: delete a profile. Refuses (409) while it holds positions, and while it
     * holds cash unless `force` confirms it. Removes the CASH_<cur> row with the
     * account so no orphan position survives. */
    deleteAccount(accountId: string, force = false): void {
        this.transact(() => {
            const account = this.getAccountRow(accountId);
            const positions = this.db
                .prepare(
                    `SELECT COUNT(*) AS n FROM account_investment
                     WHERE account_id = ? AND investment_id NOT LIKE 'CASH_%' AND quantity <> 0`
                )
                .get(accountId) as { n: number };
            if (positions.n > 0) {
                throw new PortfolioMaintainerError(
                    409,
                    `El perfil ${accountId} todavía tiene ${positions.n} posición(es); véndelas o elimínalas antes de borrarlo`
                );
            }
            const cash = this.readCash(accountId, account.base_currency);
            if (cash !== 0 && !force) {
                throw new PortfolioMaintainerError(
                    409,
                    `El perfil ${accountId} tiene ${cash.toFixed(2)} ${account.base_currency} en la billetera; confirma la eliminación para continuar`
                );
            }
            // The audit trail outlives the profile: detach its trade_log_entry rows (account_id is
            // nullable) and tag them, instead of deleting history or tripping the foreign key.
            this.db
                .prepare(
                    `UPDATE trade_log_entry
                     SET account_id = NULL,
                         notes = TRIM(COALESCE(notes, '') || ' [deleted profile: ' || ? || ']')
                     WHERE account_id = ?`
                )
                .run(accountId, accountId);
            this.db.prepare('DELETE FROM account_investment WHERE account_id = ?').run(accountId);
            this.db.prepare('DELETE FROM account WHERE account_id = ?').run(accountId);
        });
    }

    /** S4: per-profile transaction history (buys, sells, deposits, withdrawals),
     * newest first. `symbol` in SQL becomes `ticker` in JSON. */
    listTransactions(accountId: string, limit = 100, offset = 0): TransactionView[] {
        this.getAccountRow(accountId);
        return this.db
            .prepare(`
                SELECT t.entry_id, i.symbol, t.action, t.shares, t.price, t.total_cost, t.notes, t.logged_at
                FROM trade_log_entry t
                JOIN investment i ON i.investment_id = t.investment_id
                WHERE t.account_id = ?
                ORDER BY t.logged_at DESC, t.rowid DESC
                LIMIT ? OFFSET ?`)
            .all(accountId, limit, offset)
            .map((r: any) => ({
                entryId: r.entry_id,
                ticker: r.symbol,
                action: r.action,
                shares: r.shares ?? null,
                price: r.price ?? null,
                totalCost: r.total_cost ?? null,
                notes: r.notes ?? null,
                loggedAt: r.logged_at ?? null,
            }));
    }

    /** REQ-7: remove a position row (user-confirmed delete); cash unchanged. */
    deletePosition(accountId: string, rawTicker: string): void {
        this.transact(() => {
            const ticker = canonicalTicker(rawTicker);
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
    listPositions(): MarketPositionView[];
    listPositions(accountId?: string): PositionView[] | MarketPositionView[] {
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
                SELECT ai.account_id AS accountId, i.symbol AS ticker, ai.quantity, ai.average_cost, ai.currency,
                       ip.price, ip.fetched_at
                FROM account_investment ai
                JOIN investment i ON i.investment_id = ai.investment_id
                LEFT JOIN investment_price ip ON ip.investment_id = ai.investment_id
                WHERE i.symbol NOT LIKE 'CASH_%'
                ORDER BY ai.account_id, i.symbol`)
            .all()
            .map((r: any) => ({
                accountId: r.accountId,
                ticker: r.ticker,
                qty: r.quantity,
                avgCost: r.average_cost ?? null,
                currency: r.currency,
                // The stored market price only: an unpriced position reports null, never its cost.
                price: r.price ?? null,
                priceAsOf: r.fetched_at ?? null,
            }));
    }
}
