/**
 * portfolioMaintainer.ts - Express routing for manual portfolio buy/sell + cash.
 *
 * Purpose:
 *   Routes behind `/api/portfolio-maintainer` exposing the manual web entry +
 *   maintenance paths on `domain_model.sqlite` (the broker-sync replacement).
 *   A thin presentation layer over `PortfolioMaintainerService`, which owns ONE
 *   better-sqlite3 connection and wraps every write in a single transaction.
 *   The factory builds one shared service for the router's lifetime (never a
 *   fresh connection per request — that would defeat the service's single-writer
 *   serialization).
 *
 * Layer:
 *   Backend / Routes / Portfolio Maintainer
 *
 * Routes Index:
 *   - GET    /accounts              - List accounts with per-account cash
 *   - POST   /accounts              - Create a profile/account (type-defaulted currency)
 *   - PATCH  /accounts/:id          - Update account name/currency
 *   - DELETE /accounts/:id[?force=true] - Delete a profile (409 with positions / cash)
 *   - POST   /accounts/:id/cash     - Set initial cash → CASH_<cur> row
 *   - POST   /accounts/:id/cash/deposit   - Wallet deposit (logged)
 *   - POST   /accounts/:id/cash/withdraw  - Wallet withdrawal (logged, no overdraw)
 *   - GET    /accounts/:id/transactions   - Per-profile history, newest first
 *   - GET    /positions             - List all positions (accountId, ticker, qty, avgCost, currency)
 *   - POST   /transaction           - Record a buy/sell (weighted-avg cost + cash)
 *   - DELETE /position/:account/:ticker - Remove a position row (REQ-7)
 *
 * Key Input Dependencies:
 *   - ../services/PortfolioMaintainerService (single-connection transaction owner)
 *   - ../utils/paths#DOMAIN_MODEL_DB_FILE
 */
import express from 'express';
import { PortfolioMaintainerService, PortfolioMaintainerError, AccountType } from '../services/PortfolioMaintainerService';
import { DOMAIN_MODEL_DB_FILE } from '../utils/paths';

/** Handle GET /accounts — list accounts with per-account cash. */
export function handleListAccounts(
    _req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService
): void {
    res.status(200).json(service.listAccounts());
}

/** Handle POST /accounts — create an account; type-defaulted currency. */
export function handleCreateAccount(
    req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService
): void {
    const { name, type, currency } = req.body ?? {};
    if (typeof name !== 'string' || name.trim() === '') {
        res.status(400).json({ error: 'Account name is required' });
        return;
    }
    // S2: a profile is just a named account; the type is optional and defaults to PROFILE.
    const resolvedType = type == null || type === '' ? 'PROFILE' : type;
    if (!['TFSA', 'RRSP', 'CASH', 'PROFILE'].includes(resolvedType)) {
        res.status(400).json({ error: 'Account type must be one of: TFSA, RRSP, CASH, PROFILE' });
        return;
    }
    try {
        res.status(200).json(service.createAccount(name.trim(), resolvedType as AccountType, currency));
    } catch (err) {
        respondError(res, err);
    }
}

/** Handle PATCH /accounts/:id — update account name/currency. */
export function handleUpdateAccount(
    req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService
): void {
    const accountId = req.params.id;
    const { name, currency } = req.body ?? {};
    try {
        const account = service.updateAccount(accountId, { name, currency });
        res.status(200).json(account);
    } catch (err) {
        respondError(res, err);
    }
}

/** Handle POST /accounts/:id/cash — set initial cash → CASH_<cur> row. */
export function handleSetInitialCash(
    req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService
): void {
    const accountId = req.params.id;
    const amount = Number(req.body?.amount);
    if (!Number.isFinite(amount) || amount < 0) {
        res.status(400).json({ error: 'Cash amount must be a non-negative number' });
        return;
    }
    try {
        service.setInitialCash(accountId, amount);
        const cash = service.getAccountCash(accountId);
        res.status(200).json({ accountId, cash });
    } catch (err) {
        respondError(res, err);
    }
}

/** Handle GET /positions — list all positions (accountId, ticker, qty, avgCost, currency). */
export function handleListPositions(
    _req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService
): void {
    res.status(200).json(service.listPositions());
}

/** Handle POST /transaction — record a buy/sell. */
export function handleTransaction(
    req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService
): void {
    const { accountId, ticker, side, qty, price, commission } = req.body ?? {};
    if (typeof accountId !== 'string' || accountId.trim() === '') {
        res.status(400).json({ error: 'accountId is required' });
        return;
    }
    if (typeof ticker !== 'string' || ticker.trim() === '') {
        res.status(400).json({ error: 'ticker is required' });
        return;
    }
    if (side !== 'BUY' && side !== 'SELL') {
        res.status(400).json({ error: 'side must be BUY or SELL' });
        return;
    }
    const q = Number(qty);
    const pr = Number(price);
    if (!Number.isFinite(q) || q <= 0) {
        res.status(400).json({ error: 'qty must be a positive number' });
        return;
    }
    if (!Number.isFinite(pr) || pr <= 0) {
        res.status(400).json({ error: 'price must be a positive number' });
        return;
    }
    const comm = commission == null || commission === '' ? 0 : Number(commission);
    if (!Number.isFinite(comm) || comm < 0) {
        res.status(400).json({ error: 'commission must be a non-negative number' });
        return;
    }
    try {
        const result = side === 'BUY'
            ? service.buy({ accountId: accountId.trim(), ticker, side: 'BUY', qty: q, price: pr, commission: comm })
            : service.sell({ accountId: accountId.trim(), ticker, side: 'SELL', qty: q, price: pr, commission: comm });
        res.status(200).json(result);
    } catch (err) {
        respondError(res, err);
    }
}

/** Handle DELETE /position/:account/:ticker — remove a position row. */
export function handleDeletePosition(
    req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService
): void {
    const { account, ticker } = req.params;
    try {
        service.deletePosition(account, ticker);
        res.status(200).json({ deleted: ticker });
    } catch (err) {
        respondError(res, err);
    }
}

/** Handle DELETE /accounts/:id — delete a profile; `?force=true` confirms a
 * non-zero wallet balance. 409 while the profile holds positions. */
export function handleDeleteAccount(
    req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService
): void {
    const accountId = req.params.id;
    const force = String(req.query.force ?? '').toLowerCase() === 'true';
    try {
        service.deleteAccount(accountId, force);
        res.status(200).json({ deleted: accountId });
    } catch (err) {
        respondError(res, err);
    }
}

/** Handle POST /accounts/:id/cash/deposit|withdraw — one logged wallet movement. */
export function handleCashMovement(
    req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService,
    action: 'DEPOSIT' | 'WITHDRAW'
): void {
    const accountId = req.params.id;
    const amount = Number(req.body?.amount);
    const note = typeof req.body?.note === 'string' && req.body.note.trim() !== '' ? req.body.note.trim() : undefined;
    if (!Number.isFinite(amount) || amount <= 0) {
        res.status(400).json({ error: 'Amount must be a positive number' });
        return;
    }
    try {
        const result = action === 'DEPOSIT'
            ? service.deposit(accountId, amount, note)
            : service.withdraw(accountId, amount, note);
        res.status(200).json({ accountId, ...result });
    } catch (err) {
        respondError(res, err);
    }
}

/** Handle GET /accounts/:id/transactions — paged history, newest first. */
export function handleListTransactions(
    req: express.Request,
    res: express.Response,
    service: PortfolioMaintainerService
): void {
    const accountId = req.params.id;
    const limit = req.query.limit == null ? 100 : Number(req.query.limit);
    const offset = req.query.offset == null ? 0 : Number(req.query.offset);
    if (!Number.isInteger(limit) || limit <= 0 || limit > 1000) {
        res.status(400).json({ error: 'limit must be an integer between 1 and 1000' });
        return;
    }
    if (!Number.isInteger(offset) || offset < 0) {
        res.status(400).json({ error: 'offset must be a non-negative integer' });
        return;
    }
    try {
        res.status(200).json(service.listTransactions(accountId, limit, offset));
    } catch (err) {
        respondError(res, err);
    }
}

/** Map a PortfolioMaintainerError to its HTTP status; otherwise 500. */
function respondError(res: express.Response, err: unknown): void {
    if (err instanceof PortfolioMaintainerError) {
        res.status(err.status).json({ error: err.message });
        return;
    }
    res.status(500).json({ error: err instanceof Error ? err.message : 'Internal error' });
}

/**
 * Build the express Router. `dbPath` and an optional shared `service` are
 * injectable for tests; when absent the factory creates and owns one service
 * over `dbPath`.
 */
export function buildPortfolioMaintainerRoutes(
    dbPath: string = DOMAIN_MODEL_DB_FILE,
    service?: PortfolioMaintainerService
): express.Router {
    // Lazy: the real database is opened on first request, never at import time
    // (importing the app must not touch data/domain_model.sqlite).
    let owned: PortfolioMaintainerService | undefined = service;
    const svc = (): PortfolioMaintainerService => (owned ??= new PortfolioMaintainerService(dbPath));
    const router = express.Router();

    router.get('/accounts', (req, res) => handleListAccounts(req, res, svc()));
    router.post('/accounts', (req, res) => handleCreateAccount(req, res, svc()));
    router.patch('/accounts/:id', (req, res) => handleUpdateAccount(req, res, svc()));
    router.delete('/accounts/:id', (req, res) => handleDeleteAccount(req, res, svc()));
    router.post('/accounts/:id/cash', (req, res) => handleSetInitialCash(req, res, svc()));
    router.post('/accounts/:id/cash/deposit', (req, res) => handleCashMovement(req, res, svc(), 'DEPOSIT'));
    router.post('/accounts/:id/cash/withdraw', (req, res) => handleCashMovement(req, res, svc(), 'WITHDRAW'));
    router.get('/accounts/:id/transactions', (req, res) => handleListTransactions(req, res, svc()));
    router.get('/positions', (req, res) => handleListPositions(req, res, svc()));
    router.post('/transaction', (req, res) => handleTransaction(req, res, svc()));
    router.delete('/position/:account/:ticker', (req, res) => handleDeletePosition(req, res, svc()));

    return router;
}

/** Default singleton bound to the real DB file. */
const portfolioMaintainerRouter = buildPortfolioMaintainerRoutes();
export default portfolioMaintainerRouter;
