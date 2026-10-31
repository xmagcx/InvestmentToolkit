/**
 * portfolioMaintainer.spec.ts — RED phase tests for routes/portfolioMaintainer.ts
 * (Phase 2, task 2.1).
 *
 * Exercises the route handlers directly with a real tmp SQLite (never the real
 * domain_model.sqlite), mirroring universe.spec.ts's mock-req/res pattern. Each
 * handler receives a `PortfolioMaintainerService` built over that tmp db.
 *
 * Acceptance criteria: REQ-1 (avg cost), REQ-2 (sell keeps avg / oversell /
 * full exit deletes row), REQ-3 (cash per account / overspend), REQ-4 (account
 * management + default currency + initial cash), REQ-5 (audit trail / rejected
 * not logged), REQ-6 (USD cash sell no FX), REQ-7 (position removal).
 */
import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildPortfolioMaintainerRoutes } from '../../src/routes/portfolioMaintainer';
import { PortfolioMaintainerService } from '../../src/services/PortfolioMaintainerService';

/** Minimal mock Express `res` capturing status/json. */
function mockRes() {
    const res: any = {
        statusCode: 200,
        body: null,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: any) { this.body = payload; return this; },
    };
    return res;
}

/** Minimal mock Express `req`. */
function mockReq(overrides: any = {}) {
    return { params: {}, body: {}, ...overrides } as any;
}

function newDbPath(): string {
    return path.join(os.tmpdir(), `pm-routes-${Date.now()}-${Math.random()}.sqlite`);
}

function cleanup(dbPath: string) {
    for (const s of ['', '-wal', '-shm']) {
        const p = dbPath + s;
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
}

function countRows(dbPath: string, table: string, where = ''): number {
    const db = new Database(dbPath, { readonly: true });
    try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number };
        return row.n;
    } finally {
        db.close();
    }
}

/** Build a router over a shared service over the tmp db, then extract handlers. */
function setup(dbPath: string) {
    const service = new PortfolioMaintainerService(dbPath);
    const router = buildPortfolioMaintainerRoutes(dbPath, service);
    const handlers: Record<string, any> = {};
    for (const layer of (router as any).stack || []) {
        const method = Object.keys(layer.route?.methods || {})[0];
        const p = layer.route?.path;
        if (method && p) handlers[`${method.toUpperCase()} ${p}`] = layer.route.stack[0].handle;
    }
    return { dbPath, service, handlers };
}

describe('routes/portfolioMaintainer.ts', () => {
    let dbPath: string;
    let svc: PortfolioMaintainerService;
    let handlers: Record<string, any>;

    beforeEach(() => {
        const s = setup(newDbPath());
        dbPath = s.dbPath;
        svc = s.service;
        handlers = s.handlers;
    });

    afterEach(() => {
        svc.close();
        cleanup(dbPath);
    });

    it('REQ-4 S1: POST /accounts creates a TFSA account defaulting to CAD', () => {
        const res = mockRes();
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), res, svc);
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.deep.include({ name: 'TFSA One', type: 'TFSA', currency: 'CAD', cash: 0 });
    });

    it('REQ-4 S2: POST /accounts/:id/cash sets initial cash → CASH_CAD 5000', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        const res = mockRes();
        handlers['POST /accounts/:id/cash'](mockReq({ params: { id: 'TFSA One' }, body: { amount: 5000 } }), res, svc);
        expect(res.statusCode).to.equal(200);
        expect(res.body.cash).to.equal(5000);
        // ground truth: CASH_CAD row quantity = 5000
        expect(countRows(dbPath, 'account_investment', "WHERE investment_id = 'CASH_CAD' AND quantity = 5000")).to.equal(1);
    });

    it('REQ-1/REQ-3: POST /transaction buy returns position, cash, currency', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        handlers['POST /accounts/:id/cash'](mockReq({ params: { id: 'TFSA One' }, body: { amount: 1000 } }), mockRes(), svc);
        const res = mockRes();
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 },
        }), res, svc);
        expect(res.statusCode).to.equal(200);
        expect(res.body.position).to.deep.equal({ ticker: 'AAPL', qty: 2, avgCost: 55 });
        expect(res.body.cash).to.equal(890);
        expect(res.body.currency).to.equal('CAD');
    });

    it('REQ-2 S3: sell full exit deletes the row and returns cash', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        handlers['POST /accounts/:id/cash'](mockReq({ params: { id: 'TFSA One' }, body: { amount: 1000 } }), mockRes(), svc);
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 3, price: 50, commission: 0 },
        }), mockRes(), svc);
        const res = mockRes();
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'TFSA One', ticker: 'AAPL', side: 'SELL', qty: 3, price: 60, commission: 5 },
        }), res, svc);
        expect(res.statusCode).to.equal(200);
        expect(res.body.position).to.equal(null); // full exit
        expect(countRows(dbPath, 'account_investment', "WHERE investment_id = 'AAPL'")).to.equal(0);
        // cash: 1000 - 150 (buy) + (3*60-5) = 850 + 175 = 1025
        expect(res.body.cash).to.equal(1025);
        expect(res.body.currency).to.equal('CAD');
    });

    it('REQ-3 S2 / REQ-5 S2: overspend rejected → 400, no trade_log', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        handlers['POST /accounts/:id/cash'](mockReq({ params: { id: 'TFSA One' }, body: { amount: 50 } }), mockRes(), svc);
        const res = mockRes();
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 }, // cost 110 > 50
        }), res, svc);
        expect(res.statusCode).to.equal(400);
        expect(res.body.error).to.exist;
        expect(countRows(dbPath, 'trade_log_entry')).to.equal(0);
    });

    it('REQ-2 S2: oversell rejected → 400, position unchanged, no SELL logged', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        handlers['POST /accounts/:id/cash'](mockReq({ params: { id: 'TFSA One' }, body: { amount: 10000 } }), mockRes(), svc);
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'TFSA One', ticker: 'MSFT', side: 'BUY', qty: 5, price: 20, commission: 0 },
        }), mockRes(), svc);
        const res = mockRes();
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'TFSA One', ticker: 'MSFT', side: 'SELL', qty: 6, price: 20, commission: 0 },
        }), res, svc);
        expect(res.statusCode).to.equal(400);
        expect(res.body.error).to.exist;
        expect(countRows(dbPath, 'account_investment', "WHERE investment_id = 'MSFT' AND quantity = 5")).to.equal(1);
        expect(countRows(dbPath, 'trade_log_entry', "WHERE action = 'SELL'")).to.equal(0);
    });

    it('REQ-6 S3: USD CASH account sell keeps cash in USD (no FX)', () => {
        // CASH defaults to USD
        handlers['POST /accounts'](mockReq({ body: { name: 'Cash One', type: 'CASH' } }), mockRes(), svc);
        handlers['POST /accounts/:id/cash'](mockReq({ params: { id: 'Cash One' }, body: { amount: 5000 } }), mockRes(), svc);
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'Cash One', ticker: 'VOO', side: 'BUY', qty: 1, price: 400, commission: 0 },
        }), mockRes(), svc);
        const res = mockRes();
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'Cash One', ticker: 'VOO', side: 'SELL', qty: 1, price: 495, commission: 5 },
        }), res, svc);
        expect(res.statusCode).to.equal(200);
        expect(res.body.currency).to.equal('USD');
        // 4600 + (495-5) = 5090
        expect(res.body.cash).to.equal(5090);
    });

    it('GET /accounts lists created accounts with cash', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        handlers['POST /accounts/:id/cash'](mockReq({ params: { id: 'TFSA One' }, body: { amount: 5000 } }), mockRes(), svc);
        const res = mockRes();
        handlers['GET /accounts'](mockReq(), res, svc);
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.have.length(1);
        expect(res.body[0]).to.deep.include({ accountId: 'TFSA One', type: 'TFSA', currency: 'CAD', cash: 5000 });
    });

    it('GET /positions lists positions', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        handlers['POST /accounts/:id/cash'](mockReq({ params: { id: 'TFSA One' }, body: { amount: 1000 } }), mockRes(), svc);
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 },
        }), mockRes(), svc);
        const res = mockRes();
        handlers['GET /positions'](mockReq(), res, svc);
        expect(res.statusCode).to.equal(200);
        const aapl = res.body.find((p: any) => p.ticker === 'AAPL');
        expect(aapl).to.deep.include({ accountId: 'TFSA One', qty: 2, avgCost: 55, currency: 'CAD' });
    });

    it('PATCH /accounts/:id updates the account currency', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        const res = mockRes();
        handlers['PATCH /accounts/:id'](mockReq({ params: { id: 'TFSA One' }, body: { currency: 'USD' } }), res, svc);
        expect(res.statusCode).to.equal(200);
        expect(res.body.currency).to.equal('USD');
    });

    it('REQ-7: DELETE /position/:account/:ticker removes the position row', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        handlers['POST /accounts/:id/cash'](mockReq({ params: { id: 'TFSA One' }, body: { amount: 1000 } }), mockRes(), svc);
        handlers['POST /transaction'](mockReq({
            body: { accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 0 },
        }), mockRes(), svc);
        const res = mockRes();
        handlers['DELETE /position/:account/:ticker'](mockReq({ params: { account: 'TFSA One', ticker: 'AAPL' } }), res, svc);
        expect(res.statusCode).to.equal(200);
        expect(res.body).to.deep.equal({ deleted: 'AAPL' });
        expect(countRows(dbPath, 'account_investment', "WHERE investment_id = 'AAPL'")).to.equal(0);
    });

    it('404 when deleting a position that does not exist', () => {
        handlers['POST /accounts'](mockReq({ body: { name: 'TFSA One', type: 'TFSA' } }), mockRes(), svc);
        const res = mockRes();
        handlers['DELETE /position/:account/:ticker'](mockReq({ params: { account: 'TFSA One', ticker: 'ZZZZ' } }), res, svc);
        expect(res.statusCode).to.equal(404);
        expect(res.body.error).to.exist;
    });
});
