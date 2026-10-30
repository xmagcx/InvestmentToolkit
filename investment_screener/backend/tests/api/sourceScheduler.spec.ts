/**
 * sourceScheduler.spec.ts
 *
 * Purpose: covers T7/S8 — the in-process scheduler that re-syncs investment sources:
 * interval parsing from env (bad entries ignored, never fatal), the due rule (no successful
 * run, or last success older than the interval), the skips (source locked, recent failure)
 * and the off switch. Clock, timers and the sync service are injected; nothing spawns Python
 * and nothing touches the real database.
 */
import { expect } from 'chai';
import {
    SourceScheduler,
    parseIntervals,
    intervalsFromEnv,
    schedulerEnabled,
    parseDbTimestamp,
    nextDueAt,
    DEFAULT_SOURCE_SYNC_INTERVALS,
    FIRST_TICK_DELAY_MS,
    TICK_INTERVAL_MS,
    FAILURE_BACKOFF_MS,
} from '../../src/services/SourceScheduler';

const HOUR = 3_600_000;
const silent = { log: () => {}, warn: () => {}, error: () => {} };

describe('SourceScheduler interval configuration', () => {
    it('parses m/h/d units', () => {
        expect(parseIntervals('a=30m,b=6h,c=2d', silent)).to.deep.equal({ a: 1_800_000, b: 6 * HOUR, c: 172_800_000 });
    });

    it('ignores invalid entries (logged, never fatal) and keeps the valid ones', () => {
        const warnings: string[] = [];
        const parsed = parseIntervals('a=6h,b=,=5h,c=12x,d=0h, e = 1h ', { ...silent, warn: (m: string) => warnings.push(m) });
        expect(parsed).to.deep.equal({ a: 6 * HOUR, e: HOUR });
        expect(warnings.join(' ')).to.contain('c=12x');
    });

    it('defaults to the four registered sources when the env var is unset', () => {
        expect(intervalsFromEnv({}, silent)).to.deep.equal(parseIntervals(DEFAULT_SOURCE_SYNC_INTERVALS, silent));
        expect(intervalsFromEnv({}, silent)).to.deep.equal({
            racional_gsheet: 24 * HOUR,
            dataroma_quarterly_buys: 24 * HOUR,
            dataroma_insider_buys: 6 * HOUR,
            yfinance_enrichment: HOUR,
        });
    });

    it('SOURCE_SYNC_SCHEDULER=off disables it; anything else (or unset) leaves it on', () => {
        expect(schedulerEnabled({})).to.equal(true);
        expect(schedulerEnabled({ SOURCE_SYNC_SCHEDULER: 'on' })).to.equal(true);
        expect(schedulerEnabled({ SOURCE_SYNC_SCHEDULER: 'off' })).to.equal(false);
        expect(schedulerEnabled({ SOURCE_SYNC_SCHEDULER: 'OFF' })).to.equal(false);
    });

    it('reads SQLite timestamps written as ISO or as "YYYY-MM-DD HH:MM:SS" UTC', () => {
        expect(parseDbTimestamp('2026-10-30T10:00:00Z')).to.equal(Date.parse('2026-10-30T10:00:00Z'));
        expect(parseDbTimestamp('2026-10-30 10:00:00')).to.equal(Date.parse('2026-10-30T10:00:00Z'));
        expect(parseDbTimestamp(null)).to.equal(null);
        expect(parseDbTimestamp('not a date')).to.equal(null);
    });

    it('nextDueAt is the last success plus the interval, and now when there is none', () => {
        const now = Date.parse('2026-10-30T12:00:00Z');
        expect(nextDueAt('2026-10-30T10:00:00Z', 6 * HOUR)).to.equal('2026-10-30T16:00:00.000Z');
        expect(nextDueAt(null, 6 * HOUR, now)).to.equal(new Date(now).toISOString());
    });
});

describe('SourceScheduler due/skip behaviour', () => {
    const sources = [
        { source_code: 'racional_gsheet', display_name: 'Racional' },
        { source_code: 'dataroma_insider_buys', display_name: 'Insiders' },
        { source_code: 'unscheduled_source', display_name: 'No interval' },
    ];
    const intervals = { racional_gsheet: 24 * HOUR, dataroma_insider_buys: 6 * HOUR, missing_source: HOUR };
    const now = Date.parse('2026-10-30T12:00:00Z');

    function build(lastRuns: Record<string, any>, opts: { running?: string[]; syncImpl?: any } = {}) {
        const synced: Array<[string, string]> = [];
        const running = new Set(opts.running ?? []);
        const scheduler = new SourceScheduler({
            syncService: {
                listSources: async () => sources,
                isRunning: (code: string) => running.has(code),
                sync: async (code: string, trigger: string) => {
                    synced.push([code, trigger]);
                    if (opts.syncImpl) return opts.syncImpl(code);
                    return { source_code: code, status: 'success' };
                },
            } as any,
            runs: { listLastRuns: () => lastRuns },
            intervals,
            now: () => now,
            logger: silent,
        });
        return { scheduler, synced };
    }

    const success = (finishedAt: string) => ({ status: 'success', finished_at: finishedAt, started_at: finishedAt });
    const failed = (finishedAt: string) => ({ status: 'failed', finished_at: finishedAt, started_at: finishedAt, error_message: 'boom' });

    it('a source with no run at all is due', async () => {
        const { scheduler } = build({});
        expect(await scheduler.dueSources()).to.deep.equal(['racional_gsheet', 'dataroma_insider_buys']);
    });

    it('a source whose last success is younger than its interval is skipped', async () => {
        const { scheduler } = build({
            racional_gsheet: { last: success('2026-10-30T06:00:00Z'), lastSuccess: success('2026-10-30T06:00:00Z') },
            dataroma_insider_buys: { last: success('2026-10-30T11:00:00Z'), lastSuccess: success('2026-10-30T11:00:00Z') },
        });
        expect(await scheduler.dueSources()).to.deep.equal([]);
    });

    it('a source whose last success is older than its interval is due', async () => {
        const { scheduler } = build({
            racional_gsheet: { last: success('2026-10-29T06:00:00Z'), lastSuccess: success('2026-10-29T06:00:00Z') },
            dataroma_insider_buys: { last: success('2026-10-30T05:00:00Z'), lastSuccess: success('2026-10-30T05:00:00Z') },
        });
        expect(await scheduler.dueSources()).to.deep.equal(['racional_gsheet', 'dataroma_insider_buys']);
    });

    it('skips a source that is already running (the service lock is shared)', async () => {
        const { scheduler } = build({}, { running: ['racional_gsheet'] });
        expect(await scheduler.dueSources()).to.deep.equal(['dataroma_insider_buys']);
    });

    it('skips a source whose last run failed less than 30 minutes ago, and retries it after', async () => {
        const recent = new Date(now - FAILURE_BACKOFF_MS + 60_000).toISOString();
        const old = new Date(now - FAILURE_BACKOFF_MS - 60_000).toISOString();
        expect(await build({ racional_gsheet: { last: failed(recent), lastSuccess: null } }).scheduler.dueSources())
            .to.deep.equal(['dataroma_insider_buys']);
        expect(await build({ racional_gsheet: { last: failed(old), lastSuccess: null } }).scheduler.dueSources())
            .to.deep.equal(['racional_gsheet', 'dataroma_insider_buys']);
    });

    it('ignores configured codes that are not registered sources, and registered sources without an interval', async () => {
        const { scheduler } = build({});
        const due = await scheduler.dueSources();
        expect(due).to.not.include('missing_source');
        expect(due).to.not.include('unscheduled_source');
    });

    it('tick syncs every due source sequentially with trigger "scheduled"', async () => {
        const order: string[] = [];
        const { scheduler, synced } = build({}, {
            syncImpl: (code: string) => {
                order.push(`start:${code}`);
                return new Promise(resolve => setTimeout(() => {
                    order.push(`end:${code}`);
                    resolve({ source_code: code, status: 'success' });
                }, 5));
            },
        });
        await scheduler.tick();
        expect(synced).to.deep.equal([['racional_gsheet', 'scheduled'], ['dataroma_insider_buys', 'scheduled']]);
        expect(order).to.deep.equal(['start:racional_gsheet', 'end:racional_gsheet', 'start:dataroma_insider_buys', 'end:dataroma_insider_buys']);
    });

    it('a throwing sync is logged and does not stop the other sources', async () => {
        const errors: string[] = [];
        const synced: string[] = [];
        const scheduler = new SourceScheduler({
            syncService: {
                listSources: async () => sources,
                isRunning: () => false,
                sync: async (code: string) => {
                    synced.push(code);
                    if (code === 'racional_gsheet') throw new Error('python exploded');
                    return { source_code: code, status: 'success' };
                },
            } as any,
            runs: { listLastRuns: () => ({}) },
            intervals,
            now: () => now,
            logger: { ...silent, error: (m: string) => errors.push(m) },
        });
        await scheduler.tick();
        expect(synced).to.deep.equal(['racional_gsheet', 'dataroma_insider_buys']);
        expect(errors.join(' ')).to.contain('python exploded');
    });

    it('start() schedules the first tick after 60s and then every 10 minutes; stop() clears both', async () => {
        const timeouts: Array<{ ms: number; fn: () => void }> = [];
        const intervalsSet: Array<{ ms: number; fn: () => void }> = [];
        let cleared = 0;
        const scheduler = new SourceScheduler({
            syncService: { listSources: async () => sources, isRunning: () => false, sync: async () => ({ status: 'success' }) } as any,
            runs: { listLastRuns: () => ({}) },
            intervals,
            now: () => now,
            logger: silent,
            setTimer: ((fn: () => void, ms: number) => { timeouts.push({ ms, fn }); return { id: timeouts.length } as any; }) as any,
            setRepeatingTimer: ((fn: () => void, ms: number) => { intervalsSet.push({ ms, fn }); return { id: intervalsSet.length } as any; }) as any,
            clearTimer: (() => { cleared += 1; }) as any,
        });
        scheduler.start();
        expect(timeouts[0].ms).to.equal(FIRST_TICK_DELAY_MS);
        expect(FIRST_TICK_DELAY_MS).to.equal(60_000);
        expect(intervalsSet[0].ms).to.equal(TICK_INTERVAL_MS);
        expect(TICK_INTERVAL_MS).to.equal(600_000);
        scheduler.stop();
        expect(cleared).to.equal(2);
    });

    it('start() does nothing when the scheduler is disabled', () => {
        let timers = 0;
        const scheduler = new SourceScheduler({
            syncService: { listSources: async () => sources, isRunning: () => false, sync: async () => ({ status: 'success' }) } as any,
            runs: { listLastRuns: () => ({}) },
            intervals,
            enabled: false,
            now: () => now,
            logger: silent,
            setTimer: ((fn: () => void, ms: number) => { timers += 1; return { id: ms } as any; }) as any,
            setRepeatingTimer: ((fn: () => void, ms: number) => { timers += 1; return { id: ms } as any; }) as any,
        });
        scheduler.start();
        expect(timers).to.equal(0);
    });
});
