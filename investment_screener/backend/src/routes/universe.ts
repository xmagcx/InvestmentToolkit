/**
 * universe.ts - Express routing for the curated candidate universe.
 *
 * Purpose:
 *   CRUD routes behind `/api/universe` for managing the `universe_candidate`
 *   table. Upload shells out to `ingest_universe_csv.py` via
 *   `spawnPythonScript` (reusing parse + ticker-normalization logic). List and
 *   delete read/write the table directly through `UniverseRepository`
 *   (better-sqlite3).
 *
 * Layer:
 *   Backend / Routes / Universe
 *
 * Routes Index:
 *   - POST /upload   - Accept JSON { csv: "<csv text>" }, bridge to Python ingest
 *   - GET /          - List all candidates, newest first
 *   - DELETE /:ticker- Remove one candidate by normalized ticker (404 if absent)
 *
 * Key Input Dependencies:
 *   - ../services/bridge#spawnPythonScript (Python ingest bridge)
 *   - ../services/UniverseRepository (better-sqlite3 reads/writes)
 *   - ../utils/paths#DOMAIN_MODEL_DB_FILE
 */
import express from 'express';
import { spawnPythonScript } from '../services/bridge';
import { UniverseRepository } from '../services/UniverseRepository';
import { DOMAIN_MODEL_DB_FILE } from '../utils/paths';

export interface UniverseRouteDeps {
    spawnPythonScript: (scriptName: string, args: string[]) => Promise<any>;
}

/** Handle POST /upload — parse CSV text, bridge to Python, return summary. */
export async function handleUpload(
    req: express.Request,
    res: express.Response,
    deps: UniverseRouteDeps,
    dbPath: string = DOMAIN_MODEL_DB_FILE
): Promise<void> {
    const csvText = req.body?.csv;
    if (typeof csvText !== 'string' || csvText.trim() === '') {
        res.status(400).json({ error: 'Missing "csv" field in JSON body' });
        return;
    }
    try {
        const summary = await deps.spawnPythonScript(
            'ingest_universe_csv.py',
            ['--payload', csvText, '--db-path', dbPath]
        );
        res.status(200).json(summary);
    } catch (err: any) {
        res.status(400).json({ error: err?.message ?? 'Upload failed' });
    }
}

/** Handle GET / — list all candidates, newest first. */
export async function handleList(
    _req: express.Request,
    res: express.Response,
    dbPath: string
): Promise<void> {
    const repo = new UniverseRepository(dbPath);
    try {
        res.status(200).json(repo.list());
    } finally {
        repo.close();
    }
}

/** Handle DELETE /:ticker — remove one candidate; 404 if absent. */
export async function handleDelete(
    req: express.Request,
    res: express.Response,
    dbPath: string
): Promise<void> {
    const repo = new UniverseRepository(dbPath);
    try {
        const removed = repo.delete(req.params.ticker);
        if (!removed) {
            res.status(404).json({ error: `Ticker not found: ${req.params.ticker}` });
            return;
        }
        res.status(200).json({ deleted: req.params.ticker });
    } finally {
        repo.close();
    }
}

/** Build the express Router. `dbPath` and `deps` are injectable for tests. */
export function buildUniverseRoutes(
    dbPath: string = DOMAIN_MODEL_DB_FILE,
    deps: UniverseRouteDeps = { spawnPythonScript }
): express.Router {
    const router = express.Router();

    router.post('/upload', (req, res) => handleUpload(req, res, deps, dbPath));
    router.get('/', (_req, res) => handleList(_req, res, dbPath));
    router.delete('/:ticker', (req, res) => handleDelete(req, res, dbPath));

    return router;
}

/** Default singleton bound to the real DB file. */
const universeRouter = buildUniverseRoutes();
export default universeRouter;
