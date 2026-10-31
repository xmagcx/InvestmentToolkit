/**
 * opportunities.ts (TypeScript Service)
 * =====================================
 *
 * Purpose:
 *     API client for the Oportunidades screener over the Racional universe: one typed GET
 *     against /api/opportunities with the six guided questions (which ones are required) and
 *     their thresholds. Same pattern as services/sources.ts: relative /api call, the Vite dev
 *     proxy attaches the local API token.
 *
 * Layer: Frontend / Services / API
 *
 * Usage Examples:
 *     const data = await fetchOpportunities({ ...DEFAULT_OPPORTUNITIES_PARAMS, require: [1, 4] });
 *
 * Key Functions:
 *     - fetchOpportunities(params) - the screened rows, the funnel counts and the star histogram;
 *       throws ScreenDataMissingError when the backend has no scanner snapshot yet (503).
 *
 * Key Input Dependencies:
 *     - Backend route GET /api/opportunities (contract S8 of odd/tasks/opportunities-and-brief.md)
 */

/** Step numbers 1..6: gana, calidad, precio, caida, giro, expertos. */
export type StepId = 'gana' | 'calidad' | 'precio' | 'caida' | 'giro' | 'expertos';

export interface OpportunitiesParams {
    /** Step numbers the user demands; the rest only add a star. */
    require: number[];
    roic: number;
    roe: number;
    roa: number;
    de: number;
    mos: number;
    fcfy: number;
    peg: number;
    target: number;
    drop: number;
    rsi: number;
    sup: number;
    ins: number;
    etf: boolean;
}

export const DEFAULT_OPPORTUNITIES_PARAMS: OpportunitiesParams = {
    require: [1, 4],
    roic: 15,
    roe: 15,
    roa: 7,
    de: 0.5,
    mos: 25,
    fcfy: 5,
    peg: 1,
    target: 20,
    drop: 20,
    rsi: 35,
    sup: 1,
    ins: 2,
    etf: false,
};

export interface GroupItem {
    key: string;
    label: string;
    value: number | null;
    display: string;
    threshold: string;
    /** null when the metric does not apply to this sector (never costs a star). */
    ok: boolean | null;
}

export interface OpportunityGroup {
    ok: boolean;
    notApplicable: boolean;
    items: GroupItem[];
}

/** The five star-bearing groups (step 1 "gana" is a prerequisite and gives no star). */
export type GroupId = Exclude<StepId, 'gana'>;

export interface OpportunityRow {
    ticker: string;
    name: string;
    sector: string;
    stars: number;
    groups: Record<GroupId, OpportunityGroup>;
    price: number;
    high52: number;
    dropPct: number;
    eps: number | null;
    growthPct: number | null;
    graham: { value: number; mos: number; formula: { eps: number; g: number; y: number } } | null;
    roic: number | null;
    pe: number | null;
    sectorPe: number | null;
    fcfYield: number | null;
    rsi: number | null;
    macd: number | null;
    macdSignal: number | null;
    sma50: number | null;
    sma200: number | null;
    aboveSma50: boolean;
    belowSma200: boolean;
    analysts: { buy: number; hold: number; sell: number; total: number; targetPct: number | null } | null;
    dataroma: { superinvestors: number; holdPrice: number | null; insiders: number; insiderCluster: boolean };
}

export interface StepSummary {
    n: number;
    id: StepId;
    required: boolean;
    /** How many stocks are left after this question, given the required ones. */
    remaining: number;
}

export interface OpportunitiesResponse {
    asOf: string;
    scannerUpdateMode: string;
    aaaYield: { value: number; asOf: string };
    universe: number;
    steps: StepSummary[];
    resultCount: number;
    starHistogram: Record<string, number>;
    rows: OpportunityRow[];
}

/** 503 SCREEN_DATA_MISSING: the TradingView screener snapshot has not been synced yet. */
export class ScreenDataMissingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ScreenDataMissingError';
    }
}

function query(params: OpportunitiesParams): string {
    const search = new URLSearchParams({
        require: params.require.join(','),
        roic: String(params.roic),
        roe: String(params.roe),
        roa: String(params.roa),
        de: String(params.de),
        mos: String(params.mos),
        fcfy: String(params.fcfy),
        peg: String(params.peg),
        target: String(params.target),
        drop: String(params.drop),
        rsi: String(params.rsi),
        sup: String(params.sup),
        ins: String(params.ins),
        etf: params.etf ? '1' : '0',
    });
    return `?${search.toString()}`;
}

export async function fetchOpportunities(
    params: OpportunitiesParams,
    signal?: AbortSignal,
): Promise<OpportunitiesResponse> {
    const response = await fetch(`/api/opportunities${query(params)}`, { signal });
    const body = await response.json().catch(() => null);
    if (response.status === 503 && body?.code === 'SCREEN_DATA_MISSING') {
        throw new ScreenDataMissingError(body?.error ?? 'Todavía no hay datos del screener');
    }
    if (!response.ok) {
        throw new Error(body?.error ?? `No se pudieron cargar las oportunidades (HTTP ${response.status})`);
    }
    return body as OpportunitiesResponse;
}
