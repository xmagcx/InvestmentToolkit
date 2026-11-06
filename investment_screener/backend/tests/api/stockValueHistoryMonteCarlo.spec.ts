/**
 * stockValueHistoryMonteCarlo.spec.ts
 *
 * Purpose: GET /api/stock/:ticker/value-history and /montecarlo (Analysis page, S6/S13)
 * call the right Python script with normalized args, pass the payload through, and map
 * errors (no_projection / no_price -> 404, bad ticker/range -> 400).
 * Approach: stub bridge.spawnPythonScript (read at call time), serve the real router.
 */
import { expect } from 'chai';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import * as bridge from '../../src/services/bridge';
import stockRouter from '../../src/routes/stock';

describe('GET /stock/:ticker/value-history and /montecarlo', () => {
    const original = bridge.spawnPythonScript;
    let server: http.Server;
    let base: string;
    let called: { script: string; args: string[] } | null;

    before((done) => {
        const app = express();
        app.use('/api', stockRouter);
        server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`; done(); });
    });
    after((done) => { (bridge as any).spawnPythonScript = original; server.close(() => done()); });
    beforeEach(() => { called = null; });

    const stub = (result: any) => {
        (bridge as any).spawnPythonScript = async (script: string, args: string[]) => { called = { script, args }; return result; };
    };

    it('value-history passes the series through and defaults to 1y', async () => {
        const payload = { ticker: 'ZZZ', currency: 'USD', points: [{ date: '2024-01-02', price: 1, fair_value: null }], current: { price: 1, fair_value: null, date: '2024-01-02' } };
        stub(payload);
        const res = await fetch(`${base}/stock/zzz/value-history`);
        expect(res.status).to.equal(200);
        expect(await res.json()).to.deep.equal(payload);
        expect(called).to.deep.equal({ script: 'value_history.py', args: ['ZZZ', '--range', '1y'] });
    });

    it('value-history passes sma200, levels and the current zone/confirmation through unchanged', async () => {
        const payload = {
            ticker: 'ZZZ', currency: 'USD',
            points: [{ date: '2024-01-02', price: 90, fair_value: null, sma200: 100 }],
            current: {
                price: 90, fair_value: null, date: '2024-01-02', sma200: 100, zone: 'infravalorada', distance_pct: -10,
                confirmation: { price: 88, basis: 'Fibonacci 0.618', distance_pct: -2.22 },
            },
            levels: { supports: [{ price: 88, basis: 'Fibonacci 0.618' }], resistances: [{ price: 112, basis: 'EMA 200 días' }] },
        };
        stub(payload);
        const res = await fetch(`${base}/stock/ZZZ/value-history?range=1y`);
        expect(res.status).to.equal(200);
        expect(await res.json()).to.deep.equal(payload);
    });

    it('value-history forwards a valid range and rejects an invalid one', async () => {
        stub({ ticker: 'ZZZ', currency: 'USD', points: [], current: { price: null, fair_value: null, date: null } });
        expect((await fetch(`${base}/stock/ZZZ/value-history?range=max`)).status).to.equal(200);
        expect(called!.args).to.deep.equal(['ZZZ', '--range', 'max']);
        called = null;
        const bad = await fetch(`${base}/stock/ZZZ/value-history?range=10y`);
        expect(bad.status).to.equal(400);
        expect(await bad.json()).to.deep.equal({ error: 'Invalid range' });
        expect(called).to.equal(null);
    });

    it('value-history maps a script error to 502 and a bad ticker to 400', async () => {
        stub({ error: 'No data found' });
        const res = await fetch(`${base}/stock/ZZZ/value-history`);
        expect(res.status).to.equal(502);
        expect(await res.json()).to.deep.equal({ error: 'No data found' });
        expect((await fetch(`${base}/stock/BAD!!TICKER/value-history`)).status).to.equal(400);
    });

    it('montecarlo returns 200 with the script payload', async () => {
        const payload = { ticker: 'ZZZ', n: 10000, seed: 42, price: 10, scenarios: {}, result: { p50: 1, histogram: { bins: [0, 1], counts: [1] } } };
        stub(payload);
        const res = await fetch(`${base}/stock/zzz/montecarlo`);
        expect(res.status).to.equal(200);
        expect(await res.json()).to.deep.equal(payload);
        expect(called).to.deep.equal({ script: 'stock_montecarlo.py', args: ['ZZZ'] });
    });

    it('montecarlo returns 404 {error:no_projection} without fabricating a result', async () => {
        stub({ error: 'no_projection', message: 'no saved projection for ZZZ' });
        const res = await fetch(`${base}/stock/ZZZ/montecarlo`);
        expect(res.status).to.equal(404);
        expect(await res.json()).to.deep.equal({ error: 'no_projection', message: 'no saved projection for ZZZ' });
    });

    it('montecarlo returns 404 for no_price and 400 for a bad ticker', async () => {
        stub({ error: 'no_price', message: 'no stored price for ZZZ' });
        expect((await fetch(`${base}/stock/ZZZ/montecarlo`)).status).to.equal(404);
        expect((await fetch(`${base}/stock/BAD!!TICKER/montecarlo`)).status).to.equal(400);
    });
});
