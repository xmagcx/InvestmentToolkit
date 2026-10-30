/**
 * SourceScheduler.ts - in-process scheduled re-sync of the investment sources (S8).
 *
 * Purpose:
 *   Keeps `stocks_origin` and the recent-buys tables fresh without the manual button: every
 *   10 minutes (first tick 60 s after boot) it asks which sources are due and syncs them
 *   sequentially with trigger 'scheduled', through the same SourceSyncService singleton — so
 *   a scheduled run and a button press can never run the same source twice.
 *
 *   A source is due when it has no successful run, or its last successful `finished_at` is
 *   older than its interval. It is skipped while it is syncing, and while its last run failed
 *   less than 30 minutes ago (a broken source must not be retried every tick).
 *
 * Layer:
 *   Backend / Services / Investment Sources
 *
 * Usage Examples:
 *   const scheduler = new SourceScheduler({});   // reads env + the real repository
 *   scheduler.start();                           // called from index.ts after listen()
 *
 * Key Functions (Index):
 *   - parseIntervals(spec, logger) - "code=6h,..." -> {code: ms}; invalid entries are logged and ignored
 *   - intervalsFromEnv(env, logger) - SOURCE_SYNC_INTERVALS or DEFAULT_SOURCE_SYNC_INTERVALS
 *   - schedulerEnabled(env) - SOURCE_SYNC_SCHEDULER ("off" disables, default on)
 *   - parseDbTimestamp(value) - SQLite ISO or "YYYY-MM-DD HH:MM:SS" (UTC) -> epoch ms
 *   - nextDueAt(lastSuccessFinishedAt, intervalMs, now) - ISO instant of the next scheduled run
 *   - SourceScheduler.dueSources() - the codes this tick would sync
 *   - SourceScheduler.tick() - sync every due source sequentially
 *   - SourceScheduler.start() / stop() - timer lifecycle
 *
 * Key Input Dependencies:
 *   - env SOURCE_SYNC_SCHEDULER ("on" | "off", default "on")
 *   - env SOURCE_SYNC_INTERVALS ("racional_gsheet=24h,dataroma_insider_buys=6h,...")
 *   - investment_screener/backend/data/domain_model.sqlite (source_sync_run, read via SourcesRepository)
 *
 * Key Output Dependencies:
 *   - source_sync_run rows (written by the Python sync it triggers)
 */
import { SourceSyncService, sourceSyncService } from './SourceSyncService';
import { SourcesRepository, SourceLastRuns } from './SourcesRepository';
import { DOMAIN_MODEL_DB_FILE } from '../utils/paths';

export const DEFAULT_SOURCE_SYNC_INTERVALS =
    'racional_gsheet=24h,dataroma_quarterly_buys=24h,dataroma_insider_buys=6h,yfinance_enrichment=1h';
export const FIRST_TICK_DELAY_MS = 60_000;
export const TICK_INTERVAL_MS = 600_000;
/** A source that just failed waits this long before the scheduler tries again. */
export const FAILURE_BACKOFF_MS = 30 * 60_000;

const UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

export interface SchedulerLogger {
    log: (message: string) => void;
    warn: (message: string) => void;
    error: (message: string) => void;
}

const consoleLogger: SchedulerLogger = {
    log: m => console.log(m),
    warn: m => console.warn(m),
    error: m => console.error(m),
};

export function parseIntervals(spec: string, logger: SchedulerLogger = consoleLogger): Record<string, number> {
    const intervals: Record<string, number> = {};
    for (const entry of spec.split(',')) {
        const text = entry.trim();
        if (!text) continue;
        const match = /^([a-z0-9_]+)\s*=\s*(\d+)([mhd])$/i.exec(text.replace(/\s*=\s*/, '='));
        const amount = match ? parseInt(match[2], 10) : 0;
        if (!match || amount <= 0) {
            logger.warn(`[SourceScheduler] Ignoring invalid interval entry '${text}' in SOURCE_SYNC_INTERVALS`);
            continue;
        }
        intervals[match[1]] = amount * UNIT_MS[match[3].toLowerCase()];
    }
    return intervals;
}

export function intervalsFromEnv(
    env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
    logger: SchedulerLogger = consoleLogger
): Record<string, number> {
    return parseIntervals(env.SOURCE_SYNC_INTERVALS || DEFAULT_SOURCE_SYNC_INTERVALS, logger);
}

export function schedulerEnabled(
    env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env
): boolean {
    return (env.SOURCE_SYNC_SCHEDULER ?? 'on').trim().toLowerCase() !== 'off';
}

/** SQLite stores either an ISO instant (Python) or 'YYYY-MM-DD HH:MM:SS' UTC (CURRENT_TIMESTAMP). */
export function parseDbTimestamp(value: string | null | undefined): number | null {
    if (!value) return null;
    const text = value.trim();
    const normalized = /[T]/.test(text) ? text : text.replace(' ', 'T');
    const withZone = /[Z+]|[-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`;
    const ms = Date.parse(withZone);
    return Number.isNaN(ms) ? null : ms;
}

export function nextDueAt(
    lastSuccessFinishedAt: string | null | undefined,
    intervalMs: number,
    now: number = Date.now()
): string | null {
    if (!intervalMs) return null;
    const last = parseDbTimestamp(lastSuccessFinishedAt);
    if (last === null) return new Date(now).toISOString();
    return new Date(last + intervalMs).toISOString();
}

export interface LastRunsProvider {
    listLastRuns: () => SourceLastRuns;
}

export interface SourceSchedulerOptions {
    syncService?: SourceSyncService;
    runs?: LastRunsProvider;
    intervals?: Record<string, number>;
    enabled?: boolean;
    dbPath?: string;
    now?: () => number;
    logger?: SchedulerLogger;
    setTimer?: typeof setTimeout;
    setRepeatingTimer?: typeof setInterval;
    clearTimer?: (handle: any) => void;
}

export class SourceScheduler {
    private readonly syncService: SourceSyncService;
    private readonly runs: LastRunsProvider;
    private readonly intervals: Record<string, number>;
    private readonly enabled: boolean;
    private readonly now: () => number;
    private readonly logger: SchedulerLogger;
    private readonly setTimer: typeof setTimeout;
    private readonly setRepeatingTimer: typeof setInterval;
    private readonly clearTimer: (handle: any) => void;
    private firstTickHandle: any = null;
    private intervalHandle: any = null;
    private ticking = false;

    constructor(options: SourceSchedulerOptions = {}) {
        const dbPath = options.dbPath ?? DOMAIN_MODEL_DB_FILE;
        this.syncService = options.syncService ?? sourceSyncService;
        this.logger = options.logger ?? consoleLogger;
        this.runs = options.runs ?? {
            listLastRuns: () => {
                const repo = new SourcesRepository(dbPath);
                try {
                    return repo.listLastRuns();
                } finally {
                    repo.close();
                }
            },
        };
        this.intervals = options.intervals ?? intervalsFromEnv(process.env, this.logger);
        this.enabled = options.enabled ?? schedulerEnabled();
        this.now = options.now ?? (() => Date.now());
        this.setTimer = options.setTimer ?? setTimeout;
        this.setRepeatingTimer = options.setRepeatingTimer ?? setInterval;
        this.clearTimer = options.clearTimer ?? ((handle: any) => { clearTimeout(handle); clearInterval(handle); });
    }

    start(): void {
        if (!this.enabled) {
            this.logger.log('[SourceScheduler] Disabled (SOURCE_SYNC_SCHEDULER=off)');
            return;
        }
        const configured = Object.entries(this.intervals).map(([code, ms]) => `${code}=${Math.round(ms / 60_000)}m`);
        this.logger.log(`[SourceScheduler] Enabled — ${configured.join(', ') || 'no sources configured'}`);
        this.firstTickHandle = this.setTimer(() => void this.tick(), FIRST_TICK_DELAY_MS);
        this.intervalHandle = this.setRepeatingTimer(() => void this.tick(), TICK_INTERVAL_MS);
    }

    stop(): void {
        if (this.firstTickHandle) { this.clearTimer(this.firstTickHandle); this.firstTickHandle = null; }
        if (this.intervalHandle) { this.clearTimer(this.intervalHandle); this.intervalHandle = null; }
    }

    /** The registered, scheduled sources this tick would sync, in registry order. */
    async dueSources(): Promise<string[]> {
        const registered = await this.syncService.listSources();
        const lastRuns = this.runs.listLastRuns();
        const now = this.now();
        const due: string[] = [];

        for (const { source_code: code } of registered) {
            const intervalMs = this.intervals[code];
            if (!intervalMs) continue;
            if (this.syncService.isRunning(code)) continue;

            const entry = lastRuns[code];
            const lastFailedAt = entry?.last?.status === 'failed'
                ? parseDbTimestamp(entry.last.finished_at ?? entry.last.started_at)
                : null;
            if (lastFailedAt !== null && now - lastFailedAt < FAILURE_BACKOFF_MS) continue;

            const lastSuccessAt = parseDbTimestamp(entry?.lastSuccess?.finished_at ?? entry?.lastSuccess?.started_at);
            if (lastSuccessAt !== null && now - lastSuccessAt < intervalMs) continue;
            due.push(code);
        }
        return due;
    }

    /** Sync every due source, one at a time; a failure is logged and retried on a later tick. */
    async tick(): Promise<string[]> {
        if (this.ticking) {
            this.logger.log('[SourceScheduler] Previous tick still running — skipping this one');
            return [];
        }
        this.ticking = true;
        const synced: string[] = [];
        try {
            const due = await this.dueSources();
            for (const code of due) {
                try {
                    const result = await this.syncService.sync(code, 'scheduled');
                    synced.push(code);
                    if (result.status === 'success') {
                        this.logger.log(`[SourceScheduler] ${code}: success (inserted ${result.inserted}, updated ${result.updated})`);
                    } else {
                        this.logger.error(`[SourceScheduler] ${code}: failed — ${result.error ?? 'unknown error'}`);
                    }
                } catch (err) {
                    this.logger.error(`[SourceScheduler] ${code}: ${(err as Error).message}`);
                }
            }
        } catch (err) {
            this.logger.error(`[SourceScheduler] Tick failed: ${(err as Error).message}`);
        } finally {
            this.ticking = false;
        }
        return synced;
    }
}
