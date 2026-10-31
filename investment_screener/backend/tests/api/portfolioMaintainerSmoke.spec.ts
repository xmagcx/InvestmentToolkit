/**
 * pm_smoke.spec.ts — Phase 4.2 manual smoke: full lifecycle on a fresh SQLite db
 * mimicking the real domain_model.sqlite schema (account, initial cash, buy,
 * sell, full exit, trade_log rows, cash invariant, overspend reject).
 */
import { expect } from 'chai';
import Database from 'better-sqlite3';
import fs from 'fs';
import { PortfolioMaintainerService } from '../../src/services/PortfolioMaintainerService';

describe('PortfolioMaintainer smoke (Phase 4.2)', () => {
    const dbPath = `/tmp/pm_smoke_${Date.now()}.sqlite`;

    it('runs account→cash→buy→sell→exit lifecycle with trade_log + cash invariant', () => {
        const svc = new PortfolioMaintainerService(dbPath);
        const db = new Database(dbPath);

        // 1. create TFSA account defaults CAD
        const acct = svc.createAccount('TFSA One', 'TFSA');
        expect(acct.type).eq('TFSA');
        expect(acct.currency).eq('CAD');

        // 2. set initial cash -> CASH_CAD 5000
        svc.setInitialCash('TFSA One', 5000);
        const cashRow = svc.listPositions('TFSA One').find((p) => p.ticker === 'CASH_CAD');
        expect(cashRow!.qty).eq(5000);

        // 3. buy 2 AAPL @ 50, commission 10 -> avg cost 55, cash 4890
        const buy = svc.buy({ accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 });
        expect(buy.position!.avgCost).eq(55);
        expect(buy.cash).eq(4890);

        // 4. weighted sub-buy 1 @ 56.67 -> (110 + 56.67)/3 = 55.55666...
        const buy2 = svc.buy({ accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 1, price: 56.67, commission: 0 });
        expect(buy2.position!.avgCost!.toFixed(2)).eq('55.56');

        // 5. partial sell keeps avg, cash +60
        const sell = svc.sell({ accountId: 'TFSA One', ticker: 'AAPL', side: 'SELL', qty: 1, price: 60, commission: 0 });
        expect(sell.position!.qty).eq(2);
        expect(sell.position!.avgCost!.toFixed(2)).eq('55.56');
        expect(sell.cash).closeTo(4893.33, 0.01);

        // 6. full exit -> position removed, cash += 120
        const exit = svc.sell({ accountId: 'TFSA One', ticker: 'AAPL', side: 'SELL', qty: 2, price: 60, commission: 0 });
        expect(exit.position).eq(null);

        // 7. cash invariant: starting 5000 -110 -56.67 +60 +120 = 5013.33
        const cashPos = svc.listPositions('TFSA One').find((p) => p.ticker === 'CASH_CAD');
        expect(cashPos!.qty).closeTo(5013.33, 0.01);

        // 8. trade_log entries: 4 trades (buy, buy2, sell, exit); initial cash is not logged
        const logs = db.prepare('SELECT action, total_cost FROM trade_log_entry ORDER BY logged_at').all() as { action: string; total_cost: number }[];
        expect(logs.map((l) => l.action)).deep.equals(['BUY', 'BUY', 'SELL', 'SELL']);
        expect(logs[0].total_cost).eq(110);

        // 9. overspend rejected, no trade_log written
        const before = (db.prepare('SELECT COUNT(*) c FROM trade_log_entry').get() as { c: number }).c;
        expect(() => svc.buy({ accountId: 'TFSA One', ticker: 'NFLX', side: 'BUY', qty: 1000, price: 1000, commission: 0 })).throws();
        const after = (db.prepare('SELECT COUNT(*) c FROM trade_log_entry').get() as { c: number }).c;
        expect(after).eq(before);

        db.close();
        fs.unlinkSync(dbPath);
    });
});
