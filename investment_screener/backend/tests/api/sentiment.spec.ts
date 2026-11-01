/**
 * sentiment.spec.ts
 *
 * Purpose: covers the HTTP contract of routes/sentiment.ts (C2, S13/S15): the 200 payload
 * shape of GET /api/sentiment/:ticker, the in-memory cache that keeps the page from
 * spawning Python on every row the reader opens, the 400 for a ticker that is not one,
 * and the 500 reserved for a crashing script (a null half is still a 200).
 *
 * The Python runner is stubbed: no process is spawned and no network is touched.
 */
import { expect } from 'chai';
import { createSentimentRouter } from '../../src/routes/sentiment';
import { withRouter } from './helpers/testServer';

const PAYLOAD = {
    market: { score: 24, rating: 'Miedo', label: 'Miedo: el mercado está nervioso', asOf: '2026-11-02T00:00:00+00:00' },
    ticker: {
        score: 0.5,
        label: 'Positivo',
        headlines: [{ title: 'Strong quarter', publisher: 'Reuters', url: 'https://example.com/1', publishedAt: '2026-11-02T12:00:00Z', score: 1 }],
        asOf: '2026-11-02T12:00:00Z',
    },
};

function router(json: any = PAYLOAD) {
    const calls: { script: string; args: string[]; timeoutMs: number }[] = [];
    const run = async (script: string, args: string[], timeoutMs: number) => {
        calls.push({ script, args, timeoutMs });
        return { exitCode: 0, json, stdout: '', stderr: '' };
    };
    return { calls, router: createSentimentRouter({ runScript: run }) };
}

describe('GET /api/sentiment/:ticker — market mood and headline sentiment', () => {
    it('returns the payload of sentiment.py and spawns it with a 30 s timeout', async () => {
        const { calls, router: r } = router();
        await withRouter(r, async base => {
            const res = await fetch(`${base}/api/sentiment/TMO`);
            expect(res.status).to.equal(200);
            expect(await res.json()).to.deep.equal(PAYLOAD);
        }, '/api/sentiment');
        expect(calls).to.have.length(1);
        expect(calls[0].script).to.equal('sentiment.py');
        expect(calls[0].args).to.deep.equal(['--ticker', 'TMO']);
        expect(calls[0].timeoutMs).to.equal(30_000);
    });

    it('answers a 200 when a half is null (a failing half is never a 500)', async () => {
        const { router: r } = router({ market: null, ticker: PAYLOAD.ticker });
        await withRouter(r, async base => {
            const res = await fetch(`${base}/api/sentiment/TMO`);
            expect(res.status).to.equal(200);
            expect((await res.json() as any).market).to.equal(null);
        }, '/api/sentiment');
    });

    it('serves the cached reading instead of spawning Python again', async () => {
        const { calls, router: r } = router();
        await withRouter(r, async base => {
            await fetch(`${base}/api/sentiment/TMO`);
            const res = await fetch(`${base}/api/sentiment/TMO`);
            expect(res.status).to.equal(200);
            expect(await res.json()).to.deep.equal(PAYLOAD);
        }, '/api/sentiment');
        expect(calls).to.have.length(1);
    });

    it('spawns again for a different ticker but reuses the cached market half', async () => {
        const { calls, router: r } = router();
        await withRouter(r, async base => {
            await fetch(`${base}/api/sentiment/TMO`);
            const res = await fetch(`${base}/api/sentiment/VITL`);
            expect((await res.json() as any).market).to.deep.equal(PAYLOAD.market);
        }, '/api/sentiment');
        expect(calls).to.have.length(2);
    });

    it('rejects a ticker that is not one with a 400 and never spawns Python', async () => {
        const { calls, router: r } = router();
        await withRouter(r, async base => {
            const res = await fetch(`${base}/api/sentiment/not%20a%20ticker`);
            expect(res.status).to.equal(400);
            expect((await res.json() as any).error).to.contain('Ticker');
        }, '/api/sentiment');
        expect(calls).to.have.length(0);
    });

    it('answers a 500 when the script crashes', async () => {
        const r = createSentimentRouter({
            runScript: async () => { throw new Error('traceback'); },
        });
        await withRouter(r, async base => {
            const res = await fetch(`${base}/api/sentiment/TMO`);
            expect(res.status).to.equal(500);
        }, '/api/sentiment');
    });
});
