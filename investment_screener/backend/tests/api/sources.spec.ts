/**
 * sources.spec.ts
 *
 * Purpose: covers the investment-sources surface (T2/S4): the fresh Python bridge call
 * (`runPythonScriptFresh`, which must never dedup or serve a stale cached result because a
 * sync writes), the per-source in-memory lock in SourceSyncService, the read queries in
 * SourcesRepository and the HTTP contract of routes/sources.ts (200/409/404/502, query
 * filters, in_platform).
 *
 * All state is tmp-scoped: a tmp SQLite file built by the Python migrator (never the real
 * domain_model.sqlite) and tmp Python scripts; no source is ever fetched over the network.
 */
import { expect } from 'chai';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runPythonScriptFresh } from '../../src/services/bridge';
import { SourceSyncService, SourceAlreadyRunningError, UnknownSourceError } from '../../src/services/SourceSyncService';
import { SourcesRepository } from '../../src/services/SourcesRepository';
import { createSourcesRouter } from '../../src/routes/sources';
import { withRouter } from './helpers/testServer';

const SUCCESS_RESULT = {
    source_code: 'racional_gsheet', status: 'success', fetched: 10, inserted: 2, updated: 1,
    reactivated: 0, deactivated: 0, rejected: 0, duration_ms: 1200, error: null, run_id: 7,
};
const FAILED_RESULT = { ...SUCCESS_RESULT, status: 'failed', inserted: 0, updated: 0, error: 'sheet is missing required column(s): URL', run_id: 8 };

function writeScript(dir: string, name: string, body: string): string {
    const file = path.join(dir, name);
    fs.writeFileSync(file, body, 'utf-8');
    return file;
}

describe('bridge.runPythonScriptFresh — a sync result is data, even on exit 1', () => {
    let dir: string;

    beforeEach(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-fresh-'));
    });
    afterEach(() => {
        for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
        fs.rmdirSync(dir);
    });

    it('resolves {exitCode: 0, json} for a script that prints JSON', async () => {
        const script = writeScript(dir, 'ok.py', 'import json\nprint(json.dumps({"status": "success"}))\n');
        const result = await runPythonScriptFresh(script, [], 20_000);
        expect(result.exitCode).to.equal(0);
        expect(result.json).to.deep.equal({ status: 'success' });
    });

    it('resolves (never rejects) on exit 1 when stdout is JSON', async () => {
        const script = writeScript(dir, 'fail.py', 'import json, sys\nprint(json.dumps({"status": "failed", "error": "boom"}))\nsys.exit(1)\n');
        const result = await runPythonScriptFresh(script, [], 20_000);
        expect(result.exitCode).to.equal(1);
        expect(result.json.error).to.equal('boom');
    });

    it('rejects when the script fails without JSON on stdout, naming the stderr', async () => {
        const script = writeScript(dir, 'crash.py', 'import sys\nsys.stderr.write("traceback here\\n")\nsys.exit(2)\n');
        let message = '';
        try {
            await runPythonScriptFresh(script, [], 20_000);
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).to.contain('traceback here');
    });

    it('never serves a previous result for the same script+args (no stale cache, no dedup)', async () => {
        const script = writeScript(dir, 'counter.py', 'import json, sys, time\nprint(json.dumps({"ts": time.time_ns()}))\n');
        const first = await runPythonScriptFresh(script, [], 20_000);
        const second = await runPythonScriptFresh(script, [], 20_000);
        expect(second.json.ts).to.not.equal(first.json.ts);
        expect(second.json.stale).to.equal(undefined);
    });

    it('kills and rejects on timeout', async () => {
        const script = writeScript(dir, 'slow.py', 'import time\ntime.sleep(30)\n');
        let message = '';
        try {
            await runPythonScriptFresh(script, [], 300);
        } catch (err) {
            message = (err as Error).message;
        }
        expect(message).to.match(/timed out/i);
    });
});

describe('SourceSyncService — per-source lock and code validation', () => {
    function service(runner: (script: string, args: string[]) => Promise<{ exitCode: number; json: any }>) {
        return new SourceSyncService({
            runScript: (script, args) => runner(script, args),
            timeoutMs: 1000,
        });
    }

    const listing = { exitCode: 0, json: { sources: [{ source_code: 'racional_gsheet', display_name: 'Racional' }] } };

    it('runs sync_cli.py with the source and trigger and returns its SyncResult', async () => {
        const calls: string[][] = [];
        const svc = service(async (script, args) => {
            calls.push([script, ...args]);
            return args.includes('--list') ? listing : { exitCode: 0, json: SUCCESS_RESULT };
        });
        const result = await svc.sync('racional_gsheet', 'manual');
        expect(result.status).to.equal('success');
        expect(result.inserted).to.equal(2);
        const syncCall = calls[calls.length - 1];
        expect(syncCall[0]).to.contain('investment_sources/sync_cli.py');
        expect(syncCall).to.include.members(['--source', 'racional_gsheet', '--trigger', 'manual']);
    });

    it('returns a failed SyncResult instead of throwing when the script exits 1 with JSON', async () => {
        const svc = service(async (_s, args) => (args.includes('--list') ? listing : { exitCode: 1, json: FAILED_RESULT }));
        const result = await svc.sync('racional_gsheet', 'scheduled');
        expect(result.status).to.equal('failed');
        expect(result.error).to.contain('missing required column');
    });

    it('rejects an unknown source code without spawning a sync', async () => {
        let synced = 0;
        const svc = service(async (_s, args) => {
            if (args.includes('--list')) return listing;
            synced += 1;
            return { exitCode: 0, json: SUCCESS_RESULT };
        });
        let caught: unknown;
        try {
            await svc.sync('not_a_source', 'manual');
        } catch (err) {
            caught = err;
        }
        expect(caught).to.be.instanceOf(UnknownSourceError);
        expect(synced).to.equal(0);
    });

    it('caches the source list — --list runs once across syncs', async () => {
        let listCalls = 0;
        const svc = service(async (_s, args) => {
            if (args.includes('--list')) {
                listCalls += 1;
                return listing;
            }
            return { exitCode: 0, json: SUCCESS_RESULT };
        });
        await svc.sync('racional_gsheet', 'manual');
        await svc.sync('racional_gsheet', 'manual');
        expect(listCalls).to.equal(1);
    });

    it('rejects a second sync of the same source while the first runs, and reports isRunning', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const svc = service(async (_s, args) => {
            if (args.includes('--list')) return listing;
            await gate;
            return { exitCode: 0, json: SUCCESS_RESULT };
        });
        await svc.listSources();
        const first = svc.sync('racional_gsheet', 'manual');
        await new Promise(r => setTimeout(r, 10));
        expect(svc.isRunning('racional_gsheet')).to.equal(true);
        let caught: unknown;
        try {
            await svc.sync('racional_gsheet', 'manual');
        } catch (err) {
            caught = err;
        }
        expect(caught).to.be.instanceOf(SourceAlreadyRunningError);
        release();
        await first;
        expect(svc.isRunning('racional_gsheet')).to.equal(false);
    });

    it('frees the lock when the run throws', async () => {
        const svc = service(async (_s, args) => {
            if (args.includes('--list')) return listing;
            throw new Error('python exploded');
        });
        try {
            await svc.sync('racional_gsheet', 'manual');
        } catch {
            /* expected */
        }
        expect(svc.isRunning('racional_gsheet')).to.equal(false);
    });
});

// ── Repository + routes against a tmp database ────────────────────────────────

const QUARTERLY_DDL = `
CREATE TABLE IF NOT EXISTS recent_buys_q (
    id INTEGER PRIMARY KEY, quarter TEXT NOT NULL, symbol TEXT NOT NULL, normalized_symbol TEXT NOT NULL,
    company_name TEXT, portfolio_pct REAL, buys_count INTEGER, hold_price REAL, current_price REAL,
    low_52w REAL, pct_above_low_52w REAL, high_52w REAL, source_url TEXT, raw_row TEXT,
    first_seen_at TEXT, last_synced_at TEXT, UNIQUE (quarter, normalized_symbol));`;
const INSIDER_DDL = `
CREATE TABLE IF NOT EXISTS recent_buys_insider (
    id INTEGER PRIMARY KEY, filing_at TEXT NOT NULL, symbol TEXT NOT NULL, normalized_symbol TEXT NOT NULL,
    security_name TEXT, reporting_name TEXT, reporting_id TEXT, relationship TEXT, transaction_date TEXT,
    transaction_type TEXT, shares INTEGER, price REAL, amount REAL, ownership_type TEXT,
    is_ten_pct_owner INTEGER, is_amendment INTEGER, filing_url TEXT, source_url TEXT, raw_row TEXT,
    first_seen_at TEXT, last_synced_at TEXT);`;

function isoDaysAgo(days: number): string {
    return new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 16);
}

function seed(dbPath: string): void {
    // Build the Python-owned schema through the repository's own gate, then seed rows.
    new SourcesRepository(dbPath).close();
    const db = new Database(dbPath);
    db.exec(QUARTERLY_DDL);
    db.exec(INSIDER_DDL);
    const origin = db.prepare(`INSERT INTO stocks_origin
        (source_code, symbol, normalized_symbol, exchange, company_name, asset_type, sector, industry, is_active, source_metadata, first_seen_at, last_seen_at)
        VALUES (?, ?, ?, '', ?, ?, ?, ?, ?, ?, ?, ?)`);
    origin.run('racional_gsheet', 'AAPL', 'AAPL', 'Apple, Inc.', 'EQUITY', 'Technology', 'Consumer Electronics', 1,
        JSON.stringify({ platform_url: 'https://app.racional.cl/app/ikEJ?assetId=AAPL' }), '2026-01-01', '2026-10-30');
    origin.run('racional_gsheet', 'NBIS', 'NBIS', 'Nebius Group N.V.', 'EQUITY', 'Technology', 'Software', 1,
        JSON.stringify({ platform_url: 'https://app.racional.cl/app/ikEJ?assetId=NBIS' }), '2026-01-01', '2026-10-30');
    origin.run('racional_gsheet', 'OLDCO', 'OLDCO', 'Old Co', 'EQUITY', null, null, 0, null, '2025-01-01', '2026-01-01');
    origin.run('dataroma_quarterly_buys', 'ZZZZ', 'ZZZZ', 'Other Source Inc', 'ETF', null, null, 1, null, '2026-01-01', '2026-10-30');

    const run = db.prepare(`INSERT INTO source_sync_run
        (source_code, trigger, started_at, finished_at, status, fetched, inserted, updated, reactivated, deactivated, rejected, duration_ms, error_message)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?)`);
    run.run('racional_gsheet', 'manual', '2026-10-28T10:00:00Z', '2026-10-28T10:00:05Z', 'success', 100, 100, 0, 5000, null);
    run.run('racional_gsheet', 'scheduled', '2026-10-29T10:00:00Z', '2026-10-29T10:00:03Z', 'success', 100, 0, 3, 3000, null);
    run.run('racional_gsheet', 'manual', '2026-10-30T10:00:00Z', '2026-10-30T10:00:01Z', 'failed', 0, 0, 0, 1000, 'http 503');
    run.run('dataroma_insider_buys', 'scheduled', '2026-10-30T09:00:00Z', '2026-10-30T09:02:00Z', 'success', 1400, 40, 0, 120000, null);

    const quarterly = db.prepare(`INSERT INTO recent_buys_q
        (quarter, symbol, normalized_symbol, company_name, portfolio_pct, buys_count, hold_price, current_price, low_52w, pct_above_low_52w, high_52w, source_url, first_seen_at, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    quarterly.run('2026Q3', 'AAPL', 'AAPL', 'Apple Inc.', 3.2, 4, 180.5, 210.1, 150.0, 40.1, 240.0, 'https://www.dataroma.com/m/g/portfolio_b.php', '2026-10-01', '2026-10-30');
    quarterly.run('2026Q3', 'XYZ', 'XYZ', 'Xyz Corp', 1.1, 1, 10.5, 12.0, 8.0, 50.0, 15.0, 'https://www.dataroma.com/m/g/portfolio_b.php', '2026-10-01', '2026-10-30');
    quarterly.run('2026Q2', 'AAPL', 'AAPL', 'Apple Inc.', 2.0, 2, 170.0, 210.1, 150.0, 40.1, 240.0, null, '2026-07-01', '2026-07-30');

    const insider = db.prepare(`INSERT INTO recent_buys_insider
        (filing_at, symbol, normalized_symbol, security_name, reporting_name, relationship, transaction_date, transaction_type, shares, price, amount, ownership_type, is_ten_pct_owner, is_amendment, filing_url, source_url, first_seen_at, last_synced_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    insider.run(isoDaysAgo(1), 'NBIS', 'NBIS', 'Nebius Group N.V.', 'GRIMME ARNE', 'Director', '2026-10-29', 'Purchase', 148, 169.42, 25074, 'D', 0, 0,
        'https://www.sec.gov/Archives/edgar/data/1/000.htm', 'https://www.dataroma.com/m/ins/ins.php', '2026-10-30', '2026-10-30');
    insider.run(isoDaysAgo(2), 'XYZ', 'XYZ', 'Xyz Corp', 'BIG FUND LP', '10% Owner', '2026-10-27', 'Purchase', 10000, 5.5, 55000, 'I', 1, 0,
        'https://www.sec.gov/Archives/edgar/data/2/000.htm', 'https://www.dataroma.com/m/ins/ins.php', '2026-10-28', '2026-10-28');
    insider.run(isoDaysAgo(90), 'AAPL', 'AAPL', 'Apple Inc.', 'OLD OFFICER', 'Officer', '2026-08-01', 'Purchase', 10, 150, 1500, 'D', 0, 0,
        null, 'https://www.dataroma.com/m/ins/ins.php', '2026-08-02', '2026-08-02');
    db.close();
}

describe('SourcesRepository — reads for the Fuentes and Recent buys pages', () => {
    let dbPath: string;
    let repo: SourcesRepository;

    beforeEach(() => {
        dbPath = path.join(os.tmpdir(), `sources-repo-test-${Date.now()}-${Math.random()}.sqlite`);
        seed(dbPath);
        repo = new SourcesRepository(dbPath);
    });

    afterEach(() => {
        repo.close();
        for (const suffix of ['', '-wal', '-shm']) {
            const p = dbPath + suffix;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
    });

    it('listLastRuns returns the latest run and the latest successful run per source', () => {
        const runs = repo.listLastRuns();
        expect(runs.racional_gsheet.last!.status).to.equal('failed');
        expect(runs.racional_gsheet.last!.error_message).to.equal('http 503');
        expect(runs.racional_gsheet.lastSuccess!.started_at).to.equal('2026-10-29T10:00:00Z');
        expect(runs.dataroma_insider_buys.last!.status).to.equal('success');
    });

    it('listRuns returns the newest runs of one source, limited', () => {
        const runs = repo.listRuns('racional_gsheet', 2);
        expect(runs.map(r => r.status)).to.deep.equal(['failed', 'success']);
    });

    it('listStocksOrigin filters by source, active, type and text and pages with a total', () => {
        const all = repo.listStocksOrigin({ limit: 10, offset: 0 });
        expect(all.total).to.equal(4);

        const active = repo.listStocksOrigin({ source: 'racional_gsheet', active: true, limit: 10, offset: 0 });
        expect(active.total).to.equal(2);
        expect(active.rows.map(r => r.ticker).sort()).to.deep.equal(['AAPL', 'NBIS']);
        expect(active.rows[0].platform_url).to.contain('app.racional.cl');

        expect(repo.listStocksOrigin({ assetType: 'ETF', limit: 10, offset: 0 }).total).to.equal(1);
        expect(repo.listStocksOrigin({ q: 'nebius', limit: 10, offset: 0 }).rows[0].ticker).to.equal('NBIS');
        expect(repo.listStocksOrigin({ q: 'AAP', limit: 10, offset: 0 }).rows[0].ticker).to.equal('AAPL');

        const page = repo.listStocksOrigin({ limit: 1, offset: 1 });
        expect(page.rows).to.have.length(1);
        expect(page.total).to.equal(4);
    });

    it('listQuarters and listQuarterlyBuys default to the latest quarter and flag in_platform', () => {
        expect(repo.listQuarters()).to.deep.equal(['2026Q3', '2026Q2']);
        const latest = repo.listQuarterlyBuys({});
        expect(latest.quarter).to.equal('2026Q3');
        expect(latest.rows.map(r => r.ticker)).to.have.members(['AAPL', 'XYZ']);
        const aapl = latest.rows.find(r => r.ticker === 'AAPL')!;
        expect(aapl.in_platform).to.equal(true);
        expect(aapl.portfolio_pct).to.equal(3.2);
        expect(latest.rows.find(r => r.ticker === 'XYZ')!.in_platform).to.equal(false);

        const older = repo.listQuarterlyBuys({ quarter: '2026Q2' });
        expect(older.rows).to.have.length(1);
        expect(repo.listQuarterlyBuys({ symbol: 'xyz' }).rows.map(r => r.ticker)).to.deep.equal(['XYZ']);
    });

    it('listInsiderBuys filters by days, amount, relationship, 10% owner and symbol, with in_platform', () => {
        const recent = repo.listInsiderBuys({});
        expect(recent.map(r => r.ticker)).to.deep.equal(['NBIS', 'XYZ']);
        expect(recent[0].in_platform).to.equal(true);
        expect(recent[0].filing_url).to.contain('sec.gov');
        expect(recent[1].in_platform).to.equal(false);

        expect(repo.listInsiderBuys({ days: 365 }).length).to.equal(3);
        expect(repo.listInsiderBuys({ minAmount: 30000 }).map(r => r.ticker)).to.deep.equal(['XYZ']);
        expect(repo.listInsiderBuys({ relationship: 'director' }).map(r => r.ticker)).to.deep.equal(['NBIS']);
        expect(repo.listInsiderBuys({ tenPctOnly: true }).map(r => r.ticker)).to.deep.equal(['XYZ']);
        expect(repo.listInsiderBuys({ symbol: 'nbis' }).map(r => r.ticker)).to.deep.equal(['NBIS']);
        expect(repo.listInsiderBuys({ limit: 1 }).length).to.equal(1);
    });

    it('returns empty results instead of throwing when the recent-buys tables are not migrated yet', () => {
        const bare = path.join(os.tmpdir(), `sources-repo-bare-${Date.now()}.sqlite`);
        new SourcesRepository(bare).close();
        const bareRepo = new SourcesRepository(bare);
        try {
            expect(bareRepo.listQuarters()).to.deep.equal([]);
            expect(bareRepo.listQuarterlyBuys({}).rows).to.deep.equal([]);
            expect(bareRepo.listInsiderBuys({})).to.deep.equal([]);
        } finally {
            bareRepo.close();
            for (const suffix of ['', '-wal', '-shm']) {
                if (fs.existsSync(bare + suffix)) fs.unlinkSync(bare + suffix);
            }
        }
    });
});

describe('routes/sources.ts HTTP contract', () => {
    let dbPath: string;

    const fakeService = (overrides: Partial<Record<string, any>> = {}) => ({
        listSources: async () => [
            { source_code: 'racional_gsheet', display_name: 'Racional – Stocks disponibles' },
            { source_code: 'dataroma_insider_buys', display_name: 'Dataroma insider buys' },
        ],
        isRunning: (_code: string) => false,
        sync: async (_code: string, _trigger: string) => SUCCESS_RESULT,
        ...overrides,
    });

    const router = (serviceOverrides: Partial<Record<string, any>> = {}) =>
        createSourcesRouter({
            syncService: fakeService(serviceOverrides) as any,
            dbPath,
            intervals: { racional_gsheet: 86_400_000, dataroma_insider_buys: 21_600_000 },
            schedulerEnabled: true,
        });

    beforeEach(() => {
        dbPath = path.join(os.tmpdir(), `sources-route-test-${Date.now()}-${Math.random()}.sqlite`);
        seed(dbPath);
    });

    afterEach(() => {
        for (const suffix of ['', '-wal', '-shm']) {
            const p = dbPath + suffix;
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
    });

    it('GET /api/sources lists every registered source with its last run, last success and next due', async () => {
        await withRouter(router(), async base => {
            const res = await fetch(`${base}/api/sources`);
            expect(res.status).to.equal(200);
            const body = await res.json() as any;
            expect(body.scheduler.enabled).to.equal(true);
            const sheet = body.sources.find((s: any) => s.source_code === 'racional_gsheet');
            expect(sheet.display_name).to.contain('Racional');
            expect(sheet.last_run.status).to.equal('failed');
            expect(sheet.last_success.status).to.equal('success');
            expect(sheet.interval_ms).to.equal(86_400_000);
            expect(sheet.next_due_at).to.equal(new Date(Date.parse('2026-10-29T10:00:03Z') + 86_400_000).toISOString());
            expect(sheet.running).to.equal(false);
        });
    });

    it('POST /api/sources/:code/sync returns 200 with the SyncResult on success', async () => {
        const triggers: string[] = [];
        await withRouter(router({ sync: async (_c: string, trigger: string) => { triggers.push(trigger); return SUCCESS_RESULT; } }), async base => {
            const res = await fetch(`${base}/api/sources/racional_gsheet/sync`, { method: 'POST' });
            expect(res.status).to.equal(200);
            expect((await res.json() as any).inserted).to.equal(2);
        });
        expect(triggers).to.deep.equal(['manual']);
    });

    it('POST returns 502 with the SyncResult when the sync itself failed', async () => {
        await withRouter(router({ sync: async () => FAILED_RESULT }), async base => {
            const res = await fetch(`${base}/api/sources/racional_gsheet/sync`, { method: 'POST' });
            expect(res.status).to.equal(502);
            const body = await res.json() as any;
            expect(body.status).to.equal('failed');
            expect(body.error).to.contain('missing required column');
        });
    });

    it('POST returns 409 while the same source is already syncing', async () => {
        const overrides = { sync: async () => { throw new SourceAlreadyRunningError('racional_gsheet'); } };
        await withRouter(router(overrides), async base => {
            const res = await fetch(`${base}/api/sources/racional_gsheet/sync`, { method: 'POST' });
            expect(res.status).to.equal(409);
            expect((await res.json() as any).error).to.contain('racional_gsheet');
        });
    });

    it('POST returns 404 for an unknown source code', async () => {
        await withRouter(router({ sync: async (code: string) => { throw new UnknownSourceError(code); } }), async base => {
            const res = await fetch(`${base}/api/sources/nope/sync`, { method: 'POST' });
            expect(res.status).to.equal(404);
        });
    });

    it('GET /api/sources/:code/runs returns the run history', async () => {
        await withRouter(router(), async base => {
            const res = await fetch(`${base}/api/sources/racional_gsheet/runs?limit=2`);
            expect(res.status).to.equal(200);
            const body = await res.json() as any;
            expect(body.runs).to.have.length(2);
            expect(body.runs[0].status).to.equal('failed');
        });
    });

    it('GET /api/stocks-origin applies the filters and returns total/limit/offset', async () => {
        await withRouter(router(), async base => {
            const res = await fetch(`${base}/api/stocks-origin?source=racional_gsheet&active=true&q=apple&limit=10`);
            const body = await res.json() as any;
            expect(body.total).to.equal(1);
            expect(body.rows[0].ticker).to.equal('AAPL');
            expect(body.rows[0].platform_url).to.contain('app.racional.cl');

            const bad = await fetch(`${base}/api/stocks-origin?limit=9000`);
            expect(bad.status).to.equal(400);
        });
    });

    it('GET /api/recent-buys/quarterly and /quarters serve the quarterly table', async () => {
        await withRouter(router(), async base => {
            const quarters = await (await fetch(`${base}/api/recent-buys/quarterly/quarters`)).json() as any;
            expect(quarters.quarters).to.deep.equal(['2026Q3', '2026Q2']);

            const body = await (await fetch(`${base}/api/recent-buys/quarterly`)).json() as any;
            expect(body.quarter).to.equal('2026Q3');
            expect(body.rows.find((r: any) => r.ticker === 'AAPL').in_platform).to.equal(true);
        });
    });

    it('GET /api/recent-buys/insiders applies days/minAmount/tenPctOnly', async () => {
        await withRouter(router(), async base => {
            const body = await (await fetch(`${base}/api/recent-buys/insiders?days=30&minAmount=30000`)).json() as any;
            expect(body.rows.map((r: any) => r.ticker)).to.deep.equal(['XYZ']);

            const tenPct = await (await fetch(`${base}/api/recent-buys/insiders?tenPctOnly=true`)).json() as any;
            expect(tenPct.rows).to.have.length(1);

            const bad = await fetch(`${base}/api/recent-buys/insiders?days=abc`);
            expect(bad.status).to.equal(400);
        });
    });
});
