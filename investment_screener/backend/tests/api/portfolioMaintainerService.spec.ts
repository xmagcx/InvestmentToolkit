/**
 * portfolioMaintainerService.spec.ts — RED phase tests for
 * `services/PortfolioMaintainerService.ts` (Phase 1, tasks 1.3/1.5/1.6/1.7).
 *
 * Exercises the service's full write path against a real tmp SQLite database
 * (never the real domain_model.sqlite): read → recompute → upsert inside one
 * `db.transaction()`, synthetic CASH_<cur> rows, full-exit DELETE, and the
 * `trade_log_entry` audit write. Mirrors universe.spec.ts's real-DB pattern.
 *
 * Acceptance criteria: REQ-1 (avg cost), REQ-2 (sell keeps avg / oversell /
 * full exit), REQ-3 (cash per account / overspend), REQ-4 (accounts + initial
 * cash), REQ-5 (audit trail), REQ-6 (currency isolation), REQ-7 (position
 * removal via sell full-exit).
 */
import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { PortfolioMaintainerService } from '../../src/services/PortfolioMaintainerService';

function newDbPath(): string {
    return path.join(os.tmpdir(), `pm-service-${Date.now()}-${Math.random()}.sqlite`);
}

function cleanup(dbPath: string) {
    for (const s of ['', '-wal', '-shm']) {
        const p = dbPath + s;
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
}

/** Shared tmp-row count helper (independent ground truth, separate connection). */
function countRows(dbPath: string, table: string, where = ''): number {
    const db = new Database(dbPath, { readonly: true });
    try {
        const row = db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number };
        return row.n;
    } finally {
        db.close();
    }
}

describe('PortfolioMaintainerService', () => {
    let dbPath: string;
    let svc: PortfolioMaintainerService;

    beforeEach(() => {
        dbPath = newDbPath();
        svc = new PortfolioMaintainerService(dbPath);
    });

    afterEach(() => {
        svc.close();
        cleanup(dbPath);
    });

    // REQ-4 S1: create TFSA account → base currency CAD
    it('REQ-4 S1: createAccount TFSA defaults base currency CAD', () => {
        const acct = svc.createAccount('My TFSA', 'TFSA');
        expect(acct.currency).to.equal('CAD');
    });

    // REQ-4 S2: set initial cash → CASH_<cur> row quantity = amount
    it('REQ-4 S2: setInitialCash creates CASH_CAD row with quantity = amount', () => {
        svc.createAccount('My TFSA', 'TFSA');
        svc.setInitialCash('My TFSA', 5000);
        const positions = svc.listPositions('My TFSA');
        const cash = positions.find(p => p.ticker === 'CASH_CAD');
        expect(cash).to.not.equal(undefined);
        expect(cash!.qty).to.equal(5000);
        expect(cash!.avgCost).to.equal(1);
    });

    // REQ-1 S1 + REQ-3 S1: first buy creates position + deducts cash
    it('REQ-1 S1 / REQ-3 S1: first buy creates position avg 55 and cash 1000→890', () => {
        svc.createAccount('My TFSA', 'TFSA');
        svc.setInitialCash('My TFSA', 1000);
        const view = svc.buy({ accountId: 'My TFSA', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 });
        expect(view.position!.qty).to.equal(2);
        expect(view.position!.avgCost).to.equal(55);
        expect(view.cash).to.equal(890);
    });

    // REQ-1 S2: subsequent buy weighted avg
    it('REQ-1 S2: subsequent buy weighted avg 56.67', () => {
        svc.createAccount('My TFSA', 'TFSA');
        svc.setInitialCash('My TFSA', 10000);
        svc.buy({ accountId: 'My TFSA', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 }); // 2@55
        const view = svc.buy({ accountId: 'My TFSA', ticker: 'AAPL', side: 'BUY', qty: 1, price: 60, commission: 0 });
        expect(view.position!.qty).to.equal(3);
        expect(view.position!.avgCost).to.be.closeTo(56.67, 0.01);
    });

    // REQ-2 S1 + REQ-3 S3: partial sell keeps avg, cash +115
    it('REQ-2 S1 / REQ-3 S3: partial sell keeps avg 20 and cash adds 115 (800→915)', () => {
        svc.createAccount('My TFSA', 'TFSA');
        svc.setInitialCash('My TFSA', 1000);
        svc.buy({ accountId: 'My TFSA', ticker: 'MSFT', side: 'BUY', qty: 10, price: 20, commission: 0 }); // 10@20
        const view = svc.sell({ accountId: 'My TFSA', ticker: 'MSFT', side: 'SELL', qty: 4, price: 30, commission: 5 });
        expect(view.position!.qty).to.equal(6);
        expect(view.position!.avgCost).to.equal(20);
        // buy spent 200 (1000->800); sell adds 4*30-5=115 (800->915)
        expect(view.cash).to.equal(915);
    });

    // REQ-2 S2: oversell rejected, no position change, no trade_log
    it('REQ-2 S2: oversell rejected with error, no position change, no trade_log', () => {
        svc.createAccount('My TFSA', 'TFSA');
        svc.setInitialCash('My TFSA', 10000);
        svc.buy({ accountId: 'My TFSA', ticker: 'MSFT', side: 'BUY', qty: 5, price: 20, commission: 0 });
        expect(() =>
            svc.sell({ accountId: 'My TFSA', ticker: 'MSFT', side: 'SELL', qty: 6, price: 20, commission: 0 })
        ).to.throw();
        // position unchanged at 5
        const pos = svc.listPositions('My TFSA').find(p => p.ticker === 'MSFT');
        expect(pos!.qty).to.equal(5);
        // the rejected sell writes NO SELL trade_log (the prior BUY's row is fine)
        expect(countRows(dbPath, 'trade_log_entry', "WHERE action = 'SELL'")).to.equal(0);
    });

    // REQ-3 S2: overspend rejected, no position/cash/trade_log change
    it('REQ-3 S2: overspend rejected with error, no writes, no trade_log', () => {
        svc.createAccount('My TFSA', 'TFSA');
        svc.setInitialCash('My TFSA', 50);
        expect(() =>
            svc.buy({ accountId: 'My TFSA', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 }) // cost 110 > 50
        ).to.throw();
        // only the pre-existing CASH_CAD row exists; NO equity position was written
        expect(countRows(dbPath, 'account_investment', "WHERE investment_id = 'AAPL'")).to.equal(0);
        // and the rejected op wrote NO trade_log
        expect(countRows(dbPath, 'trade_log_entry')).to.equal(0);
    });

    // REQ-2 S3: full exit deletes the row, cash updated
    it('REQ-2 S3: full exit deletes position row, cash adds proceeds - commission', () => {
        svc.createAccount('My TFSA', 'TFSA');
        svc.setInitialCash('My TFSA', 1000);
        svc.buy({ accountId: 'My TFSA', ticker: 'AAPL', side: 'BUY', qty: 3, price: 50, commission: 0 }); // 3@50, cash 850
        const view = svc.sell({ accountId: 'My TFSA', ticker: 'AAPL', side: 'SELL', qty: 3, price: 60, commission: 5 });
        expect(view.position).to.equal(null); // full exit returns null position
        // row deleted, no AAPL position remains
        expect(svc.listPositions('My TFSA').find(p => p.ticker === 'AAPL')).to.equal(undefined);
        // cash: 850 + (3*60 - 5) = 850 + 175 = 1025
        expect(view.cash).to.equal(1025);
    });

    // REQ-6 S3: CASH account USD cash sell — no FX conversion
    it('REQ-6 S3: USD cash account sell keeps cash in USD (no FX)', () => {
        svc.createAccount('My CASH', 'CASH'); // default USD
        svc.setInitialCash('My CASH', 5000);
        svc.buy({ accountId: 'My CASH', ticker: 'VOO', side: 'BUY', qty: 1, price: 400, commission: 0 }); // cash 4600
        const view = svc.sell({ accountId: 'My CASH', ticker: 'VOO', side: 'SELL', qty: 1, price: 495, commission: 5 });
        // 4600 + (495 - 5) = 5090 ; currency must be USD
        expect(view.cash).to.equal(5090);
        expect(view.currency).to.equal('USD');
    });

    // Delete position removes row, cash unchanged (REQ-7 S1)
    it('REQ-7 S1: deletePosition removes the row, cash unchanged', () => {
        svc.createAccount('My TFSA', 'TFSA');
        svc.setInitialCash('My TFSA', 1000);
        svc.buy({ accountId: 'My TFSA', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 0 }); // cash 900
        svc.deletePosition('My TFSA', 'AAPL');
        expect(svc.listPositions('My TFSA').find(p => p.ticker === 'AAPL')).to.equal(undefined);
        expect(svc.listPositions('My TFSA').find(p => p.ticker === 'CASH_CAD')!.qty).to.equal(900);
    });

    // REQ-5 S1: successful buy writes exactly one trade_log_entry
    it('REQ-5 S1: successful buy writes one trade_log_entry', () => {
        svc.createAccount('My TFSA', 'TFSA');
        svc.setInitialCash('My TFSA', 1000);
        svc.buy({ accountId: 'My TFSA', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 });
        expect(countRows(dbPath, 'trade_log_entry', "WHERE action = 'BUY'")).to.equal(1);
    });
});
