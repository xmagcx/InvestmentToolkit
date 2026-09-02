/**
 * universe.spec.ts — RED phase tests for routes/universe.ts.
 *
 * Exercises the exported route handlers directly with tmp-scoped SQLite
 * (never the real domain_model.sqlite), mocking the Python bridge for upload.
 */
import { expect } from 'chai';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { buildUniverseRoutes } from '../../src/routes/universe';

/** Minimal mock Express `res` capturing status/json. */
function mockRes() {
    const res: any = {
        statusCode: 200,
        body: null,
        status(code: number) { this.statusCode = code; return this; },
        json(payload: any) { this.body = payload; return this; },
    };
    return res;
}

/** Minimal mock Express `req`. */
function mockReq(overrides: any = {}) {
    return { params: {}, body: {}, ...overrides } as any;
}

/**
 * Mock the Python ingest bridge: parse the passed CSV text (dbPath is the 4th
 * element of argv: [script, --payload, csvText, --db-path, dbPath]) and write
 * rows into that tmp db, returning a summary — faithfully simulating what
 * ingest_universe_csv.py does.
 */
function realishSpawn(dbPath: string) {
    return async (_script: string, args: string[]) => {
        const csvText = args[args.indexOf('--payload') + 1];
        const target = args[args.indexOf('--db-path') + 1];
        const db = new Database(target);
        db.exec(`CREATE TABLE IF NOT EXISTS universe_candidate (
            ticker TEXT PRIMARY KEY, name TEXT NOT NULL, source TEXT NOT NULL,
            asset_class TEXT, added_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)`);
        let inserted = 0, skipped = 0;
        const lines = csvText.split('\n').filter((l: string) => l.trim() !== '');
        lines.shift(); // header
        const stmt = db.prepare('INSERT OR IGNORE INTO universe_candidate (ticker,name,source) VALUES (?,?,?)');
        for (const line of lines) {
            const [t, n, s] = line.split(',');
            const info = stmt.run(t?.trim(), n?.trim(), s?.trim());
            if (info.changes) inserted++; else skipped++;
        }
        db.close();
        return { inserted, skipped, errors: [] };
    };
}

/** Create a tmp db path and construct routes with given bridge impl. */
function newDbPath() {
    return path.join(os.tmpdir(), `universe-test-${Date.now()}-${Math.random()}.sqlite`);
}

function setup(dbPath: string, spawnImpl: (...args: any[]) => Promise<any>) {
    const router = buildUniverseRoutes(dbPath, { spawnPythonScript: spawnImpl });
    // Extract handlers from the router's stack.
    const handlers: Record<string, any> = {};
    for (const layer of (router as any).stack || []) {
        const method = Object.keys(layer.route?.methods || {})[0];
        const p = layer.route?.path;
        if (method && p) handlers[`${method.toUpperCase()} ${p}`] = layer.route.stack[0].handle;
    }
    return { dbPath, router, handlers };
}

function cleanup(dbPath: string) {
    for (const s of ['', '-wal', '-shm']) {
        const p = dbPath + s;
        if (fs.existsSync(p)) fs.unlinkSync(p);
    }
}

describe('routes/universe.ts', () => {
    afterEach(() => { /* cleanup handled per-test */ });

    describe('POST /upload', () => {
        it('returns 200 with summary on successful upload', async () => {
            const spawn = async () => ({ inserted: 2, skipped: 0, errors: [] });
            const { handlers, dbPath } = setup(newDbPath(), spawn);
            const res = mockRes();
            await handlers['POST /upload'](
                mockReq({ body: { csv: 'ticker,name,source\nAAPL,Apple,RACIONAL\nMSFT,Microsoft,RACIONAL\n' } }),
                res, () => {});
            expect(res.statusCode).to.equal(200);
            expect(res.body).to.deep.equal({ inserted: 2, skipped: 0, errors: [] });
            cleanup(dbPath);
        });

        it('returns 400 when body has wrong headers', async () => {
            const spawn = async () => { throw new Error('Header mismatch'); };
            const { handlers, dbPath } = setup(newDbPath(), spawn);
            const res = mockRes();
            await handlers['POST /upload'](
                mockReq({ body: { csv: 'bad,headers\nx,y\n' } }),
                res, () => {});
            expect(res.statusCode).to.equal(400);
            expect(res.body.error).to.exist;
            cleanup(dbPath);
        });

        it('returns 400 when body has no csv field', async () => {
            const spawn = async () => ({ inserted: 0, skipped: 0, errors: [] });
            const { handlers, dbPath } = setup(newDbPath(), spawn);
            const res = mockRes();
            await handlers['POST /upload'](mockReq({ body: {} }), res, () => {});
            expect(res.statusCode).to.equal(400);
            cleanup(dbPath);
        });
    });

    describe('GET /', () => {
        it('returns 200 with array of candidates', async () => {
            const dbPath = newDbPath();
            const { handlers } = setup(dbPath, realishSpawn(dbPath));
            // Seed via upload (realish mock persists to tmp DB).
            await handlers['POST /upload'](
                mockReq({ body: { csv: 'ticker,name,source\nAAPL,Apple,RACIONAL\nMSFT,Microsoft,RACIONAL\n' } }),
                mockRes(), () => {});
            const res = mockRes();
            await handlers['GET /'](mockReq(), res, () => {});
            expect(res.statusCode).to.equal(200);
            expect(res.body).to.be.an('array');
            expect(res.body.length).to.equal(2);
            cleanup(dbPath);
        });

        it('returns 200 with empty array when no candidates', async () => {
            const spawn = async () => ({ inserted: 0, skipped: 0, errors: [] });
            const { handlers, dbPath } = setup(newDbPath(), spawn);
            const res = mockRes();
            await handlers['GET /'](mockReq(), res, () => {});
            expect(res.statusCode).to.equal(200);
            expect(res.body).to.deep.equal([]);
            cleanup(dbPath);
        });
    });

    describe('DELETE /:ticker', () => {
        it('returns 200 and removes the row', async () => {
            const dbPath = newDbPath();
            const { handlers } = setup(dbPath, realishSpawn(dbPath));
            await handlers['POST /upload'](
                mockReq({ body: { csv: 'ticker,name,source\nAAPL,Apple,RACIONAL\n' } }),
                mockRes(), () => {});
            const res = mockRes();
            await handlers['DELETE /:ticker'](mockReq({ params: { ticker: 'AAPL' } }), res, () => {});
            expect(res.statusCode).to.equal(200);
            const res2 = mockRes();
            await handlers['GET /'](mockReq(), res2, () => {});
            expect(res2.body).to.deep.equal([]);
            cleanup(dbPath);
        });

        it('returns 404 when ticker not found', async () => {
            const spawn = async () => ({ inserted: 0, skipped: 0, errors: [] });
            const { handlers, dbPath } = setup(newDbPath(), spawn);
            const res = mockRes();
            await handlers['DELETE /:ticker'](mockReq({ params: { ticker: 'ZZZZ' } }), res, () => {});
            expect(res.statusCode).to.equal(404);
            cleanup(dbPath);
        });
    });
});
