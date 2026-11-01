/**
 * opportunities.spec.ts
 *
 * Purpose: covers the Node surface of the opportunities screener (S8/S15): the query-parameter
 * contract of routes/opportunities.ts (defaults, 400 on invalid input, 503 when the engine
 * reports no scanner snapshot, 500 on failure) and the 60 s per-parameter memo of
 * OpportunitiesService.
 *
 * The Python engine is stubbed (an injected script runner): nothing spawns Python, nothing
 * touches the database and no source is fetched over the network.
 */
import { expect } from 'chai';
import { OpportunitiesService, OPPORTUNITY_SCRIPT, CACHE_TTL_MS } from '../../src/services/OpportunitiesService';
import { createOpportunitiesRouter } from '../../src/routes/opportunities';
import { withRouter } from './helpers/testServer';

const RESPONSE = {
    asOf: '2026-10-31T12:00:00+00:00', scannerUpdateMode: 'delayed_streaming_900',
    aaaYield: { value: 6.03, asOf: '2026-09-01' }, universe: 1645,
    steps: [], resultCount: 1, starHistogram: { '5': 1 }, rows: [{ ticker: 'GOOD', stars: 5 }],
};

interface Call { script: string; args: string[]; timeoutMs: number }

function recorder(result: { exitCode: number; json: any } = { exitCode: 0, json: RESPONSE }) {
    const calls: Call[] = [];
    const run = async (script: string, args: string[], timeoutMs: number) => {
        calls.push({ script, args, timeoutMs });
        return result;
    };
    return { calls, run };
}

function paramsOf(call: Call): any {
    return JSON.parse(call.args[call.args.indexOf('--params') + 1]);
}

describe('OpportunitiesService', () => {
    it('spawns the engine with the full parameter set and a --db path', async () => {
        const { calls, run } = recorder();
        const service = new OpportunitiesService({ runScript: run, dbPath: '/tmp/x.sqlite' });

        const response = await service.screen({ require: '1,4', roic: 15, drop: 20 });

        expect(response).to.deep.equal(RESPONSE);
        expect(calls[0].script).to.equal(OPPORTUNITY_SCRIPT);
        expect(calls[0].args).to.include('--db');
        expect(paramsOf(calls[0])).to.deep.include({ require: '1,4', roic: 15, drop: 20 });
    });

    it('serves the same parameters from memory for 60 s, then runs the engine again', async () => {
        const { calls, run } = recorder();
        let clock = 1_000;
        const service = new OpportunitiesService({ runScript: run, now: () => clock });

        await service.screen({ require: '1,4' });
        await service.screen({ require: '1,4' });
        expect(calls.length).to.equal(1);

        await service.screen({ require: '1' });
        expect(calls.length).to.equal(2);

        clock += CACHE_TTL_MS + 1;
        await service.screen({ require: '1,4' });
        expect(calls.length).to.equal(3);
    });

    it('raises ScreenDataMissing when the engine reports no scanner snapshot', async () => {
        const { run } = recorder({ exitCode: 1, json: { error: 'sin datos', code: 'SCREEN_DATA_MISSING' } });
        const service = new OpportunitiesService({ runScript: run });

        let code = '';
        try {
            await service.screen({});
        } catch (err) {
            code = (err as any).code;
        }
        expect(code).to.equal('SCREEN_DATA_MISSING');
    });
});

describe('GET /api/opportunities', () => {
    it('applies the S8/S15 defaults when no query parameter is given', async () => {
        const { calls, run } = recorder();
        const router = createOpportunitiesRouter({ service: new OpportunitiesService({ runScript: run }) });

        await withRouter(router, async base => {
            const res = await fetch(`${base}/api/opportunities`);
            expect(res.status).to.equal(200);
            expect(await res.json()).to.deep.equal(RESPONSE);
        }, '/api/opportunities');

        expect(paramsOf(calls[0])).to.deep.equal({
            require: '1,4', roic: 15, roe: 15, roa: 7, de: 0.5, mos: 25, fcfy: 5, peg: 1,
            target: 20, drop: 20, sortino: 0.5, dbeta: 1.2, rev: 0, sup: 1, ins: 2, etf: 0,
        });
    });

    it('passes the step 5 thresholds through, including a negative revisions floor', async () => {
        const { calls, run } = recorder();
        const router = createOpportunitiesRouter({ service: new OpportunitiesService({ runScript: run }) });

        await withRouter(router, async base => {
            const res = await fetch(`${base}/api/opportunities?sortino=1.5&dbeta=0.8&rev=-2`);
            expect(res.status).to.equal(200);
        }, '/api/opportunities');

        expect(paramsOf(calls[0])).to.deep.include({ sortino: 1.5, dbeta: 0.8, rev: -2 });
        expect(paramsOf(calls[0])).to.not.have.property('rsi');
    });

    it('passes the caller parameters through', async () => {
        const { calls, run } = recorder();
        const router = createOpportunitiesRouter({ service: new OpportunitiesService({ runScript: run }) });

        await withRouter(router, async base => {
            const res = await fetch(`${base}/api/opportunities?require=1,2,6&mos=40&etf=1`);
            expect(res.status).to.equal(200);
        }, '/api/opportunities');

        expect(paramsOf(calls[0])).to.deep.include({ require: '1,2,6', mos: 40, etf: 1 });
    });

    it('rejects invalid parameters with 400', async () => {
        const { calls, run } = recorder();
        const router = createOpportunitiesRouter({ service: new OpportunitiesService({ runScript: run }) });

        await withRouter(router, async base => {
            for (const query of ['require=9', 'require=abc', 'roic=high', 'mos=-5', 'etf=2',
                'sortino=-1', 'dbeta=high', 'rev=2.5']) {
                const res = await fetch(`${base}/api/opportunities?${query}`);
                expect(res.status, query).to.equal(400);
            }
        }, '/api/opportunities');

        expect(calls.length).to.equal(0);
    });

    it('answers 503 SCREEN_DATA_MISSING while no scanner snapshot exists', async () => {
        const { run } = recorder({ exitCode: 1, json: { error: 'sin datos del screener', code: 'SCREEN_DATA_MISSING' } });
        const router = createOpportunitiesRouter({ service: new OpportunitiesService({ runScript: run }) });

        await withRouter(router, async base => {
            const res = await fetch(`${base}/api/opportunities`);
            expect(res.status).to.equal(503);
            const body = await res.json();
            expect(body.code).to.equal('SCREEN_DATA_MISSING');
            expect(body.error).to.be.a('string');
        }, '/api/opportunities');
    });

    it('answers 500 when the engine run fails', async () => {
        const router = createOpportunitiesRouter({
            service: new OpportunitiesService({
                runScript: async () => { throw new Error('python exploded'); },
            }),
        });

        await withRouter(router, async base => {
            const res = await fetch(`${base}/api/opportunities`);
            expect(res.status).to.equal(500);
            expect((await res.json()).error).to.be.a('string');
        }, '/api/opportunities');
    });
});
