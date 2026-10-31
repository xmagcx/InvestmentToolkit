/**
 * dailyBrief.ts (TypeScript Service)
 * ==================================
 *
 * Purpose:
 *     API client for the redesigned "Brief diario": today's review list, and the background
 *     regeneration of the brief. Same pattern as services/opportunities.ts — relative /api
 *     calls, the Vite dev proxy attaches the local API token.
 *
 * Layer: Frontend / Services / API
 *
 * Usage Examples:
 *     const brief = await fetchTodayBrief();
 *     await startBriefRegeneration();
 *     const { running } = await fetchRegenerationStatus();
 *
 * Key Functions:
 *     - fetchTodayBrief() - today's brief; throws NoBriefError when the backend has none (404).
 *     - startBriefRegeneration() - 202 accepted; throws BriefBusyError when already running (409).
 *     - fetchRegenerationStatus() - whether the background run is still going.
 *
 * Key Input Dependencies:
 *     - Backend routes GET /api/daily-brief/today, POST /api/daily-brief/regenerate,
 *       GET /api/daily-brief/regenerate/status (contract S10 of odd/tasks/opportunities-and-brief.md)
 */

export type Urgency = 'alta' | 'media' | 'baja';

export interface MarketIndicator {
    key: string;
    label: string;
    value: number | string | null;
    /** Already formatted for Spanish reading ("+4,1 %", "sano"). */
    display: string;
}

export interface BriefMarket {
    regime: string;
    /** Regime in one word, as the page prints it ("neutral"). */
    label: string;
    sentence: string;
    indicators: MarketIndicator[];
}

export interface BriefTask {
    urgency: Urgency;
    ticker: string;
    summary: string;
    action: string;
    tag: string;
    link: 'analysis' | 'watchlist';
}

export interface UntaskedHolding {
    ticker: string;
    status: string;
    rsi: number | null;
    note: string;
}

export interface DailyBriefToday {
    date: string;
    generatedAt: string;
    market: BriefMarket;
    tasks: BriefTask[];
    untasked: UntaskedHolding[];
    taFresh: boolean;
    taNote: string | null;
    counts: { tasks: number; untasked: number };
}

export interface RegenerationStatus {
    running: boolean;
    startedAt: string | null;
    finishedAt: string | null;
    exitCode: number | null;
}

/** 404 NO_BRIEF: no brief has been generated for today yet. */
export class NoBriefError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NoBriefError';
    }
}

/** 409: a regeneration is already running in the background. */
export class BriefBusyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BriefBusyError';
    }
}

export async function fetchTodayBrief(signal?: AbortSignal): Promise<DailyBriefToday> {
    const response = await fetch('/api/daily-brief/today', { signal });
    const body = await response.json().catch(() => null);
    if (response.status === 404 && body?.code === 'NO_BRIEF') {
        throw new NoBriefError(body?.error ?? 'Todavía no hay brief de hoy');
    }
    if (!response.ok) {
        throw new Error(body?.error ?? `No se pudo cargar el brief (HTTP ${response.status})`);
    }
    return body as DailyBriefToday;
}

export async function startBriefRegeneration(): Promise<void> {
    const response = await fetch('/api/daily-brief/regenerate', { method: 'POST' });
    const body = await response.json().catch(() => null);
    if (response.status === 409) {
        throw new BriefBusyError(body?.error ?? 'Ya se está generando');
    }
    if (!response.ok) {
        throw new Error(body?.error ?? `No se pudo regenerar el brief (HTTP ${response.status})`);
    }
}

export async function fetchRegenerationStatus(): Promise<RegenerationStatus> {
    const response = await fetch('/api/daily-brief/regenerate/status');
    if (!response.ok) {
        throw new Error(`No se pudo consultar la regeneración (HTTP ${response.status})`);
    }
    return response.json() as Promise<RegenerationStatus>;
}
