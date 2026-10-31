/**
 * OpportunitiesService.ts - runs the opportunity screening engine and memoises its answer (S8).
 *
 * Purpose:
 *   The single Node entry point behind GET /api/opportunities. It spawns
 *   `py_services/opportunity_screener.py` (the canonical engine, rule 19 — Node never reimplements
 *   a formula and never reads the screening tables itself), passing the validated parameters as
 *   one JSON argument, and keeps the answer in memory for 60 s per distinct parameter set so the
 *   page's debounced filter changes do not spawn one Python process per keystroke.
 *
 *   The engine's "no scanner snapshot yet" exit is data, not a crash: it arrives as exit code 1
 *   with {code: SCREEN_DATA_MISSING} on stdout and becomes ScreenDataMissingError (-> HTTP 503).
 *
 * Layer:
 *   Backend / Services / Opportunities
 *
 * Usage Examples:
 *   const response = await opportunitiesService.screen({ require: '1,4', mos: 25 });
 *   new OpportunitiesService({ runScript: fakeRunner, now: () => clock });  // in tests
 *
 * Key Functions (Index):
 *   - OPPORTUNITY_SCRIPT / SCREEN_TIMEOUT_MS / CACHE_TTL_MS - the script, its timeout, the memo TTL
 *   - ScreenDataMissingError - no TradingView snapshot yet (-> HTTP 503, code SCREEN_DATA_MISSING)
 *   - OpportunitiesService.screen(params) - the S8 response for one parameter set
 *   - opportunitiesService - the process-wide singleton (its cache is the cache)
 *
 * Key Input Dependencies:
 *   - investment_screener/backend/py_services/opportunity_screener.py
 *   - investment_screener/backend/data/domain_model.sqlite (read by the engine, not by Node)
 *
 * Key Output Dependencies:
 *   - none: the screener is read-only
 */
import { runPythonScriptFresh } from './bridge';

export const OPPORTUNITY_SCRIPT = 'opportunity_screener.py';
/** The engine scans the whole snapshot in-process; a minute is generous even for 2 500 rows. */
export const SCREEN_TIMEOUT_MS = 60_000;
/** The scanner snapshot changes at most every few hours, so a one-minute memo is safe. */
export const CACHE_TTL_MS = 60_000;

export const SCREEN_DATA_MISSING = 'SCREEN_DATA_MISSING';

export class ScreenDataMissingError extends Error {
    readonly code = SCREEN_DATA_MISSING;
    constructor(message: string) {
        super(message);
        this.name = 'ScreenDataMissingError';
    }
}

/** Only what this service reads of a bridge run, so a test can inject a plain fake. */
type ScriptRunner = (scriptRelPath: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number; json: any }>;

export interface OpportunitiesServiceOptions {
    runScript?: ScriptRunner;
    dbPath?: string;
    timeoutMs?: number;
    ttlMs?: number;
    now?: () => number;
}

export class OpportunitiesService {
    private readonly runScript: ScriptRunner;
    private readonly dbPath?: string;
    private readonly timeoutMs: number;
    private readonly ttlMs: number;
    private readonly now: () => number;
    private readonly cache = new Map<string, { at: number; value: any }>();

    constructor(options: OpportunitiesServiceOptions = {}) {
        this.runScript = options.runScript ?? runPythonScriptFresh;
        this.dbPath = options.dbPath;
        this.timeoutMs = options.timeoutMs ?? SCREEN_TIMEOUT_MS;
        this.ttlMs = options.ttlMs ?? CACHE_TTL_MS;
        this.now = options.now ?? (() => Date.now());
    }

    /** The S8 response for one parameter set, from the 60 s memo or from a fresh engine run. */
    async screen(params: Record<string, unknown>): Promise<any> {
        const key = JSON.stringify(params, Object.keys(params).sort());
        const cached = this.cache.get(key);
        if (cached && this.now() - cached.at < this.ttlMs) return cached.value;

        const args = ['--params', key];
        if (this.dbPath) args.push('--db', this.dbPath);
        const run = await this.runScript(OPPORTUNITY_SCRIPT, args, this.timeoutMs);
        if (run.json?.code === SCREEN_DATA_MISSING) {
            throw new ScreenDataMissingError(run.json.error ?? 'No hay datos del screener todavía');
        }
        if (run.exitCode !== 0 || !run.json) {
            throw new Error(`opportunity_screener.py failed (exit ${run.exitCode})`);
        }
        this.cache.set(key, { at: this.now(), value: run.json });
        return run.json;
    }
}

export const opportunitiesService = new OpportunitiesService();
