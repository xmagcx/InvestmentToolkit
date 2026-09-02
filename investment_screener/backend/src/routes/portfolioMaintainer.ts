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
 *   - POST   /accounts              - Create an account (type-defaulted currency)
 *   - PATCH  /accounts/:id          - Update account name/currency
 *   - POST   /accounts/:id/cash     - Set initial cash → CASH_<cur> row
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
    if (!['TFSA', 'RRSP', 'CASH'].includes(type)) {
        res.status(400).json({ error: 'Account type must be one of: TFSA, RRSP, CASH' });
        return;
    }
    res.status(200).json(service.createAccount(name.trim(), type as AccountType, currency));
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
    if (!Number.isFinite(pr) || pr < 0) {
        res.status(400).json({ error: 'price must be a non-negative number' });
        return;
    }
    const comm = commission == null || commission === '' ? 0 : Number(commission);
    if (!Number.isFinite(comm) || comm < 0) {
        res.status(400).json({ error: 'commission must be a non-negative number' });
        return;
    }
    try {
        const result = side === 'BUY'
            ? service.buy({ accountId: accountId.trim(), ticker: ticker.trim().toUpperCase(), side: 'BUY', qty: q, price: pr, commission: comm })
            : service.sell({ accountId: accountId.trim(), ticker: ticker.trim().toUpperCase(), side: 'SELL', qty: q, price: pr, commission: comm });
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
    const svc = service ?? new PortfolioMaintainerService(dbPath);
    const router = express.Router();

    router.get('/accounts', (req, res) => handleListAccounts(req, res, svc));
    router.post('/accounts', (req, res) => handleCreateAccount(req, res, svc));
    router.patch('/accounts/:id', (req, res) => handleUpdateAccount(req, res, svc));
    router.post('/accounts/:id/cash', (req, res) => handleSetInitialCash(req, res, svc));
    router.get('/positions', (req, res) => handleListPositions(req, res, svc));
    router.post('/transaction', (req, res) => handleTransaction(req, res, svc));
    router.delete('/position/:account/:ticker', (req, res) => handleDeletePosition(req, res, svc));

    return router;
}

/** Default singleton bound to the real DB file. */
const portfolioMaintainerRouter = buildPortfolioMaintainerRoutes();
export default portfolioMaintainerRouter;
