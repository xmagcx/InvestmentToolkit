/**
 * portfolioMaintainerProfiles.spec.ts — portfolio profiles, wallet movements,
 * transaction history and add-stock validation (specs S2–S5).
 *
 * Exercises the real Express stack over a tmp SQLite file built by the Python
 * migrator (never the real domain_model.sqlite). Every assertion goes through
 * the HTTP surface; the only direct database reads are independent ground-truth
 * counts on a separate read-only connection.
 */
import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildPortfolioMaintainerRoutes } from '../../src/routes/portfolioMaintainer';
import { PortfolioMaintainerService } from '../../src/services/PortfolioMaintainerService';
import { withRouter } from './helpers/testServer';

function newDbPath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pm-profiles-')), 'domain_model.sqlite');
}

function cleanup(dbPath: string): void {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
}

function readDb<T>(dbPath: string, fn: (db: Database.Database) => T): T {
    const db = new Database(dbPath, { readonly: true });
    try {
        return fn(db);
    } finally {
        db.close();
    }
}

function countRows(dbPath: string, table: string, where = ''): number {
    return readDb(dbPath, db => (db.prepare(`SELECT COUNT(*) AS n FROM ${table} ${where}`).get() as { n: number }).n);
}

describe('portfolio maintainer — profiles, wallet, history, add stock', () => {
    let dbPath: string;
    let svc: PortfolioMaintainerService;

    const run = (fn: (base: string) => Promise<void>) =>
        withRouter(buildPortfolioMaintainerRoutes(dbPath, svc), fn, '/api/portfolio-maintainer');

    const post = (base: string, url: string, body: unknown) =>
        fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

    beforeEach(() => {
        dbPath = newDbPath();
        svc = new PortfolioMaintainerService(dbPath);
    });

    afterEach(() => {
        svc.close();
        cleanup(dbPath);
    });

    // ── Positions carry the stored market price, never the cost as a stand-in ──

    it('GET /positions returns price null when unpriced and the stored investment_price when priced', async () => {
        await run(async base => {
            await post(base, '/api/portfolio-maintainer/accounts', { name: 'Precios' });
            const accounts = await (await fetch(`${base}/api/portfolio-maintainer/accounts`)).json();
            const id = accounts.find((a: any) => a.name === 'Precios').accountId;
            await post(base, `/api/portfolio-maintainer/accounts/${id}/cash/deposit`, { amount: 1000 });
            await post(base, '/api/portfolio-maintainer/transaction', { accountId: id, ticker: 'AAPL', side: 'BUY', qty: 2, price: 100 });
            await post(base, '/api/portfolio-maintainer/transaction', { accountId: id, ticker: 'MSFT', side: 'BUY', qty: 1, price: 300 });
            const w = new Database(dbPath);
            const msft = (w.prepare("SELECT investment_id FROM investment WHERE symbol = 'MSFT'").get() as any).investment_id;
            w.prepare("INSERT INTO investment_price (investment_id, price, currency, fetched_at) VALUES (?, 310.5, 'USD', '2026-10-30T20:00:00Z')").run(msft);
            w.close();
            const positions = await (await fetch(`${base}/api/portfolio-maintainer/positions`)).json();
            const byTicker = Object.fromEntries(positions.map((p: any) => [p.ticker, p]));
            expect(byTicker.AAPL.price).to.equal(null);
            expect(byTicker.AAPL.priceAsOf).to.equal(null);
            expect(byTicker.MSFT.price).to.equal(310.5);
            expect(byTicker.MSFT.priceAsOf).to.equal('2026-10-30T20:00:00Z');
            expect(byTicker.AAPL.avgCost).to.equal(100);
        });
    });

    it('S2: deleting a profile that has history keeps its audit rows (detached) instead of failing', async () => {
        await run(async base => {
            await post(base, '/api/portfolio-maintainer/accounts', { name: 'Con historial' });
            const id = 'Con historial';
            await post(base, `/api/portfolio-maintainer/accounts/${encodeURIComponent(id)}/cash/deposit`, { amount: 500 });
            await post(base, '/api/portfolio-maintainer/transaction', { accountId: id, ticker: 'AAPL', side: 'BUY', qty: 1, price: 100 });
            await post(base, '/api/portfolio-maintainer/transaction', { accountId: id, ticker: 'AAPL', side: 'SELL', qty: 1, price: 110 });
            const before = countRows(dbPath, 'trade_log_entry');
            expect(before).to.equal(3);
            const res = await fetch(`${base}/api/portfolio-maintainer/accounts/${encodeURIComponent(id)}?force=true`, { method: 'DELETE' });
            expect(res.status, await res.clone().text()).to.equal(200);
            expect(countRows(dbPath, 'account', `WHERE account_id = '${id}'`)).to.equal(0);
            expect(countRows(dbPath, 'account_investment', `WHERE account_id = '${id}'`)).to.equal(0);
            expect(countRows(dbPath, 'trade_log_entry')).to.equal(before);
            expect(countRows(dbPath, 'trade_log_entry', 'WHERE account_id IS NULL')).to.equal(3);
            const notes = readDb(dbPath, db => db.prepare('SELECT notes FROM trade_log_entry').all() as Array<{ notes: string }>);
            for (const n of notes) expect(n.notes).to.contain('[deleted profile: Con historial]');
        });
    });

    // ── S2: profiles ──────────────────────────────────────────────────────────

    it('S2: creates a profile from a free name alone (type PROFILE, currency USD)', async () => {
        await run(async base => {
            const res = await post(base, '/api/portfolio-maintainer/accounts', { name: 'Mi perfil' });
            expect(res.status).to.equal(200);
            const body = await res.json();
            expect(body.name).to.equal('Mi perfil');
            expect(body.type).to.equal('PROFILE');
            expect(body.currency).to.equal('USD');
            expect(body.cash).to.equal(0);
        });
    });

    it('S2: keeps creating typed accounts with their default currency (TFSA → CAD)', async () => {
        await run(async base => {
            const res = await post(base, '/api/portfolio-maintainer/accounts', { name: 'My TFSA', type: 'TFSA' });
            expect(res.status).to.equal(200);
            expect((await res.json()).currency).to.equal('CAD');
        });
    });

    it('S2: rejects a blank profile name and writes no account row', async () => {
        await run(async base => {
            const res = await post(base, '/api/portfolio-maintainer/accounts', { name: '   ' });
            expect(res.status).to.equal(400);
            expect(countRows(dbPath, 'account')).to.equal(0);
        });
    });

    it('S2: renames a profile through PATCH', async () => {
        svc.createAccount('Viejo', 'PROFILE');
        await run(async base => {
            const res = await fetch(`${base}/api/portfolio-maintainer/accounts/Viejo`, {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ name: 'Nuevo' }),
            });
            expect(res.status).to.equal(200);
            expect((await res.json()).name).to.equal('Nuevo');
        });
    });

    it('S2: refuses to delete a profile that still holds positions (409)', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        svc.setInitialCash('Perfil', 1000);
        svc.buy({ accountId: 'Perfil', ticker: 'AAPL', side: 'BUY', qty: 1, price: 10 });
        await run(async base => {
            const res = await fetch(`${base}/api/portfolio-maintainer/accounts/Perfil`, { method: 'DELETE' });
            expect(res.status).to.equal(409);
            expect((await res.json()).error).to.match(/posici[o\u00f3]n/i);
            expect(countRows(dbPath, 'account')).to.equal(1);
        });
    });

    it('S2: refuses to delete a profile holding cash unless forced, then deletes the CASH row too', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        svc.setInitialCash('Perfil', 250);
        await run(async base => {
            const refused = await fetch(`${base}/api/portfolio-maintainer/accounts/Perfil`, { method: 'DELETE' });
            expect(refused.status).to.equal(409);
            expect(countRows(dbPath, 'account')).to.equal(1);

            const forced = await fetch(`${base}/api/portfolio-maintainer/accounts/Perfil?force=true`, { method: 'DELETE' });
            expect(forced.status).to.equal(200);
            expect(countRows(dbPath, 'account')).to.equal(0);
            expect(countRows(dbPath, 'account_investment')).to.equal(0);
        });
    });

    it('S2: deletes an empty profile without force', async () => {
        svc.createAccount('Vacio', 'PROFILE');
        await run(async base => {
            const res = await fetch(`${base}/api/portfolio-maintainer/accounts/Vacio`, { method: 'DELETE' });
            expect(res.status).to.equal(200);
            expect(countRows(dbPath, 'account')).to.equal(0);
        });
    });

    // ── S3: wallet ────────────────────────────────────────────────────────────

    it('S3: deposit raises the wallet balance and logs one DEPOSIT entry', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        await run(async base => {
            const res = await post(base, '/api/portfolio-maintainer/accounts/Perfil/cash/deposit', { amount: 500, note: 'aporte' });
            expect(res.status).to.equal(200);
            expect((await res.json()).cash).to.equal(500);

            const logs = readDb(dbPath, db =>
                db.prepare('SELECT investment_id, action, total_cost, source, notes FROM trade_log_entry').all() as any[]
            );
            expect(logs).to.have.length(1);
            expect(logs[0].action).to.equal('DEPOSIT');
            expect(logs[0].investment_id).to.equal('CASH_USD');
            expect(logs[0].total_cost).to.equal(500);
            expect(logs[0].source).to.equal('portfolio-maintainer');
            expect(logs[0].notes).to.equal('aporte');
        });
    });

    it('S3: withdraw lowers the wallet balance and logs one WITHDRAW entry', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        svc.setInitialCash('Perfil', 500);
        await run(async base => {
            const res = await post(base, '/api/portfolio-maintainer/accounts/Perfil/cash/withdraw', { amount: 200 });
            expect(res.status).to.equal(200);
            expect((await res.json()).cash).to.equal(300);
            const logs = readDb(dbPath, db => db.prepare('SELECT action, total_cost FROM trade_log_entry').all() as any[]);
            expect(logs).to.have.length(1);
            expect(logs[0].action).to.equal('WITHDRAW');
            expect(logs[0].total_cost).to.equal(200);
        });
    });

    it('S3: rejects a withdrawal over the balance, leaving cash and the log unchanged', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        svc.setInitialCash('Perfil', 100);
        await run(async base => {
            const res = await post(base, '/api/portfolio-maintainer/accounts/Perfil/cash/withdraw', { amount: 101 });
            expect(res.status).to.equal(400);
            expect(svc.getAccountCash('Perfil')).to.equal(100);
            expect(countRows(dbPath, 'trade_log_entry')).to.equal(0);
        });
    });

    it('S3: rejects a non-positive movement amount', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        await run(async base => {
            for (const amount of [0, -5]) {
                const res = await post(base, '/api/portfolio-maintainer/accounts/Perfil/cash/deposit', { amount });
                expect(res.status).to.equal(400);
            }
            expect(svc.getAccountCash('Perfil')).to.equal(0);
            expect(countRows(dbPath, 'trade_log_entry')).to.equal(0);
        });
    });

    it('S3 (preserve): the initial-cash endpoint still sets the balance', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        await run(async base => {
            const res = await post(base, '/api/portfolio-maintainer/accounts/Perfil/cash', { amount: 1700 });
            expect(res.status).to.equal(200);
            expect((await res.json()).cash).to.equal(1700);
            expect(countRows(dbPath, 'trade_log_entry')).to.equal(0);
        });
    });

    // ── S4: history ───────────────────────────────────────────────────────────

    it('S4: returns buys, sells, deposits and withdrawals newest first with ticker in JSON', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        svc.deposit('Perfil', 1000);
        svc.buy({ accountId: 'Perfil', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50 });
        svc.sell({ accountId: 'Perfil', ticker: 'AAPL', side: 'SELL', qty: 1, price: 60 });
        svc.withdraw('Perfil', 10);
        await run(async base => {
            const res = await fetch(`${base}/api/portfolio-maintainer/accounts/Perfil/transactions`);
            expect(res.status).to.equal(200);
            const rows = await res.json();
            expect(rows.map((r: any) => r.action)).to.deep.equal(['WITHDRAW', 'SELL', 'BUY', 'DEPOSIT']);
            expect(rows.map((r: any) => r.ticker)).to.deep.equal(['CASH_USD', 'AAPL', 'AAPL', 'CASH_USD']);
            expect(rows[0]).to.not.have.property('symbol');
            expect(rows[1].shares).to.equal(1);
            expect(rows[1].price).to.equal(60);
        });
    });

    it('S4: honours limit and offset', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        svc.deposit('Perfil', 100);
        svc.deposit('Perfil', 200);
        svc.deposit('Perfil', 300);
        await run(async base => {
            const res = await fetch(`${base}/api/portfolio-maintainer/accounts/Perfil/transactions?limit=1&offset=1`);
            const rows = await res.json();
            expect(rows).to.have.length(1);
            expect(rows[0].totalCost).to.equal(200);
        });
    });

    // ── S5: add stock ─────────────────────────────────────────────────────────

    it('S5: a buy normalizes the ticker and creates the investment row in the profile currency', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        svc.setInitialCash('Perfil', 1000);
        await run(async base => {
            const res = await post(base, '/api/portfolio-maintainer/transaction', {
                accountId: 'Perfil', ticker: 'psu.u', side: 'BUY', qty: 2, price: 10,
            });
            expect(res.status).to.equal(200);
            expect((await res.json()).position.ticker).to.equal('PSU-U.TO');
            const inv = readDb(dbPath, db =>
                db.prepare('SELECT symbol, asset_class, currency FROM investment WHERE symbol = ?').get('PSU-U.TO') as any
            );
            expect(inv.asset_class).to.equal('EQUITY');
            expect(inv.currency).to.equal('USD');
        });
    });

    it('S5: rejects an invalid ticker and writes nothing', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        svc.setInitialCash('Perfil', 1000);
        await run(async base => {
            for (const ticker of ['', '   ', 'not a ticker!']) {
                const res = await post(base, '/api/portfolio-maintainer/transaction', {
                    accountId: 'Perfil', ticker, side: 'BUY', qty: 1, price: 10,
                });
                expect(res.status, `ticker=${ticker}`).to.equal(400);
            }
            expect(countRows(dbPath, 'investment', "WHERE symbol NOT LIKE 'CASH_%'")).to.equal(0);
            expect(countRows(dbPath, 'trade_log_entry')).to.equal(0);
            expect(svc.getAccountCash('Perfil')).to.equal(1000);
        });
    });

    it('S5: rejects non-positive qty or price and leaves the database unchanged', async () => {
        svc.createAccount('Perfil', 'PROFILE');
        svc.setInitialCash('Perfil', 1000);
        await run(async base => {
            for (const body of [
                { qty: 0, price: 10 },
                { qty: -1, price: 10 },
                { qty: 1, price: 0 },
                { qty: 1, price: -3 },
            ]) {
                const res = await post(base, '/api/portfolio-maintainer/transaction', {
                    accountId: 'Perfil', ticker: 'AAPL', side: 'BUY', ...body,
                });
                expect(res.status, JSON.stringify(body)).to.equal(400);
            }
            expect(countRows(dbPath, 'account_investment', "WHERE investment_id = 'AAPL'")).to.equal(0);
            expect(countRows(dbPath, 'trade_log_entry')).to.equal(0);
            expect(svc.getAccountCash('Perfil')).to.equal(1000);
        });
    });
});
