/**
 * brokerDisabled.spec.ts - the broker integration kill switch (S6).
 *
 * Purpose:
 *   This platform is a screener and recommendation tool: broker order execution
 *   (/api/trading/*) and broker portfolio sync (/api/portfolio/sync*) are disabled
 *   unless the owner opts in with BROKER_INTEGRATION=on. Disabled means 410 with a
 *   clear message and code BROKER_DISABLED — the code stays, it is not deleted.
 *   Reads of stored data and the one price refresh must stay available either way.
 *
 * Layer:
 *   Backend / Tests / API
 *
 * Key Input Dependencies:
 *   - src/utils/brokerIntegration.ts (the flag and its middleware)
 *   - src/routes/trading.ts, src/routes/portfolio.ts (the guarded routers)
 *
 * Key Output Dependencies:
 *   None. No broker call, no TradingView call, no write to domain_model.sqlite:
 *   the one enabled-path test stubs brokerSyncService.syncFromTV.
 */
import { expect } from 'chai';
import { isBrokerIntegrationEnabled, requireBrokerIntegration } from '../../src/utils/brokerIntegration';
import { withRouter } from './helpers/testServer';

const DISABLED_MESSAGE =
    'Broker integration is disabled: this platform is a screener and recommendation tool. ' +
    'Set BROKER_INTEGRATION=on to re-enable.';

/** Routes that must refuse to reach the broker while the integration is off. */
const GUARDED: Array<{ method: 'GET' | 'POST' | 'PATCH'; router: 'trading' | 'portfolio'; path: string }> = [
    { method: 'POST', router: 'trading', path: '/preflight' },
    { method: 'POST', router: 'trading', path: '/execute' },
    { method: 'POST', router: 'trading', path: '/submit' },
    { method: 'GET', router: 'trading', path: '/session/abc' },
    { method: 'POST', router: 'trading', path: '/log' },
    { method: 'POST', router: 'trading', path: '/log/suggest' },
    { method: 'PATCH', router: 'trading', path: '/log/abc' },
    { method: 'POST', router: 'trading', path: '/modify' },
    { method: 'POST', router: 'trading', path: '/cancel' },
    { method: 'GET', router: 'trading', path: '/broker-sources' },
    { method: 'POST', router: 'trading', path: '/log/sync-from-tv' },
    { method: 'GET', router: 'trading', path: '/tv-quote?ticker=NVDA' },
    { method: 'POST', router: 'portfolio', path: '/sync-tv' },
    { method: 'POST', router: 'portfolio', path: '/sync-tv/promote' },
    { method: 'POST', router: 'portfolio', path: '/sync-tv/apply' },
    { method: 'POST', router: 'portfolio', path: '/sync' },
];

/** Load a router fresh so module-level state never leaks between env settings. */
function loadRouter(name: 'trading' | 'portfolio') {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require(`../../src/routes/${name}`).default;
}

describe('broker integration kill switch (S6)', () => {
    const originalEnv = process.env.BROKER_INTEGRATION;

    afterEach(() => {
        if (originalEnv === undefined) delete process.env.BROKER_INTEGRATION;
        else process.env.BROKER_INTEGRATION = originalEnv;
    });

    describe('isBrokerIntegrationEnabled', () => {
        it('is off when unset — the screener-only default needs no configuration', () => {
            delete process.env.BROKER_INTEGRATION;
            expect(isBrokerIntegrationEnabled()).to.equal(false);
        });

        it("is on only for 'on' (case/space tolerant), off for every other value", () => {
            for (const value of ['on', 'ON', ' on ']) {
                process.env.BROKER_INTEGRATION = value;
                expect(isBrokerIntegrationEnabled(), value).to.equal(true);
            }
            for (const value of ['off', 'true', '1', 'yes', 'enabled', '']) {
                process.env.BROKER_INTEGRATION = value;
                expect(isBrokerIntegrationEnabled(), value).to.equal(false);
            }
        });

        it('is read per call, so flipping the env flips the middleware without a restart', () => {
            process.env.BROKER_INTEGRATION = 'on';
            expect(isBrokerIntegrationEnabled()).to.equal(true);
            process.env.BROKER_INTEGRATION = 'off';
            expect(isBrokerIntegrationEnabled()).to.equal(false);
        });
    });

    describe('requireBrokerIntegration middleware', () => {
        it('answers 410 with the message and code, and never calls next()', () => {
            delete process.env.BROKER_INTEGRATION;
            let status = 0;
            let body: any = null;
            let nextCalled = false;
            const res: any = { status(s: number) { status = s; return this; }, json(b: any) { body = b; return this; } };
            requireBrokerIntegration({} as any, res, () => { nextCalled = true; });
            expect(status).to.equal(410);
            expect(body).to.deep.equal({ error: DISABLED_MESSAGE, code: 'BROKER_DISABLED' });
            expect(nextCalled).to.equal(false);
        });

        it('calls next() when the owner opted in', () => {
            process.env.BROKER_INTEGRATION = 'on';
            let nextCalled = false;
            const res: any = { status() { return this; }, json() { return this; } };
            requireBrokerIntegration({} as any, res, () => { nextCalled = true; });
            expect(nextCalled).to.equal(true);
        });
    });

    describe('guarded routes', () => {
        for (const route of GUARDED) {
            it(`${route.method} /api/${route.router}${route.path} is 410 BROKER_DISABLED when off`, async () => {
                delete process.env.BROKER_INTEGRATION;
                await withRouter(loadRouter(route.router), async base => {
                    const res = await fetch(`${base}/api${route.path}`, {
                        method: route.method,
                        headers: { 'Content-Type': 'application/json' },
                        body: route.method === 'GET' ? undefined : JSON.stringify({}),
                    });
                    expect(res.status).to.equal(410);
                    const body: any = await res.json();
                    expect(body.code).to.equal('BROKER_DISABLED');
                    expect(body.error).to.equal(DISABLED_MESSAGE);
                });
            });
        }
    });

    describe('the guard only guards', () => {
        it('POST /api/portfolio/refresh-prices is never 410 — the one price refresh survives S6', async () => {
            delete process.env.BROKER_INTEGRATION;
            // Stubbed "TradingView not connected" so the handler stops at its own 503 and never
            // spawns the real refresh: this spec must not quote, write a price, or touch the DB.
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const helpers = require('../../src/utils/helpers');
            const original = helpers.isTradingViewConnected;
            helpers.isTradingViewConnected = async () => false;
            try {
                await withRouter(loadRouter('portfolio'), async base => {
                    const res = await fetch(`${base}/api/refresh-prices`, { method: 'POST' });
                    expect(res.status).to.equal(503);
                    expect(res.status).to.not.equal(410);
                });
            } finally {
                helpers.isTradingViewConnected = original;
            }
        });

        it('GET /api/trading/log and /audit/today read stored data and are never 410', async () => {
            delete process.env.BROKER_INTEGRATION;
            await withRouter(loadRouter('trading'), async base => {
                for (const path of ['/log', '/audit/today']) {
                    const res = await fetch(`${base}/api${path}`);
                    expect(res.status, path).to.not.equal(410);
                }
                const post = await fetch(`${base}/api/log`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
                expect(post.status, 'POST /log stays guarded').to.equal(410);
            });
        });

        it('GET reads of stored portfolio data are never 410', async () => {
            delete process.env.BROKER_INTEGRATION;
            await withRouter(loadRouter('portfolio'), async base => {
                for (const path of ['/', '/status', '/weights', '/holdings/NVDA']) {
                    const res = await fetch(`${base}/api${path}`);
                    expect(res.status, path).to.not.equal(410);
                }
            });
        });

        it('GET /api/portfolio/features reports the flag to the UI (off by default)', async () => {
            delete process.env.BROKER_INTEGRATION;
            await withRouter(loadRouter('portfolio'), async base => {
                const res = await fetch(`${base}/api/features`);
                expect(res.status).to.equal(200);
                expect(await res.json()).to.deep.equal({ broker_integration: false });
            });
        });

        it('GET /api/portfolio/features reports true once the owner opted in', async () => {
            process.env.BROKER_INTEGRATION = 'on';
            await withRouter(loadRouter('portfolio'), async base => {
                const res = await fetch(`${base}/api/features`);
                expect(await res.json()).to.deep.equal({ broker_integration: true });
            });
        });
    });

    describe('BROKER_INTEGRATION=on passes through to the handler', () => {
        it('POST /api/portfolio/sync-tv reaches the sync service (stubbed — no broker call)', async () => {
            process.env.BROKER_INTEGRATION = 'on';
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const svc = require('../../src/services/BrokerSyncService').brokerSyncService;
            const original = svc.syncFromTV;
            let called = false;
            svc.syncFromTV = async () => { called = true; return { positions: [], snapshots: [] }; };
            try {
                await withRouter(loadRouter('portfolio'), async base => {
                    const res = await fetch(`${base}/api/sync-tv`, { method: 'POST' });
                    expect(called, 'handler ran').to.equal(true);
                    expect(res.status).to.not.equal(410);
                });
            } finally {
                svc.syncFromTV = original;
            }
        });

        it('GET /api/trading/session/:id reaches the handler (404 for an unknown session, not 410)', async () => {
            process.env.BROKER_INTEGRATION = 'on';
            await withRouter(loadRouter('trading'), async base => {
                const res = await fetch(`${base}/api/session/does-not-exist`);
                expect(res.status).to.equal(404);
            });
        });
    });
});
