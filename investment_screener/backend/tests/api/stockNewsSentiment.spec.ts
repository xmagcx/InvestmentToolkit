/**
 * stockNewsSentiment.spec.ts
 *
 * Purpose: GET /api/stock/:ticker/news-sentiment (Analysis page, S14) calls news_sentiment.py
 * with the upper-cased ticker, passes the payload through (including stale:true, never a 500
 * for a source failure), caches fresh results for 30 minutes and never caches a stale one.
 * Approach: stub bridge.spawnPythonScript (read at call time), serve the real router.
 */
import { expect } from 'chai';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import * as bridge from '../../src/services/bridge';
import stockRouter from '../../src/routes/stock';

const payload = (ticker: string, stale = false) => ({
    ticker,
    periods: { '1M': { positive: 1, neutral: 0, negative: 0 }, '3M': { positive: 1, neutral: 0, negative: 0 }, '6M': { positive: 1, neutral: 0, negative: 0 }, '1Y': { positive: 1, neutral: 0, negative: 0 } },
    articles: [{ title: 'Up', date: '2025-06-28T09:30', source: 'Reuters', url: 'https://x/1', sentiment: 'positive', score: 0.8 }],
    total: 1,
    stale,
    fetched_at: '2025-06-30T00:00:00Z',
    coverage_since: '2025-06-28',
});

describe('GET /stock/:ticker/news-sentiment', () => {
    const original = bridge.spawnPythonScript;
    let server: http.Server;
    let base: string;
    let calls: Array<{ script: string; args: string[] }>;

    before((done) => {
        const app = express();
        app.use('/api', stockRouter);
        server = app.listen(0, () => { base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`; done(); });
    });
    after((done) => { (bridge as any).spawnPythonScript = original; server.close(() => done()); });
    beforeEach(() => { calls = []; });

    const stub = (result: any) => {
        (bridge as any).spawnPythonScript = async (script: string, args: string[]) => { calls.push({ script, args }); return result; };
    };

    it('returns 200 with the script payload and the upper-cased ticker', async () => {
        const body = payload('NSA');
        stub(body);
        const res = await fetch(`${base}/stock/nsa/news-sentiment`);
        expect(res.status).to.equal(200);
        expect(await res.json()).to.deep.equal(body);
        expect(calls).to.deep.equal([{ script: 'news_sentiment.py', args: ['NSA'] }]);
    });

    it('passes stale:true through as a 200', async () => {
        const body = payload('NSB', true);
        stub(body);
        const res = await fetch(`${base}/stock/NSB/news-sentiment`);
        expect(res.status).to.equal(200);
        expect((await res.json()).stale).to.equal(true);
    });

    it('caches a fresh result for the same ticker but not a stale one', async () => {
        stub(payload('NSC'));
        await fetch(`${base}/stock/NSC/news-sentiment`);
        await fetch(`${base}/stock/nsc/news-sentiment`);
        expect(calls).to.have.length(1);
        calls = [];
        stub(payload('NSD', true));
        await fetch(`${base}/stock/NSD/news-sentiment`);
        await fetch(`${base}/stock/NSD/news-sentiment`);
        expect(calls).to.have.length(2);
    });

    it('maps a script error to 502 and a bad ticker to 400', async () => {
        stub({ error: 'failed', message: 'boom' });
        const res = await fetch(`${base}/stock/NSE/news-sentiment`);
        expect(res.status).to.equal(502);
        expect(await res.json()).to.deep.equal({ error: 'failed', message: 'boom' });
        calls = [];
        expect((await fetch(`${base}/stock/BAD!!TICKER/news-sentiment`)).status).to.equal(400);
        expect(calls).to.have.length(0);
    });
});
