/**
 * sources.ts (TypeScript Service)
 * =====================================
 *
 * Purpose:
 *     API client for the investment sources surface: the "Fuentes" page (registered sources,
 *     manual sync, stocks_origin catalogue) and the "Compras recientes" page (Dataroma
 *     quarterly and insider buys). Same pattern as services/api.ts: relative /api calls, the
 *     Vite dev proxy attaches the local API token.
 *
 * Layer: Frontend / Services / API
 *
 * Usage Examples:
 *     const { sources } = await fetchSources();
 *     const result = await syncSource('racional_gsheet');
 *
 * Key Functions:
 *     - fetchSources() - registered sources with last run, last success and next due
 *     - syncSource(code) - POST the manual sync; throws SyncConflictError on 409
 *     - fetchStocksOrigin(filters) - paginated catalogue rows
 *     - fetchQuarters() / fetchQuarterlyBuys(filters) - Dataroma superinvestor buys
 *     - fetchInsiderBuys(filters) - Dataroma insider buys
 *     - tradingViewUrl(ticker) - public (logged-out) TradingView symbol page
 *
 * Key Input Dependencies:
 *     - Backend routes mounted at /api (backend/src/routes/sources.ts)
 *     - utils/tradingViewSymbol.ts (the one ticker -> TradingView symbol mapping)
 */
import { toTradingViewSymbol } from '../utils/tradingViewSymbol';

export interface SourceRun {
    id: number;
    source_code: string;
    trigger: string;
    started_at: string;
    finished_at: string | null;
    status: 'running' | 'success' | 'failed';
    fetched: number;
    inserted: number;
    updated: number;
    reactivated: number;
    deactivated: number;
    rejected: number;
    duration_ms: number | null;
    error_message: string | null;
}

export interface SourceSummary {
    source_code: string;
    display_name: string;
    running: boolean;
    last_run: SourceRun | null;
    last_success: SourceRun | null;
    interval_ms: number | null;
    next_due_at: string | null;
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

export interface StocksOriginRow {
    id: number;
    source_code: string;
    ticker: string;
    company_name: string | null;
    asset_type: string | null;
    sector: string | null;
    industry: string | null;
    currency: string | null;
    country: string | null;
    is_active: boolean;
    platform_url: string | null;
    first_seen_at: string | null;
    last_seen_at: string | null;
}

export interface QuarterlyBuyRow {
    ticker: string;
    quarter: string;
    company_name: string | null;
    portfolio_pct: number | null;
    buys_count: number | null;
    hold_price: number | null;
    current_price: number | null;
    low_52w: number | null;
    pct_above_low_52w: number | null;
    high_52w: number | null;
    source_url: string | null;
    in_platform: boolean;
}

export interface InsiderBuyRow {
    ticker: string;
    filing_at: string;
    security_name: string | null;
    reporting_name: string | null;
    relationship: string | null;
    transaction_date: string | null;
    transaction_type: string | null;
    shares: number | null;
    price: number | null;
    amount: number | null;
    ownership_type: string | null;
    is_ten_pct_owner: boolean;
    is_amendment: boolean;
    filing_url: string | null;
    in_platform: boolean;
}

/** A sync of this source is already running (HTTP 409) — the UI says so instead of retrying. */
export class SyncConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SyncConflictError';
    }
}

function query(params: Record<string, string | number | boolean | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
        if (value === undefined || value === '') continue;
        search.set(key, String(value));
    }
    const text = search.toString();
    return text ? `?${text}` : '';
}

export async function fetchSources(): Promise<{ sources: SourceSummary[]; scheduler: { enabled: boolean } }> {
    const response = await fetch('/api/sources');
    if (!response.ok) throw new Error('No se pudieron cargar las fuentes');
    return response.json();
}

/** Returns the SyncResult for both outcomes: a failed sync is data the page shows. */
export async function syncSource(sourceCode: string): Promise<SyncResult> {
    const response = await fetch(`/api/sources/${encodeURIComponent(sourceCode)}/sync`, { method: 'POST' });
    const body = await response.json().catch(() => null);
    if (response.status === 409) {
        throw new SyncConflictError(body?.error ?? `Ya hay una sincronización en curso para ${sourceCode}`);
    }
    if (response.status === 200 || response.status === 502) return body as SyncResult;
    throw new Error(body?.error ?? `La sincronización falló (HTTP ${response.status})`);
}

export async function fetchStocksOrigin(filters: {
    source?: string;
    active?: boolean;
    assetType?: string;
    q?: string;
    limit?: number;
    offset?: number;
}): Promise<{ rows: StocksOriginRow[]; total: number; limit: number; offset: number }> {
    const response = await fetch(`/api/stocks-origin${query(filters)}`);
    if (!response.ok) throw new Error('No se pudo cargar el catálogo de instrumentos');
    return response.json();
}

export async function fetchQuarters(): Promise<string[]> {
    const response = await fetch('/api/recent-buys/quarterly/quarters');
    if (!response.ok) throw new Error('No se pudieron cargar los trimestres');
    return (await response.json()).quarters;
}

export async function fetchQuarterlyBuys(filters: { quarter?: string; symbol?: string }): Promise<{ quarter: string | null; rows: QuarterlyBuyRow[] }> {
    const response = await fetch(`/api/recent-buys/quarterly${query(filters)}`);
    if (!response.ok) throw new Error('No se pudieron cargar las compras del trimestre');
    return response.json();
}

export async function fetchInsiderBuys(filters: {
    symbol?: string;
    minAmount?: number;
    relationship?: string;
    tenPctOnly?: boolean;
    days?: number;
}): Promise<{ rows: InsiderBuyRow[]; days: number }> {
    const response = await fetch(`/api/recent-buys/insiders${query(filters)}`);
    if (!response.ok) throw new Error('No se pudieron cargar las compras de insiders');
    return response.json();
}

/** Public TradingView symbol page — no login, no CDP (S5's anonymous rule). The symbol comes
 * from the shared mapper; its `EXCHANGE:TICKER` form is `EXCHANGE-TICKER` in a page URL. */
export function tradingViewUrl(ticker: string): string {
    return `https://www.tradingview.com/symbols/${toTradingViewSymbol(ticker).replace(':', '-')}/`;
}
