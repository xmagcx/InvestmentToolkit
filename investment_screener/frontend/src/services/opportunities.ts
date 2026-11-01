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
 *     - fetchSentiment(ticker) - market Fear & Greed and the ticker's headline sentiment, shown
 *       only inside an expanded row (informative: never a star, never a filter).
 *
 * Key Input Dependencies:
 *     - Backend routes GET /api/opportunities and GET /api/sentiment/:ticker (contract S15 of
 *       odd/tasks/opportunities-and-brief.md)
 */

/** Step numbers 1..6: gana, calidad, precio, caida, sana, expertos. */
export type StepId = 'gana' | 'calidad' | 'precio' | 'caida' | 'sana' | 'expertos';

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
    /** Step 5 (S11): Sortino 3y ≥, downside beta 3y ≤, net EPS revisions 30d ≥. */
    sortino: number;
    dbeta: number;
    rev: number;
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
    sortino: 0.5,
    dbeta: 1.2,
    rev: 0,
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

/** 3-year risk history of the stock (S14 stock_risk_metrics); null when history < 2 years. */
export interface RowRisk {
    sortino: number | null;
    sharpe: number | null;
    downsideBeta: number | null;
    /** Negative fraction: -0.38 = fell 38 %. */
    maxDrawdown: number | null;
    recoveryDays: number | null;
    volatility: number | null;
    asOf: string;
}

/** Analyst EPS revisions of the current year (S14 stock_eps_revisions). */
export interface RowRevisions {
    up30: number;
    down30: number;
    net: number;
    up7: number;
    down7: number;
}

export interface TopHolder {
    manager: string;
    pct: number | null;
    activity: string;
}

/** Dataroma: the quarter gate plus the informational holding facts of S12. */
export interface RowDataroma {
    superinvestors: number;
    holdPrice: number | null;
    insiders: number;
    insiderCluster: boolean;
    holders: number;
    holdersPrev: number | null;
    maxPortfolioPct: number | null;
    avgHoldPrice: number | null;
    belowExpertsPrice: boolean;
    netActivity: number | null;
    topHolders: TopHolder[];
}

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
    risk: RowRisk | null;
    revisions: RowRevisions | null;
    dataroma: RowDataroma;
}

export interface SentimentHeadline {
    title: string;
    publisher: string;
    url: string;
    publishedAt: string;
    score: number;
}

/** GET /api/sentiment/:ticker (S15): a failing part is null, never invented. */
export interface SentimentResponse {
    market: { score: number; rating: string; label: string; asOf: string } | null;
    ticker: {
        score: number;
        label: 'Positivo' | 'Neutral' | 'Negativo';
        headlines: SentimentHeadline[];
        asOf: string;
    } | null;
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
        sortino: String(params.sortino),
        dbeta: String(params.dbeta),
        rev: String(params.rev),
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

export async function fetchSentiment(ticker: string, signal?: AbortSignal): Promise<SentimentResponse> {
    const response = await fetch(`/api/sentiment/${encodeURIComponent(ticker)}`, { signal });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
        throw new Error(body?.error ?? `No se pudo leer el sentimiento (HTTP ${response.status})`);
    }
    return body as SentimentResponse;
}
