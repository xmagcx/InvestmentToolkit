/**
 * profilesSummary.spec.ts — GET /api/portfolio/profiles-summary (specs S1/S2).
 *
 * Each profile is reported in ITS base currency and the consolidated total in USD,
 * with the FX rates used. Exercises the real Express stack over a tmp SQLite file
 * built by the Python migrator (never the real domain_model.sqlite); the FX provider
 * is stubbed so no quote source is contacted.
 *
 * Layer: Backend / Tests / API
 * Usage: npm test -w backend
 */
import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildProfilesSummaryRouter } from '../../src/routes/profilesSummary';
import type { FxProvider } from '../../src/services/ProfileSummaryService';
import { PortfolioMaintainerService } from '../../src/services/PortfolioMaintainerService';
import { withRouter } from './helpers/testServer';

function newDbPath(): string {
    return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'profiles-summary-')), 'domain_model.sqlite');
}

function cleanup(dbPath: string): void {
    const dir = path.dirname(dbPath);
    for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
    fs.rmdirSync(dir);
}

const asOf = '2026-10-30T20:00:00Z';

/** Stub FX: fixed rates, and anything else reported unavailable. */
function stubFx(rates: Record<string, number>, unavailable: string[] = []): FxProvider {
    return {
        async rates(currencies: string[]) {
            const out: Record<string, { usdTo: number; source: string; asOf: string }> = {};
            const missing: string[] = [];
            for (const c of currencies) {
                if (c === 'USD') out[c] = { usdTo: 1, source: 'identity', asOf };
                else if (rates[c] != null && !unavailable.includes(c)) out[c] = { usdTo: rates[c], source: 'tradingview', asOf };
                else missing.push(c);
            }
            return { rates: out, unavailable: missing };
        },
    };
}

/** Write a stored market price for a symbol (the only way a position gets a value). */
function priceSymbol(dbPath: string, symbol: string, price: number, currency: string, fetchedAt = asOf): void {
    const db = new Database(dbPath);
    const investmentId = (db.prepare('SELECT investment_id FROM investment WHERE symbol = ?').get(symbol) as any).investment_id;
    db.prepare('INSERT INTO investment_price (investment_id, price, currency, fetched_at) VALUES (?, ?, ?, ?)')
        .run(investmentId, price, currency, fetchedAt);
    db.close();
}

describe('GET /api/portfolio/profiles-summary', () => {
    let dbPath: string;
    let svc: PortfolioMaintainerService;

    const get = (fx: FxProvider) =>
        new Promise<any>(resolve => {
            withRouter(buildProfilesSummaryRouter(dbPath, fx), async base => {
                const res = await fetch(`${base}/api/portfolio/profiles-summary`);
                resolve({ status: res.status, body: await res.json() });
            }, '/api/portfolio');
        });

    beforeEach(() => {
        dbPath = newDbPath();
        svc = new PortfolioMaintainerService(dbPath);
    });

    afterEach(() => {
        svc.close();
        cleanup(dbPath);
    });

    it('reports a USD profile in USD with its positions, cash and P/L', async () => {
        svc.createAccount('Racional', 'PROFILE', 'USD');
        svc.setInitialCash('Racional', 3700);
        svc.buy({ accountId: 'Racional', ticker: 'AAPL', side: 'BUY', qty: 10, price: 200 });
        priceSymbol(dbPath, 'AAPL', 229.35, 'USD');

        const { status, body } = await get(stubFx({}));
        expect(status).to.equal(200);
        expect(body.profiles).to.have.length(1);
        const p = body.profiles[0];
        expect(p.currency).to.equal('USD');
        expect(p.cash).to.equal(1700);
        expect(p.invested).to.equal(2000);
        expect(p.marketValue).to.be.closeTo(2293.5, 1e-6);
        expect(p.unrealizedPnl).to.be.closeTo(293.5, 1e-6);
        expect(p.unrealizedPnlPct).to.be.closeTo(14.675, 1e-6);
        expect(p.usdRate).to.equal(1);
        expect(p.valueUsd).to.be.closeTo(3993.5, 1e-6);
        expect(p.positions.map((x: any) => x.ticker)).to.deep.equal(['AAPL']);
        expect(p.positions[0]).to.include({ qty: 10, avgCost: 200, price: 229.35, priceCurrency: 'USD' });
        expect(body.totals.valueUsd).to.be.closeTo(3993.5, 1e-6);
        expect(body.totals.cashUsd).to.be.closeTo(1700, 1e-6);
        expect(body.totals.investedUsd).to.be.closeTo(2000, 1e-6);
        expect(body.totals.unrealizedPnlUsd).to.be.closeTo(293.5, 1e-6);
        expect(body.totals.partial).to.equal(false);
        expect(body.lastPriceAt).to.equal(asOf);
    });

    it('keeps a CLP profile in CLP and converts only its USD equivalent', async () => {
        svc.createAccount('Ahorro Chile', 'PROFILE', 'CLP');
        svc.setInitialCash('Ahorro Chile', 1_850_000);
        svc.buy({ accountId: 'Ahorro Chile', ticker: 'CHILE', side: 'BUY', qty: 3000, price: 100 });
        priceSymbol(dbPath, 'CHILE', 104.5, 'CLP');

        const { body } = await get(stubFx({ CLP: 948.2 }));
        const p = body.profiles[0];
        expect(p.currency).to.equal('CLP');
        expect(p.cash).to.equal(1_550_000);
        expect(p.marketValue).to.be.closeTo(313_500, 1e-6);
        expect(p.usdRate).to.equal(948.2);
        expect(p.valueUsd).to.be.closeTo((1_550_000 + 313_500) / 948.2, 1e-6);
        expect(body.fx).to.deep.equal([{ currency: 'CLP', usdTo: 948.2, source: 'tradingview', asOf }]);
        expect(body.totals.partial).to.equal(false);
    });

    it('converts a price quoted in another currency through USD', async () => {
        svc.createAccount('Ahorro Chile', 'PROFILE', 'CLP');
        svc.setInitialCash('Ahorro Chile', 1_000_000);
        svc.buy({ accountId: 'Ahorro Chile', ticker: 'AAPL', side: 'BUY', qty: 1, price: 190_000 });
        priceSymbol(dbPath, 'AAPL', 200, 'USD');

        const { body } = await get(stubFx({ CLP: 948.2 }));
        const p = body.profiles[0];
        expect(p.marketValue).to.be.closeTo(200 * 948.2, 1e-6);
        expect(p.positions[0].value).to.be.closeTo(200 * 948.2, 1e-6);
        expect(p.positions[0].priceCurrency).to.equal('USD');
    });

    it('excludes an unpriced ticker from value and P/L and lists it', async () => {
        svc.createAccount('Racional', 'PROFILE', 'USD');
        svc.setInitialCash('Racional', 5000);
        svc.buy({ accountId: 'Racional', ticker: 'AAPL', side: 'BUY', qty: 10, price: 200 });
        svc.buy({ accountId: 'Racional', ticker: 'CENCOSUD', side: 'BUY', qty: 2, price: 100 });
        priceSymbol(dbPath, 'AAPL', 210, 'USD');

        const { body } = await get(stubFx({}));
        const p = body.profiles[0];
        expect(p.marketValue).to.be.closeTo(2100, 1e-6);
        expect(p.invested).to.be.closeTo(2000, 1e-6);
        expect(p.unrealizedPnl).to.be.closeTo(100, 1e-6);
        expect(p.pricedCount).to.equal(1);
        expect(p.unpricedCount).to.equal(1);
        expect(p.unpricedTickers).to.deep.equal(['CENCOSUD']);
        const unpriced = p.positions.find((x: any) => x.ticker === 'CENCOSUD');
        expect(unpriced).to.include({ price: null, value: null, pnl: null, priceAsOf: null });
    });

    it('marks the total partial and the profile valueUsd null when FX is unavailable', async () => {
        svc.createAccount('Racional', 'PROFILE', 'USD');
        svc.setInitialCash('Racional', 1000);
        svc.createAccount('Ahorro Chile', 'PROFILE', 'CLP');
        svc.setInitialCash('Ahorro Chile', 500_000);

        const { body } = await get(stubFx({}, ['CLP']));
        const clp = body.profiles.find((p: any) => p.currency === 'CLP');
        const usd = body.profiles.find((p: any) => p.currency === 'USD');
        expect(clp.usdRate).to.equal(null);
        expect(clp.valueUsd).to.equal(null);
        expect(usd.valueUsd).to.be.closeTo(1000, 1e-6);
        expect(body.totals.valueUsd).to.be.closeTo(1000, 1e-6);
        expect(body.totals.partial).to.equal(true);
        expect(body.fxUnavailable).to.deep.equal(['CLP']);
    });

    it('never lists the synthetic CASH row as a position', async () => {
        svc.createAccount('Racional', 'PROFILE', 'USD');
        svc.setInitialCash('Racional', 2500);

        const { body } = await get(stubFx({}));
        const p = body.profiles[0];
        expect(p.positions).to.deep.equal([]);
        expect(p.cash).to.equal(2500);
        expect(p.marketValue).to.equal(0);
        expect(p.unrealizedPnlPct).to.equal(null);
    });

    it('returns an empty state (no profiles, zero totals) on an empty database', async () => {
        const { status, body } = await get(stubFx({}));
        expect(status).to.equal(200);
        expect(body.profiles).to.deep.equal([]);
        expect(body.totals.valueUsd).to.equal(0);
        expect(body.totals.partial).to.equal(false);
        expect(body.fx).to.deep.equal([]);
        expect(body.lastPriceAt).to.equal(null);
    });

    it('answers 500 with an error message when the FX provider throws', async () => {
        svc.createAccount('Racional', 'PROFILE', 'USD');
        const failing: FxProvider = { rates: async () => { throw new Error('fx_rates.py crashed'); } };

        const { status, body } = await get(failing);
        expect(status).to.equal(500);
        expect(body.error).to.be.a('string');
    });
});
