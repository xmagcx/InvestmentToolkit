/**
 * dailybriefToday.spec.ts
 *
 * Purpose: covers B2a's Node surface of the redesigned daily brief (S10): GET /today
 * (200 payload, 404 NO_BRIEF), POST /regenerate (202, then 409 while a run is in flight)
 * and GET /regenerate/status.
 *
 * Python is stubbed (an injected task runner and an injected spawner): nothing spawns a
 * process, nothing reads the ledger and no brief is ever regenerated.
 */
import { expect } from 'chai';
import { createDailyBriefRouter } from '../../src/routes/dailybrief';
import { BriefRegenerator } from '../../src/services/BriefRegenerator';
import { withRouter } from './helpers/testServer';

const PAYLOAD = {
    date: '2026-10-30',
    generatedAt: '2026-10-31T02:28:57.829523+00:00',
    market: { regime: 'NEUTRAL', label: 'Mercado neutral', sentence: 'No hay una tendencia clara.', indicators: [] },
    tasks: [{ urgency: 'alta', ticker: 'APP', summary: 'Se desplomó −9,62 %.', action: 'Revisar la tesis', tag: 'Sobreventa: RSI 24,9', link: 'analysis' }],
    untasked: [{ ticker: 'MCD', status: 'Mantener', rsi: 68.2, note: 'Tendencia fuerte, sin cambios' }],
    taFresh: false,
    taNote: 'Análisis técnico no actualizado hoy.',
    counts: { tasks: 1, untasked: 1 },
};

/** A spawned brief that only finishes when the test says so. */
function fakeSpawner() {
    const exits: Array<(code: number) => void> = [];
    const calls: Array<{ command: string; args: string[] }> = [];
    const spawnProcess = (command: string, args: string[]) => {
        calls.push({ command, args });
        return {
            on(event: string, listener: (...a: any[]) => void) {
                if (event === 'exit') exits.push(listener);
                return this;
            },
            unref() { /* detached in production, nothing to do here */ },
        };
    };
    return { calls, spawnProcess, finish: (code = 0) => exits.forEach(fn => fn(code)) };
}

describe('GET /api/daily-brief/today', () => {
    it('returns the task payload built by brief_tasks.py', async () => {
        const calls: Array<(string | undefined)[]> = [];
        const router = createDailyBriefRouter({
            runTasks: async (dbPath, domainDb) => { calls.push([dbPath, domainDb]); return PAYLOAD; },
        });

        await withRouter(router, async base => {
            const res = await fetch(`${base}/api/daily-brief/today`);
            expect(res.status).to.equal(200);
            expect(await res.json()).to.deep.equal(PAYLOAD);
        }, '/api/daily-brief');

        expect(calls).to.have.length(1);
        expect(calls[0][1]).to.be.a('string').and.contain('domain_model.sqlite');
    });

    it('answers 404 NO_BRIEF when the ledger holds no brief', async () => {
        const router = createDailyBriefRouter({ runTasks: async () => null });

        await withRouter(router, async base => {
            const res = await fetch(`${base}/api/daily-brief/today`);
            expect(res.status).to.equal(404);
            expect(((await res.json()) as any).code).to.equal('NO_BRIEF');
        }, '/api/daily-brief');
    });
});

describe('POST /api/daily-brief/regenerate', () => {
    it('starts the brief once, rejects a second start with 409, and reports the status', async () => {
        const spawner = fakeSpawner();
        const regenerator = new BriefRegenerator({ spawnProcess: spawner.spawnProcess, scriptPath: '/tmp/daily_brief.py' });
        const router = createDailyBriefRouter({ runTasks: async () => PAYLOAD, regenerator });

        await withRouter(router, async base => {
            const idle = await (await fetch(`${base}/api/daily-brief/regenerate/status`)).json();
            expect(idle).to.deep.equal({ running: false, startedAt: null, finishedAt: null, exitCode: null });

            const started = await fetch(`${base}/api/daily-brief/regenerate`, { method: 'POST' });
            expect(started.status).to.equal(202);
            expect(await started.json()).to.deep.equal({ started: true });

            const second = await fetch(`${base}/api/daily-brief/regenerate`, { method: 'POST' });
            expect(second.status).to.equal(409);
            expect(((await second.json()) as any).code).to.equal('REGENERATE_RUNNING');

            const running = await (await fetch(`${base}/api/daily-brief/regenerate/status`)).json() as any;
            expect(running.running).to.equal(true);
            expect(running.startedAt).to.be.a('string');
            expect(running.finishedAt).to.equal(null);

            spawner.finish(0);
            const done = await (await fetch(`${base}/api/daily-brief/regenerate/status`)).json() as any;
            expect(done.running).to.equal(false);
            expect(done.exitCode).to.equal(0);
            expect(done.finishedAt).to.be.a('string');

            const again = await fetch(`${base}/api/daily-brief/regenerate`, { method: 'POST' });
            expect(again.status).to.equal(202);
        }, '/api/daily-brief');

        expect(spawner.calls).to.have.length(2);
        expect(spawner.calls[0].args).to.deep.equal(['/tmp/daily_brief.py']);
    });
});
