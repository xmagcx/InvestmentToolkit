/**
 * portfolioRisk.test.ts - GET /api/portfolio/risk and POST /api/portfolio/optimize.
 *
 * The routes spawn portfolio_optimizer.py and return its JSON unchanged. The spawn is a
 * fake that records the script and arguments, so no Python runs and no database is read.
 *
 * Layer: Backend / Tests / API
 * Usage: npx mocha -r ts-node/register tests/api/portfolioRisk.test.ts
 */
import { expect } from 'chai';
import { buildPortfolioRiskRouter } from '../../src/routes/portfolioRisk';
import { withRouter } from './helpers/testServer';

type Call = { script: string; args: string[] };

function fakeSpawn(result: unknown, calls: Call[]) {
    return async (script: string, args: string[]) => {
        calls.push({ script, args });
        return result;
    };
}

describe('portfolio risk routes', () => {
    it('GET /portfolio/risk spawns the service with --risk and returns its JSON unchanged', async () => {
        const calls: Call[] = [];
        const payload = { as_of: '2026-11-03', rows: [{ ticker: 'APP' }] };
        await withRouter(buildPortfolioRiskRouter('/tmp/x.sqlite', fakeSpawn(payload, calls)), async base => {
            const res = await fetch(`${base}/api/portfolio/risk`);
            expect(res.status).to.equal(200);
            expect(await res.json()).to.deep.equal(payload);
        }, '/api/portfolio');
        expect(calls).to.deep.equal([{ script: 'portfolio_optimizer.py', args: ['--db', '/tmp/x.sqlite', '--risk', '--json'] }]);
    });

    for (const objective of ['min_volatility', 'risk_parity', 'max_sharpe']) {
        it(`POST /portfolio/optimize accepts ${objective}`, async () => {
            const calls: Call[] = [];
            const payload = { objective, orders: [] };
            await withRouter(buildPortfolioRiskRouter('/tmp/x.sqlite', fakeSpawn(payload, calls)), async base => {
                const res = await fetch(`${base}/api/portfolio/optimize`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ objective }),
                });
                expect(res.status).to.equal(200);
                expect(await res.json()).to.deep.equal(payload);
            }, '/api/portfolio');
            expect(calls[0].args).to.deep.equal(['--db', '/tmp/x.sqlite', '--optimize', objective, '--json']);
        });
    }

    it('POST /portfolio/optimize answers 400 on an unknown or missing objective, without spawning', async () => {
        const calls: Call[] = [];
        await withRouter(buildPortfolioRiskRouter('/tmp/x.sqlite', fakeSpawn({}, calls)), async base => {
            for (const body of [{ objective: 'get_rich' }, {}]) {
                const res = await fetch(`${base}/api/portfolio/optimize`, {
                    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
                });
                expect(res.status).to.equal(400);
                expect((await res.json()).error).to.match(/objective/);
            }
        }, '/api/portfolio');
        expect(calls).to.have.length(0);
    });

    it('answers 500 with the reason when the service fails', async () => {
        const failing = async () => { throw new Error('boom'); };
        await withRouter(buildPortfolioRiskRouter('/tmp/x.sqlite', failing), async base => {
            const res = await fetch(`${base}/api/portfolio/risk`);
            expect(res.status).to.equal(500);
            expect((await res.json()).details).to.equal('boom');
        }, '/api/portfolio');
    });
});
