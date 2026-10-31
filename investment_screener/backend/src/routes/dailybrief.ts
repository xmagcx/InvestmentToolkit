/**
 * dailybrief.ts - Express routing for daily-brief snapshot metrics.
 *
 * Purpose:
 *   Serves today's conviction scores, macro regime, pillar health, and earnings
 *   flags from the intelligence_event ledger (event_type REVIEW_DAILY).
 *
 * Layer:
 *   Backend / Routes / Daily Brief
 *
 * Routes Index:
 *   - GET /latest - Returns today's brief or the most recent available
 *   - GET /today - The brief as the prioritized review list of S9/S10 (404 when there is none)
 *   - GET /history - Returns metadata for all available snapshots
 *   - GET /conviction/:ticker - Historical conviction score for one ticker
 *   - POST /regenerate - Starts daily_brief.py in the background (202, 409 while running)
 *   - GET /regenerate/status - {running, startedAt, finishedAt, exitCode} of that run
 *
 * Key Functions (Index):
 *   - queryTodayTasksFromLedger(dbPath, domainDbPath) - runs py_services/brief_tasks.py
 *   - createDailyBriefRouter(deps) - router factory (script runner and regenerator injectable)
 *
 * Key Input Dependencies:
 *   - investment_screener/backend/data/intelligence.sqlite (intelligence_event ledger)
 *   - py_services/brief_tasks.py (task derivation lives in Python, rules 2 and 19)
 *
 * Key Output Dependencies:
 *   None
 */
import { DOMAIN_MODEL_DB_FILE } from '../utils/paths';
import { Router } from 'express';
import { spawnPythonScript } from '../services/bridge';
import { BriefRegenerator, briefRegenerator } from '../services/BriefRegenerator';

export const BRIEF_TASKS_SCRIPT = 'brief_tasks.py';

export async function queryLatestBriefFromLedger(dbPath?: string, domainDbPath?: string): Promise<any> {
    try {
        const args = ['--latest'];
        if (domainDbPath) args.push('--current-recommendations', '--domain-db', domainDbPath);
        if (dbPath) {
            args.push('--db-path', dbPath);
        }
        const data = await spawnPythonScript('query_ledger_brief.py', args);
        return data || null;
    } catch (e) {
        console.warn('Ledger query latest brief failed:', e);
        return null;
    }
}

export async function queryBriefHistoryFromLedger(dbPath?: string): Promise<any[] | null> {
    try {
        const args = ['--history'];
        if (dbPath) {
            args.push('--db-path', dbPath);
        }
        const data = await spawnPythonScript('query_ledger_brief.py', args);
        return Array.isArray(data) ? data : null;
    } catch (e) {
        console.warn('Ledger query history failed:', e);
        return null;
    }
}

export async function queryTickerConvictionFromLedger(ticker: string, dbPath?: string): Promise<any[] | null> {
    try {
        const args = ['--conviction', ticker];
        if (dbPath) {
            args.push('--db-path', dbPath);
        }
        const data = await spawnPythonScript('query_ledger_brief.py', args);
        return Array.isArray(data) ? data : null;
    } catch (e) {
        console.warn('Ledger query ticker conviction failed:', e);
        return null;
    }
}

/** The S10 /today payload, or null when the ledger holds no brief. */
export async function queryTodayTasksFromLedger(dbPath?: string, domainDbPath?: string): Promise<any> {
    const args = ['--latest'];
    if (domainDbPath) args.push('--domain-db', domainDbPath);
    if (dbPath) args.push('--db-path', dbPath);
    return (await spawnPythonScript(BRIEF_TASKS_SCRIPT, args)) || null;
}

export interface DailyBriefRouterDeps {
    runTasks?: (dbPath?: string, domainDbPath?: string) => Promise<any>;
    regenerator?: BriefRegenerator;
}

export function createDailyBriefRouter(deps: DailyBriefRouterDeps = {}): Router {
    const runTasks = deps.runTasks ?? queryTodayTasksFromLedger;
    const regenerator = deps.regenerator ?? briefRegenerator;
    const router = Router();

    /** GET /api/daily-brief/today — the prioritized review list (S9/S10). */
    router.get('/today', async (_req, res) => {
        try {
            const payload = await runTasks(undefined, DOMAIN_MODEL_DB_FILE);
            if (!payload) {
                res.status(404).json({ error: 'Todavía no hay un brief diario generado.', code: 'NO_BRIEF' });
                return;
            }
            res.json(payload);
        } catch (e: any) {
            console.error('[DailyBrief] today failed:', e);
            res.status(500).json({ error: e.message });
        }
    });

    /** POST /api/daily-brief/regenerate — starts the brief in the background. */
    router.post('/regenerate', (_req, res) => {
        if (!regenerator.start()) {
            res.status(409).json({ error: 'El brief ya se está regenerando.', code: 'REGENERATE_RUNNING' });
            return;
        }
        res.status(202).json({ started: true });
    });

    /** GET /api/daily-brief/regenerate/status — how that background run is doing. */
    router.get('/regenerate/status', (_req, res) => {
        res.json(regenerator.status());
    });

    return router;
}

const router = Router();
router.use(createDailyBriefRouter());

/** GET /api/daily-brief/latest — returns today's brief or the most recent available. */
router.get('/latest', async (_req, res) => {
    try {
        const brief = await queryLatestBriefFromLedger(undefined, DOMAIN_MODEL_DB_FILE);
        if (!brief) {
            res.status(404).json({ error: 'No daily brief found. Run: python3 investment_screener/backend/py_services/daily_brief.py' });
            return;
        }
        res.json(brief);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** GET /api/daily-brief/history — returns metadata for all available snapshots. */
router.get('/history', async (_req, res) => {
    try {
        const history = await queryBriefHistoryFromLedger();
        res.json(history ?? []);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

/** GET /api/daily-brief/conviction/:ticker — historical conviction score for one ticker. */
router.get('/conviction/:ticker', async (req, res) => {
    try {
        const ticker = req.params.ticker.toUpperCase();
        const convictionHistory = await queryTickerConvictionFromLedger(ticker);
        res.json(convictionHistory ?? []);
    } catch (e: any) {
        res.status(500).json({ error: e.message });
    }
});

export default router;


