/**
 * stockEdgar.spec.ts
 *
 * Purpose: GET /api/stock/:ticker/filings (S12) and /superinvestors (S11) call sec_filings.py /
 * superinvestors.py with the upper-cased ticker, pass the payload through (empty cases are 200),
 * cache complete results (12h / 24h) but never a partial 13F result, map script errors to 502
 * and bad tickers to 400.
 * Approach: stub bridge.spawnPythonScript (read at call time), serve the real router.
 */
import { expect } from 'chai';
import express from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import * as bridge from '../../src/services/bridge';
import stockRouter from '../../src/routes/stock';

const NO_CALLS = { available: false, reason: 'Sin fuente gratuita de transcripciones' };
const filings = (ticker: string) => ({
    ticker, cik: '0000789019',
    sec_filings: { total: 1, items: [{ form: '10-K', title: '10-K', filed: '2025-07-30', period: '2025-06-30', fiscal_year: 2025, fiscal_quarter: null, url: 'https://www.sec.gov/Archives/x.htm' }] },
    earnings_calls: NO_CALLS,
});
const NOTE = 'Los formularios 13F se publican hasta 45 días después del cierre del trimestre.';
const supers = (ticker: string, errors: any[] = []) => ({
    ticker, cusip: '594918104', holders: 1, buying: 1, selling: 0, quarter_latest: '2025-Q1',
    items: [{ manager: 'Ann A', fund: 'Alpha', cik: '1', portfolio_pct: 28.5, shares: 2000, quarter: '2025-Q1', change_pct: 25, action: 'add' }],
    errors, delay_note: NOTE,
});

describe('EDGAR stock routes', () => {
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

    it('filings: 200 with the payload, upper-cased ticker, cached on repeat', async () => {
        const body = filings('EDA');
        stub(body);
        const res = await fetch(`${base}/stock/eda/filings`);
        expect(res.status).to.equal(200);
        expect(await res.json()).to.deep.equal(body);
        await fetch(`${base}/stock/EDA/filings`);
        expect(calls).to.deep.equal([{ script: 'sec_filings.py', args: ['EDA'] }]);
    });

    it('filings: non-US/unknown ticker empty payload is a 200', async () => {
        const body = { ticker: 'EDB', cik: null, sec_filings: { total: 0, items: [] }, earnings_calls: NO_CALLS };
        stub(body);
        const res = await fetch(`${base}/stock/EDB/filings`);
        expect(res.status).to.equal(200);
        expect(await res.json()).to.deep.equal(body);
    });

    it('superinvestors: 200 with the payload and the 13F delay note', async () => {
        const body = supers('EDC');
        stub(body);
        const res = await fetch(`${base}/stock/edc/superinvestors`);
        expect(res.status).to.equal(200);
        expect(await res.json()).to.deep.equal(body);
        expect(calls).to.deep.equal([{ script: 'superinvestors.py', args: ['EDC'] }]);
    });

    it('superinvestors: unresolved CUSIP empty payload is a 200', async () => {
        const body = { ticker: 'EDD', cusip: null, holders: 0, buying: 0, selling: 0, quarter_latest: null, items: [], errors: [], delay_note: NOTE };
        stub(body);
        const res = await fetch(`${base}/stock/EDD/superinvestors`);
        expect(res.status).to.equal(200);
        expect(await res.json()).to.deep.equal(body);
    });

    it('superinvestors: caches a complete result but not one with manager errors', async () => {
        stub(supers('EDE'));
        await fetch(`${base}/stock/EDE/superinvestors`);
        await fetch(`${base}/stock/EDE/superinvestors`);
        expect(calls).to.have.length(1);
        calls = [];
        stub(supers('EDF', [{ manager: 'Bob B', error: 'EDGAR down' }]));
        const res = await fetch(`${base}/stock/EDF/superinvestors`);
        expect((await res.json()).errors).to.have.length(1);
        await fetch(`${base}/stock/EDF/superinvestors`);
        expect(calls).to.have.length(2);
    });

    it('maps a script error to 502, a thrown spawn to 500 and a bad ticker to 400', async () => {
        stub({ error: 'failed', message: 'boom' });
        for (const route of ['filings', 'superinvestors']) {
            const res = await fetch(`${base}/stock/EDG/${route}`);
            expect(res.status).to.equal(502);
            expect(await res.json()).to.deep.equal({ error: 'failed', message: 'boom' });
        }
        (bridge as any).spawnPythonScript = async () => { throw new Error('timeout'); };
        expect((await fetch(`${base}/stock/EDH/filings`)).status).to.equal(500);
        calls = [];
        stub(filings('X'));
        for (const route of ['filings', 'superinvestors']) {
            expect((await fetch(`${base}/stock/BAD!!TICKER/${route}`)).status).to.equal(400);
        }
        expect(calls).to.have.length(0);
    });
});
