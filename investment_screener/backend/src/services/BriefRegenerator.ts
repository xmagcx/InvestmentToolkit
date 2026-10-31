/**
 * BriefRegenerator.ts - background re-run of the daily brief (S10).
 *
 * Purpose:
 *   Behind POST /api/daily-brief/regenerate. daily_brief.py takes minutes (TA sweep, news,
 *   ledger write), so the request only starts it: the process is spawned detached, the route
 *   answers 202 and the page polls GET /regenerate/status. One in-process lock keeps a second
 *   click (or a second tab) from starting a parallel writer of the same ledger event.
 *
 *   The lock is per process, which is exactly the scope that matters here: one backend runs
 *   the button. A brief started from the terminal is not covered and never was.
 *
 * Layer:
 *   Backend / Services / Daily Brief
 *
 * Usage Examples:
 *   if (!briefRegenerator.start()) res.status(409)...
 *   new BriefRegenerator({ spawnProcess: fakeSpawn });  // in tests
 *
 * Key Functions (Index):
 *   - DAILY_BRIEF_SCRIPT - the canonical brief builder this service runs
 *   - BriefRegenerator.start() - starts a run, false when one is already running
 *   - BriefRegenerator.status() - {running, startedAt, finishedAt, exitCode}
 *   - briefRegenerator - the process-wide singleton (its lock is the lock)
 *
 * Key Input Dependencies:
 *   - investment_screener/backend/py_services/daily_brief.py
 *
 * Key Output Dependencies:
 *   - daily_brief.py writes the REVIEW_DAILY event; this service writes nothing itself
 */
import { spawn } from 'child_process';
import path from 'path';

export const DAILY_BRIEF_SCRIPT = 'daily_brief.py';

export interface RegenerateStatus {
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
}

/** Only what this service needs of a child process, so a test can inject a plain fake. */
export interface BackgroundProcess {
    on(event: string, listener: (...args: any[]) => void): unknown;
    unref?(): void;
}

export type BackgroundSpawner = (command: string, args: string[]) => BackgroundProcess;

export interface BriefRegeneratorOptions {
    spawnProcess?: BackgroundSpawner;
    scriptPath?: string;
    now?: () => Date;
}

const defaultSpawner: BackgroundSpawner = (command, args) =>
    spawn(command, args, { detached: true, stdio: 'ignore' });

export class BriefRegenerator {
    private readonly spawnProcess: BackgroundSpawner;
    private readonly scriptPath: string;
    private readonly now: () => Date;
    private state: RegenerateStatus = { running: false, startedAt: null, finishedAt: null, exitCode: null };

    constructor(options: BriefRegeneratorOptions = {}) {
        this.spawnProcess = options.spawnProcess ?? defaultSpawner;
        this.scriptPath = options.scriptPath
            ?? path.resolve(__dirname, '../../py_services', DAILY_BRIEF_SCRIPT);
        this.now = options.now ?? (() => new Date());
    }

    /** Start a run. Returns false (and changes nothing) when one is already running. */
    start(): boolean {
        if (this.state.running) return false;
        const command = process.platform === 'win32' ? 'python' : 'python3';
        this.state = { running: true, startedAt: this.now().toISOString(), finishedAt: null, exitCode: null };
        const child = this.spawnProcess(command, [this.scriptPath]);
        child.on('exit', (code: number | null) => this.finish(code ?? -1));
        child.on('error', () => this.finish(-1));
        child.unref?.();
        return true;
    }

    status(): RegenerateStatus {
        return { ...this.state };
    }

    private finish(exitCode: number): void {
        if (!this.state.running) return;
        this.state = { ...this.state, running: false, finishedAt: this.now().toISOString(), exitCode };
    }
}

export const briefRegenerator = new BriefRegenerator();
