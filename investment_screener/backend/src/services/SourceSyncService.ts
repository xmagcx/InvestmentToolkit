/**
 * SourceSyncService.ts - runs one investment-source sync through the Python CLI.
 *
 * Purpose:
 *   The single Node entry point behind the "Fuentes" Sync button (S4) and the scheduler (S8).
 *   It validates the requested source against the registry (`sync_cli.py --list`, cached in
 *   memory), holds a per-source in-memory lock so a second sync of the same source is refused
 *   with 409 instead of racing the first, and returns the SyncResult the CLI prints — including
 *   a failed one, because a failed sync is data the UI shows, not an exception.
 *   Node never writes to the database here: all writes happen inside the Python sync.
 *
 * Layer:
 *   Backend / Services / Investment Sources
 *
 * Usage Examples:
 *   const result = await sourceSyncService.sync('racional_gsheet', 'manual');
 *   if (sourceSyncService.isRunning('racional_gsheet')) { ... }
 *
 * Key Functions (Index):
 *   - SourceAlreadyRunningError - thrown when the same source is mid-sync (-> HTTP 409)
 *   - UnknownSourceError - thrown when the code is not registered (-> HTTP 404)
 *   - SourceSyncService.listSources() - registered {source_code, display_name}, cached
 *   - SourceSyncService.isRunning(code) - lock state, shared with the scheduler
 *   - SourceSyncService.sync(code, trigger) - run one sync and return its SyncResult
 *   - sourceSyncService - the process-wide singleton (its lock is the lock)
 *
 * Key Input Dependencies:
 *   - investment_screener/backend/py_services/investment_sources/sync_cli.py
 *
 * Key Output Dependencies:
 *   - stocks_origin / source_sync_run rows (written by the Python sync, not by this file)
 */
import { runPythonScriptFresh } from './bridge';

export const SYNC_CLI = 'investment_sources/sync_cli.py';
/** Dataroma's insider feed paginates 14 pages at >= 2 s each, so a sync is minutes, not seconds. */
export const SYNC_TIMEOUT_MS = 10 * 60_000;
export const LIST_TIMEOUT_MS = 60_000;

export type SyncTrigger = 'manual' | 'scheduled' | 'cli';

export interface SourceDescriptor {
    source_code: string;
    display_name: string;
}

export interface SyncResult {
    source_code: string;
    status: 'success' | 'failed';
    fetched: number;
    inserted: number;
    updated: number;
    reactivated: number;
    deactivated: number;
    rejected: number;
    duration_ms: number | null;
    error: string | null;
    run_id: number | null;
}

export class SourceAlreadyRunningError extends Error {
    readonly code = 'ALREADY_RUNNING';
    constructor(public readonly sourceCode: string) {
        super(`A sync of '${sourceCode}' is already running`);
        this.name = 'SourceAlreadyRunningError';
    }
}

export class UnknownSourceError extends Error {
    readonly code = 'UNKNOWN_SOURCE';
    constructor(public readonly sourceCode: string) {
        super(`Unknown source '${sourceCode}'`);
        this.name = 'UnknownSourceError';
    }
}

/** Only what this service reads of a bridge run, so a test can inject a plain fake. */
type ScriptRunner = (scriptRelPath: string, args: string[], timeoutMs: number) => Promise<{ exitCode: number; json: any }>;

export interface SourceSyncServiceOptions {
    runScript?: ScriptRunner;
    timeoutMs?: number;
    dbPath?: string;
}

export class SourceSyncService {
    private readonly runScript: ScriptRunner;
    private readonly timeoutMs: number;
    private readonly dbPath?: string;
    private readonly running = new Set<string>();
    private sourcesCache: SourceDescriptor[] | null = null;

    constructor(options: SourceSyncServiceOptions = {}) {
        this.runScript = options.runScript ?? runPythonScriptFresh;
        this.timeoutMs = options.timeoutMs ?? SYNC_TIMEOUT_MS;
        this.dbPath = options.dbPath;
    }

    /** Registered sources, read once from `sync_cli.py --list` and kept in memory
     * (the registry only changes when the backend is redeployed). */
    async listSources(): Promise<SourceDescriptor[]> {
        if (this.sourcesCache) return this.sourcesCache;
        const run = await this.runScript(SYNC_CLI, ['--list'], LIST_TIMEOUT_MS);
        const sources = (run.json?.sources ?? []) as SourceDescriptor[];
        this.sourcesCache = sources;
        return sources;
    }

    isRunning(sourceCode: string): boolean {
        return this.running.has(sourceCode);
    }

    /** Run one sync. Throws UnknownSourceError / SourceAlreadyRunningError; a sync that ran
     * and failed comes back as a SyncResult with status 'failed'. */
    async sync(sourceCode: string, trigger: SyncTrigger): Promise<SyncResult> {
        const known = await this.listSources();
        if (!known.some(s => s.source_code === sourceCode)) {
            throw new UnknownSourceError(sourceCode);
        }
        if (this.running.has(sourceCode)) {
            throw new SourceAlreadyRunningError(sourceCode);
        }
        this.running.add(sourceCode);
        try {
            const args = ['--source', sourceCode, '--trigger', trigger];
            if (this.dbPath) args.push('--db', this.dbPath);
            const run = await this.runScript(SYNC_CLI, args, this.timeoutMs);
            if (!run.json || typeof run.json.status !== 'string') {
                throw new Error(`sync_cli.py returned no SyncResult for '${sourceCode}'`);
            }
            return run.json as SyncResult;
        } finally {
            this.running.delete(sourceCode);
        }
    }
}

/** Process-wide singleton: the lock only works if every caller shares one instance. */
export const sourceSyncService = new SourceSyncService();
