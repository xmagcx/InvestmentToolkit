/**
 * stockOverviewPassthrough.spec.ts
 *
 * Purpose: GET /api/stock/:ticker returns the fetch_financials.py payload untouched,
 * including the new `overview` block (Analysis page, S3/S8-S10), and still maps
 * Python errors to 404.
 * Approach: stub bridge.spawnPythonScript (read at call time), serve the real router.
 */
import { expect } from 'chai';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import * as bridge from '../../src/services/bridge';
import stockRouter from '../../src/routes/stock';

describe('GET /stock/:ticker overview passthrough', () => {
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

    it('passes overview through next to the existing keys', async () => {
        const payload = {
            symbol: 'ZZZTEST', price: 10, financials: { historical_revenue: [1] },
            overview: { profile: { name: 'Acme' }, multiples: { pe: 20 }, benchmarks: { sector: null, industry: null } },
        };
        stub(payload);
        const res = await fetch(`${base}/stock/zzztest`);
        expect(res.status).to.equal(200);
        expect(await res.json()).to.deep.equal(payload);
        expect(called).to.deep.equal({ script: 'fetch_financials.py', args: ['ZZZTEST'] });
    });

    it('keeps mapping python errors to 404', async () => {
        stub({ error: 'Quote not found for symbol: ZZZTEST' });
        const res = await fetch(`${base}/stock/zzztest`);
        expect(res.status).to.equal(404);
        expect(await res.json()).to.deep.equal({ error: 'Symbol ZZZTEST not found' });
    });
});
