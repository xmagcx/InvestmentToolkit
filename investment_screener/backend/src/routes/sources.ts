/**
 * sources.ts - Express routing for the investment sources (S4/S6/S7/S8).
 *
 * Purpose:
 *   HTTP surface of the "Fuentes" page (registered sources, their run history, the manual
 *   Sync button, the stocks_origin catalogue) and of the "Compras recientes" page (Dataroma
 *   quarterly and insider buys). Reads go through SourcesRepository; the sync itself goes
 *   through the SourceSyncService singleton, whose per-source lock is what makes 409 real.
 *
 * Layer:
 *   Backend / Routes / Investment Sources
 *
 * Routes Index (mounted at /api):
 *   - GET  /sources - registered sources + last run + last success + interval + next due
 *   - POST /sources/:code/sync - run one sync (200 success, 502 failed, 409 running, 404 unknown)
 *   - GET  /sources/:code/runs?limit - run history of one source
 *   - GET  /stocks-origin?source&active&assetType&q&limit&offset - paginated catalogue
 *   - GET  /recent-buys/quarterly?quarter&symbol - one quarter of superinvestor buys
 *   - GET  /recent-buys/quarterly/quarters - quarters available, newest first
 *   - GET  /recent-buys/insiders?symbol&minAmount&relationship&tenPctOnly&days&limit - insider buys
 *
 * Key Functions (Index):
 *   - createSourcesRouter(deps) - router factory (service, dbPath, intervals injectable for tests)
 *   - default export - the router wired to the real singleton, database and env intervals
 *
 * Key Input Dependencies:
 *   - investment_screener/backend/data/domain_model.sqlite (via SourcesRepository)
 *   - py_services/investment_sources/sync_cli.py (via SourceSyncService)
 *
 * Key Output Dependencies:
 *   - JSON payloads use `ticker`; SQL keeps `symbol`
 */
import express from 'express';
import { z } from 'zod';
import { DOMAIN_MODEL_DB_FILE } from '../utils/paths';
import {
    SourceSyncService,
    sourceSyncService,
    SourceAlreadyRunningError,
    UnknownSourceError,
} from '../services/SourceSyncService';
import { SourcesRepository, MAX_ROW_LIMIT } from '../services/SourcesRepository';
import { intervalsFromEnv, nextDueAt, schedulerEnabled } from '../services/SourceScheduler';

export interface SourcesRouterDeps {
    syncService?: SourceSyncService;
    dbPath?: string;
    intervals?: Record<string, number>;
    schedulerEnabled?: boolean;
}

const boolish = z
    .enum(['true', 'false', '1', '0'])
    .transform(v => v === 'true' || v === '1');

const stocksOriginQuery = z.object({
    source: z.string().min(1).optional(),
    active: boolish.optional(),
    assetType: z.string().min(1).optional(),
    q: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(MAX_ROW_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).optional(),
});

const quarterlyQuery = z.object({
    quarter: z.string().regex(/^\d{4}Q[1-4]$/).optional(),
    symbol: z.string().min(1).optional(),
    limit: z.coerce.number().int().positive().max(MAX_ROW_LIMIT).optional(),
});

const insidersQuery = z.object({
    symbol: z.string().min(1).optional(),
    minAmount: z.coerce.number().min(0).optional(),
    relationship: z.string().min(1).optional(),
    tenPctOnly: boolish.optional(),
    days: z.coerce.number().int().positive().max(3650).optional(),
    limit: z.coerce.number().int().positive().max(MAX_ROW_LIMIT).optional(),
});

const runsQuery = z.object({
    limit: z.coerce.number().int().positive().max(MAX_ROW_LIMIT).optional(),
});

export function createSourcesRouter(deps: SourcesRouterDeps = {}): express.Router {
    const router = express.Router();
    const syncService = deps.syncService ?? sourceSyncService;
    const dbPath = deps.dbPath ?? DOMAIN_MODEL_DB_FILE;
    const intervals = deps.intervals ?? intervalsFromEnv();
    const isSchedulerEnabled = deps.schedulerEnabled ?? schedulerEnabled();

    /** Open a short-lived repository per request, like the other SQLite-backed routes. */
    function withRepo<T>(fn: (repo: SourcesRepository) => T): T {
        const repo = new SourcesRepository(dbPath);
        try {
            return fn(repo);
        } finally {
            repo.close();
        }
    }

    function badRequest(res: express.Response, error: z.ZodError): void {
        res.status(400).json({ error: 'Invalid query parameters', details: error.issues });
    }

    router.get('/sources', async (_req, res) => {
        try {
            const registered = await syncService.listSources();
            const lastRuns = withRepo(repo => repo.listLastRuns());
            res.json({
                scheduler: { enabled: isSchedulerEnabled },
                sources: registered.map(source => {
                    const entry = lastRuns[source.source_code] ?? { last: null, lastSuccess: null };
                    const intervalMs = intervals[source.source_code] ?? null;
                    return {
                        source_code: source.source_code,
                        display_name: source.display_name,
                        running: syncService.isRunning(source.source_code),
                        last_run: entry.last,
                        last_success: entry.lastSuccess,
                        interval_ms: intervalMs,
                        next_due_at: intervalMs
                            ? nextDueAt(entry.lastSuccess?.finished_at ?? null, intervalMs)
                            : null,
                    };
                }),
            });
        } catch (error: any) {
            res.status(503).json({ error: error.message });
        }
    });

    router.post('/sources/:code/sync', async (req, res) => {
        const code = req.params.code;
        try {
            const result = await syncService.sync(code, 'manual');
            res.status(result.status === 'success' ? 200 : 502).json(result);
        } catch (error: any) {
            if (error instanceof UnknownSourceError) {
                res.status(404).json({ error: error.message, source_code: code });
                return;
            }
            if (error instanceof SourceAlreadyRunningError) {
                res.status(409).json({ error: error.message, source_code: code });
                return;
            }
            res.status(500).json({ error: error.message, source_code: code });
        }
    });

    router.get('/sources/:code/runs', (req, res) => {
        const parsed = runsQuery.safeParse(req.query);
        if (!parsed.success) { badRequest(res, parsed.error); return; }
        try {
            res.json({ runs: withRepo(repo => repo.listRuns(req.params.code, parsed.data.limit ?? 20)) });
        } catch (error: any) {
            res.status(503).json({ error: error.message });
        }
    });

    router.get('/stocks-origin', (req, res) => {
        const parsed = stocksOriginQuery.safeParse(req.query);
        if (!parsed.success) { badRequest(res, parsed.error); return; }
        const { limit = 100, offset = 0 } = parsed.data;
        try {
            const result = withRepo(repo => repo.listStocksOrigin({ ...parsed.data, limit, offset }));
            res.json({ ...result, limit, offset });
        } catch (error: any) {
            res.status(503).json({ error: error.message });
        }
    });

    router.get('/recent-buys/quarterly/quarters', (_req, res) => {
        try {
            res.json({ quarters: withRepo(repo => repo.listQuarters()) });
        } catch (error: any) {
            res.status(503).json({ error: error.message });
        }
    });

    router.get('/recent-buys/quarterly', (req, res) => {
        const parsed = quarterlyQuery.safeParse(req.query);
        if (!parsed.success) { badRequest(res, parsed.error); return; }
        try {
            res.json(withRepo(repo => repo.listQuarterlyBuys(parsed.data)));
        } catch (error: any) {
            res.status(503).json({ error: error.message });
        }
    });

    router.get('/recent-buys/insiders', (req, res) => {
        const parsed = insidersQuery.safeParse(req.query);
        if (!parsed.success) { badRequest(res, parsed.error); return; }
        try {
            const rows = withRepo(repo => repo.listInsiderBuys(parsed.data));
            res.json({ rows, days: parsed.data.days ?? 30 });
        } catch (error: any) {
            res.status(503).json({ error: error.message });
        }
    });

    return router;
}

export default createSourcesRouter();
