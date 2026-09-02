/**
 * api.ts (TypeScript Service)
 * =====================================
 *
 * Purpose:
 *     Central API client for interacting with the Node.js backend. Handles data fetching for stocks, portfolio summaries,
 *     TradingView portfolio sync, and DCF projections.
 *
 * Layer: Frontend / Services / API
 *
 * Usage Examples:
 *     import { fetchStockData } from './services/api';
 *     const data = await fetchStockData('AAPL');
 *
 * Key Functions:
 *     - fetchStockData() - Retrieves comprehensive financial and profile data for a specific ticker
 *     - fetchPortfolioSummary() - Fetches account-level valuation metrics (USD/CAD) and YTD performance
 *     - saveProjection() - Persists a versioned DCF projection object to the backend
 */
export interface StockData {
    symbol: string;
    price: number;
    currency: string;
    profile: {
        sector: string;
        industry: string;
        description: string;
    };
    metrics: {
        pe_ratio: number;
        forward_pe: number;
        market_cap: number;
        beta: number;
        revenue: number;
        shares_outstanding: number;
        shares_diluted?: number;
        peg_ratio?: number;
        revenue_growth?: number;
        profit_margin?: number;
    };
    performance?: {
        "1d": number;
        "1w": number;
        "1m": number;
        "3m": number;
        "ytd": number;
        "1y": number;
        "5y": number;
    };
    expert_metrics: {
        rule_of_40: {
            score: number;
            revenue_growth: number;
            ebitda_margin: number;
            is_saas: boolean;
        };
        piotroski_f_score: {
            score: number;
            max: number;
            details: {
                roa_positive: boolean;
                cfo_positive: boolean;
                roa_improving: boolean;
                accruals_ok: boolean;
                leverage_decreasing: boolean;
                current_ratio_improving: boolean;
                no_dilution: boolean;
                gross_margin_improving: boolean;
                asset_turnover_improving: boolean;
            };
        };
    };
    financials: {
        historical_revenue: number[];
        historical_net_income: number[];
        historical_fcf: number[];
        historical_gross_margin: number[];
        historical_operating_margin: number[];
        historical_net_margin: number[];
        historical_eps: number[];
    };
    analyst_revenue_forecast?: Array<{
        year: number;
        avg: number;
        low: number;
        high: number;
        period: string;
    }>;
    analyst_earnings_forecast?: Array<{
        year: number;
        avg: number;
        low: number;
        high: number;
        period: string;
    }>;
    analyst_estimates?: {
        target_high_price: number;
        target_low_price: number;
        target_mean_price: number;
        target_median_price: number;
        recommendation: string;
        number_of_analysts: number;
        revenue_growth?: number;
        profit_margin?: number;
        forward_pe?: number;
    };
    growth_estimates?: {
        stockTrend: {
            "0q": number;
            "+1q": number;
            "0y": number;
            "+1y": number;
        };
    };
    quarterly_margin?: number;
    error?: string;
}

// --- Portfolio Summary ---

export interface PortfolioSummary {
    positionCount: number;
    totalMarketValueUSD: number;
    totalMarketValueCAD: number;
    totalBookValueUSD: number;
    totalBookValueCAD: number;
    ytdStartValueCAD: number;
    ytdStartValueUSD: number;
    ytdChangeCAD: number;
    ytdChangePctCAD: number;
    ytdSimpleReturnPctCAD: number;
    ytdChangeUSD: number;
    ytdChangePctUSD: number;
    unrealizedGainUSD: number;
    unrealizedGainPctUSD: number;
    unrealizedGainCAD: number;
    unrealizedGainPctCAD: number;
    liveUsdCadRate: number;
    jan1UsdCadRate: number;
    lastUpdated: string;
    price_source?: string;
}

export const fetchPortfolioSummary = async (): Promise<PortfolioSummary> => {
    const response = await fetch('/api/portfolio/summary');
    if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to fetch portfolio summary');
    }
    return await response.json();
};

// --- Portfolio Period Performance ---

export interface PeriodPerformance {
    change: number;
    changePct: number;
    historicalValue: number;
    currentValue: number;
}

export interface PortfolioPerformance {
    '1d': PeriodPerformance | null;
    '1w': PeriodPerformance | null;
    '1m': PeriodPerformance | null;
}

export const fetchPortfolioPerformance = async (): Promise<PortfolioPerformance> => {
    const response = await fetch('/api/portfolio/performance');
    if (!response.ok) throw new Error('Failed to fetch portfolio performance');
    return await response.json();
};

// --- Strategy Allocation ---

export interface StrategyHolding {
    symbol: string;
    name: string;
    sector: string;
    subStrategyId: string | null;
    shares: number;
    price: number;
    valueUSD: number;
    pct: number;
}

export interface StrategyAllocationItem {
    id: string;
    name: string;
    valueUSD: number;
    pct: number;
    holdings: StrategyHolding[];
}

export interface StrategyAllocation {
    allocation: StrategyAllocationItem[];
    totalUSD: number;
}

export const fetchStrategyAllocation = async (): Promise<StrategyAllocation> => {
    const response = await fetch('/api/portfolio/strategy-allocation');
    if (!response.ok) throw new Error('Failed to fetch strategy allocation');
    return await response.json();
};

export interface TechnicalAnalysisData {
    ticker: string;
    price: number;
    technicalAction: 'ACCUMULATE' | 'MAINTAIN' | 'TRIM' | 'EXIT' | 'INITIATE' | 'WATCHLIST' | 'AVOID';
    regime: 'BULLISH_TREND' | 'BULLISH_CONSOLIDATION' | 'BEARISH_TREND' | 'DISTRIBUTION' | 'COMPRESSION';
    rationale: string;
    effectiveAt: string;
    keyLevels: {
        support1: number;
        support2: number;
        macroFloor: number;
        resistance1: number;
        baseTarget?: number;
        resistance2: number;
        stopLoss: number;
        atrExpectedSwing: number;
        profitTiers?: Array<{
            tier: number;
            label: string;
            price: number;
            trimPct: number;
            gainPct: number;
            basis: string;
        }>;
    };
    metrics: {
        ema21: number;
        ema50: number;
        ema200: number;
        adx: number;
        volBias: number;
        atr: number;
        rsi: number;
        isSqueeze: boolean;
    };
    holdingStatus: {
        isHolding: boolean;
        targetWeight: number | null;
        actualWeight: number | null;
        role: string | null;
    };
    revisionHistory?: Array<{
        date: string;
        fairValue: number;
        action: string;
        model: string;
    }>;
}

export const fetchTechnicalAnalysis = async (ticker: string): Promise<TechnicalAnalysisData | null> => {
    try {
        const response = await fetch(`/api/stock/${ticker}/technical-analysis`);
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        console.warn('Failed to fetch technical analysis:', e);
        return null;
    }
};

export const fetchStockData = async (ticker: string): Promise<StockData> => {
    try {
        const response = await fetch(`/api/stock/${ticker}`);
        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || `Error ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        console.error("API Fetch Error:", error);
        throw error;
    }
};

// Auto-pick source: TradingView CDP (primary) → cache
export const syncPortfolio = async (): Promise<{ success: boolean; dataSource: string; message: string; positionCount?: number }> => {
    const response = await fetch('/api/portfolio/sync-tv/apply', {
        method: 'POST',
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.details || data.error || 'Sync failed');
    }
    return data;
};

export const refreshPrices = async (): Promise<{ success: boolean; updated: number; heatmap: any }> => {
    const response = await fetch('/api/portfolio/refresh-prices', {
        method: 'POST',
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.details || data.error || 'Price refresh failed');
    }
    return data;
};

/**
 * Every "Refresh" button in the app (Portfolio Summary, Portfolio Table,
 * Portfolio Heatmap) calls this one function — but until 2026-07-27 it only
 * ran the price-refreshing `refreshPrices()` call as an exception fallback:
 * `syncPortfolio()` (position/share/cash sync via `/sync-tv/apply`) does NOT
 * write current prices at all (`BrokerSyncService.ts` explicitly persists
 * `price: null` for stock positions — TV's broker panel doesn't surface a
 * per-share current price the same way its watchlist does), so on the normal
 * success path `refreshPrices()` was never called and displayed prices sat
 * stale indefinitely no matter how many times "Refresh" was clicked.
 *
 * Fix: always run BOTH — position sync AND the one canonical price-refresh
 * call — regardless of either's outcome, so there is exactly one method
 * ("refreshPrices()" → `/api/portfolio/refresh-prices` → the same
 * `_select_effective_price()`-backed pipeline every page relies on) that
 * actually updates prices, called unconditionally by every refresh path.
 */
export const syncAndRefreshPortfolio = async (): Promise<{ success: boolean; dataSource: string; message: string }> => {
    let syncOk = false;
    let syncMessage = 'TV position sync failed';
    try {
        const syncResult = await syncPortfolio();
        syncOk = syncResult.success;
        syncMessage = `TV sync: ${syncResult.positionCount ?? ''} positions`;
    } catch (e) {
        console.warn('TradingView CDP position sync failed', e);
    }

    let refreshOk = false;
    let refreshMessage = 'price refresh failed';
    try {
        const refreshResult = await refreshPrices();
        refreshOk = refreshResult.success;
        refreshMessage = `prices: ${refreshResult.updated} updated`;
    } catch (e) {
        console.warn('Price refresh failed', e);
    }

    return {
        success: syncOk || refreshOk,
        dataSource: syncOk ? 'tradingview-cdp' : (refreshOk ? 'yfinance' : 'none'),
        message: `${syncMessage} · ${refreshMessage}`,
    };
};

export interface ValuationResult {
    fair_value: number;
    growth_assumption: number;
    rationale: string;
    action: "BUY" | "SELL" | "HOLD";
    model_name: string;
    suggested_growth?: number;
    suggested_margin?: number;
    exit_pe?: number;
    quality_multiplier?: number;
    reviewedAt?: string;
    analyzedAt?: string;
}

export const runAIAnalysis = async (ticker: string, userMessage?: string): Promise<ValuationResult> => {
    const response = await fetch('/api/analysis/valuation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker, userMessage }),
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.details || data.error || 'AI Analysis failed');
    }
    return data;
};

export const fetchSyncStatus = async (): Promise<{ lastSync: string | null }> => {
    const response = await fetch('/api/portfolio/status');
    if (!response.ok) {
        throw new Error('Failed to fetch sync status');
    }
    return await response.json();
};

// --- Valuation Persistence Interfaces & API ---

export interface Scenario {
    weight: number;
    growthRate: number; // 0-100+
    netMargin: number; // 0-100
    exitPE: number;
    qualityMultiplier: number;
    shareChange: number; // % change (negative = buyback)
    moatScore?: number; // 0-5
    managementScore?: number; // 0-5
    rationale?: string;
    scenarioPrice?: number;
    risks?: string[];
}

export interface Snapshot {
    price: number;
    currency: string;
    shares: number;
    revenue: number;
    lastActualPS: number;
    fiscalPeriod?: string;
    analystGrowthEstimate?: number;
    analystMarginEstimate?: number;
}

export interface Projection {
    ticker: string;
    id: string;
    source: 'USER' | 'SYSTEM' | 'AI_AGENT' | 'ETF_ANALYSIS';
    schemaVersion: '1.1';
    version: number;
    savedAt: string;
    updatedAt: string;
    name: string;
    isDefault?: boolean; // If true, this loads automatically
    rationale?: string;
    snapshot: Snapshot;
    dataPreferences: {
        growthBasis: 'ttm' | 'next' | 'current';
        marginBasis: 'ttm' | 'next' | 'quarterly';
    };
    scenarios: {
        bear: Scenario;
        base: Scenario;
        bull: Scenario;
    };
    aiThesis?: {
        model: string;
        rationale: string;
        fairValue: number;
        action: 'BUY' | 'HOLD' | 'SELL' | 'INITIATE' | 'ACCUMULATE' | 'MAINTAIN' | 'TRIM' | 'EXIT' | 'WATCHLIST';
        analyzedAt: string;
        researchReport?: string;
    };
    taLevels?: {
        date: string;
        signal: string;
        score: number;
        priceLevels: {
            stopLoss: number | null;
            trimAt: number | null;
            holdLo: number | null;
            holdHi: number | null;
            accumulateAt: number | null;
        };
        source: string;
        notes?: string;
    };
    globalSettings: {
        discountRate: number;
        timeHorizon: number;
    };
}

export const fetchProjections = async (ticker: string): Promise<Projection[] | null> => {
    try {
        const response = await fetch(`/api/projections/${ticker}`);
        if (!response.ok) {
            if (response.status === 404) return [];
            const errorData = await response.json().catch(() => ({}));
            console.warn("Fetch Projections Warning", errorData);
            // Red Team C1 Fix: Return null on error so caller knows it's a failure, not just empty.
            return null;
        }
        return await response.json();
    } catch (e) {
        console.error("Network error fetching projections", e);
        // Red Team C1 Fix: Return null on network error.
        return null;
    }
};

export const fetchAllProjections = async (): Promise<Projection[]> => {
    const response = await fetch('/api/projections');
    if (!response.ok) {
        throw new Error('Failed to fetch projections');
    }
    return await response.json();
};

export const saveProjection = async (projection: Projection): Promise<{ success: boolean; message: string }> => {
    const response = await fetch('/api/projections', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(projection),
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Failed to save projection');
    }
    return data;
};

export const deleteProjection = async (ticker: string, id: string): Promise<{ success: boolean; message: string }> => {
    const response = await fetch(`/api/projections/${ticker}/${id}`, {
        method: 'DELETE',
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Failed to delete projection');
    }
    return data;
};

// ─── Watchlist API ────────────────────────────────────────────────────────────

export const fetchWatchlist = async (): Promise<Array<{ ticker: string; addedAt: string }>> => {
    const res = await fetch('/api/screener/watchlist');
    if (!res.ok) throw new Error('Failed to fetch watchlist');
    return res.json();
};

export const addToWatchlist = async (ticker: string): Promise<{ success: boolean; message: string }> => {
    const res = await fetch('/api/screener/watchlist/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to add to watchlist');
    return data;
};

export const removeFromWatchlist = async (ticker: string): Promise<{ success: boolean; message: string }> => {
    const res = await fetch('/api/screener/watchlist/remove', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticker }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to remove from watchlist');
    return data;
};

// ─── Docs API ─────────────────────────────────────────────────────────────────

export const fetchInvestmentThesis = async (): Promise<{ content: string; filename: string; thesisName: string; thesisDescription: string }> => {
    const res = await fetch('/api/docs/investment-thesis');
    if (!res.ok) throw new Error('Failed to load investment thesis');
    return res.json();
};

export const fetchLatestReviewData = async (): Promise<any> => {
    const res = await fetch('/api/docs/latest-review-data');
    if (!res.ok) throw new Error('Failed to load review data');
    return res.json();
};

// ─── Portfolio Health API ──────────────────────────────────────────────────────

export interface HoldingWeight {
    ticker: string;
    actualPct: number;
    targetPct: number;
}

export const fetchPortfolioWeights = async (): Promise<Record<string, HoldingWeight>> => {
    try {
        const res = await fetch('/api/theses/target-portfolio/health');
        if (!res.ok) return {};
        const data = await res.json();
        const map: Record<string, HoldingWeight> = {};
        for (const h of data.holdingHealth ?? []) {
            map[h.ticker] = { ticker: h.ticker, actualPct: h.actualPct ?? 0, targetPct: h.targetPct ?? 0 };
        }
        return map;
    } catch { return {}; }
};

export const fetchTargetPortfolio = async (): Promise<any> => {
    const res = await fetch('/api/theses/target-portfolio');
    if (!res.ok) throw new Error('Failed to load target portfolio');
    return res.json();
};

export const fetchAgentGuide = async (): Promise<{ content: string; filename: string }> => {
    const res = await fetch('/api/docs/agent-guide');
    if (!res.ok) throw new Error('Failed to load agent guide');
    return res.json();
};

// ─── Trading API ──────────────────────────────────────────────────────────────

export interface TradePreflightRequest {
    ticker: string;
    action: 'buy' | 'sell';
    shares: number;
    orderType: string;
    limitPrice?: number;
    account: string;
    ackStale?: boolean;
}

export interface TradeSession {
    sessionId: string;
    state: string;
    card?: Record<string, any>;
    screenshot?: string;
    error?: string;
    result?: any;
}

export const runTradePreflight = async (req: TradePreflightRequest): Promise<TradeSession> => {
    const res = await fetch('/api/trading/preflight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
    });
    const data = await res.json();
    if (!res.ok) return { ...data, sessionId: data.sessionId ?? '' };
    return data;
};

export const runTradeExecute = async (sessionId: string): Promise<TradeSession> => {
    const res = await fetch('/api/trading/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Execute failed');
    return data;
};

export const runTradeSubmit = async (sessionId: string): Promise<TradeSession> => {
    const res = await fetch('/api/trading/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Submit failed');
    return data;
};

export const fetchTodayAudit = async (): Promise<{ events: any[]; date: string }> => {
    const res = await fetch('/api/trading/audit/today');
    if (!res.ok) throw new Error('Failed to load audit');
    return res.json();
};

export interface PositionData {
    ticker: string;
    price: number | null;
    book_price: number | null;
    shares: number;
    unrealizedGain: number | null;
    unrealizedGainPct: number | null;
    accounts: { account: string; shares: number }[];
    accountTotal: number;
}

export const fetchPosition = async (ticker: string): Promise<PositionData> => {
    const res = await fetch(`/api/portfolio/position/${ticker}`);
    if (!res.ok) throw new Error('Failed to load position');
    return res.json();
};

export type TradeLogStatus = 'suggested' | 'logged' | 'submitted' | 'inactive' | 'filled' | 'cancelled';
export type TradeLogSource = 'manual' | 'cdp_execution' | 'rebalance' | 'portfolio_review';

export interface TradeLogEntry {
    id: string;
    ticker: string;
    action: 'buy' | 'sell';
    shares: number;
    price: number;
    totalCost: number;
    account: string;
    orderType: string;
    limitPrice: number | null;
    date: string;
    notes: string;
    status: TradeLogStatus;
    source: TradeLogSource;
    tvOrderId: string | null;
    loggedAt: string;
}

export interface LogTradeRequest {
    ticker: string;
    action: 'buy' | 'sell';
    shares: number;
    price?: number;
    account: string;
    orderType?: string;
    limitPrice?: number;
    date: string;
    notes?: string;
    status?: TradeLogStatus;
    source?: TradeLogSource;
    tvOrderId?: string | null;
}

export interface SuggestTradeRequest {
    ticker: string;
    action: 'buy' | 'sell';
    shares: number;
    price?: number;
    account: string;
    orderType?: string;
    limitPrice?: number;
    date: string;
    notes?: string;
    source?: TradeLogSource;
}

export const fetchTradeLog = async (): Promise<{ entries: TradeLogEntry[] }> => {
    const res = await fetch('/api/trading/log');
    if (!res.ok) throw new Error('Failed to load trade log');
    return res.json();
};

export const logTrade = async (req: LogTradeRequest): Promise<{ success: boolean; entry: TradeLogEntry }> => {
    const res = await fetch('/api/trading/log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to log trade');
    return data;
};

export const suggestTrades = async (suggestions: SuggestTradeRequest[]): Promise<{ success: boolean; created: TradeLogEntry[] }> => {
    const res = await fetch('/api/trading/log/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestions }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to suggest trades');
    return data;
};

export interface MarketQuote {
    ticker: string;
    price: number | null;
    bid: number | null;
    ask: number | null;
    bidSize: number | null;
    askSize: number | null;
    dayChangePct: number | null;
    dayChangeAbs: number | null;
    volume: number | null;
    currency: string;
    marketState: string | null;
    source?: string;
    error?: string;
}

export const fetchMarketQuotes = async (tickers: string[]): Promise<Record<string, MarketQuote>> => {
    if (tickers.length === 0) return {};
    const res = await fetch(`/api/market/quotes?tickers=${tickers.join(',')}`);
    if (!res.ok) throw new Error('Failed to fetch quotes');
    return res.json();
};

export const updateTradeLogEntry = async (id: string, updates: Partial<Pick<TradeLogEntry, 'status' | 'notes' | 'price' | 'shares' | 'orderType' | 'limitPrice' | 'account' | 'date' | 'tvOrderId'>>): Promise<{ success: boolean; entry: TradeLogEntry }> => {
    const res = await fetch(`/api/trading/log/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? 'Failed to update entry');
    return data;
};

export const cancelTrade = async (params: {
    entryId: string;
    tvOrderId?: string | null;
    ticker?: string;
    action?: string;
    limitPrice?: number | null;
}): Promise<{ tvCancelled: boolean; logCancelled: boolean; tvResult?: any }> => {
    const res = await fetch('/api/trading/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });
    return res.json();
};

export const modifyTrade = async (params: {
    entryId: string;
    tvOrderId: string;
    ticker: string;
    action: string;
    newPrice: number;
    newShares?: number | null;
}): Promise<{ tvModified: boolean; logUpdated: boolean; tvResult?: any }> => {
    const res = await fetch('/api/trading/modify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });
    return res.json();
};

export const syncTradeLogFromTV = async (): Promise<{ success: boolean; tvOrders: number; cancelled: number; message: string; error?: string }> => {
    const res = await fetch('/api/trading/log/sync-from-tv', { method: 'POST' });
    return res.json();
};

export const fetchTVQuote = async (ticker: string): Promise<MarketQuote> => {
    const res = await fetch(`/api/trading/tv-quote?ticker=${ticker}`);
    if (!res.ok) throw new Error('Failed to fetch TradingView quote');
    return res.json();
};

// ─── Universe API ─────────────────────────────────────────────────────────────

export interface UniverseCandidate {
    ticker: string;
    name: string;
    source: string;
    asset_class: string | null;
    added_at: string;
}

export interface UniverseUploadSummary {
    inserted: number;
    skipped: number;
    rejected?: string[];
    errors?: string[];
}

export const uploadUniverseCsv = async (csv: string): Promise<UniverseUploadSummary> => {
    const response = await fetch('/api/universe/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv }),
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Failed to upload universe CSV');
    }
    return data;
};

export const fetchUniverse = async (): Promise<UniverseCandidate[]> => {
    const response = await fetch('/api/universe');
    if (!response.ok) throw new Error('Failed to fetch universe');
    return await response.json();
};

export const deleteUniverseTicker = async (ticker: string): Promise<{ deleted: string }> => {
    const response = await fetch(`/api/universe/${encodeURIComponent(ticker)}`, {
        method: 'DELETE',
    });
    const data = await response.json();
    if (!response.ok) {
        throw new Error(data.error || 'Failed to delete universe ticker');
    }
    return data;
};

// ─── Portfolio Maintainer API ─────────────────────────────────────────────────

export type MaintainerAccountType = 'TFSA' | 'RRSP' | 'CASH';

export interface MaintainerAccount {
    accountId: string;
    name: string;
    type: string;
    currency: string;
    cash: number;
}

export interface MaintainerPosition {
    accountId: string;
    ticker: string;
    qty: number;
    avgCost: number | null;
    currency: string;
}

export interface MaintainerTransactionRequest {
    accountId: string;
    ticker: string;
    side: 'BUY' | 'SELL';
    qty: number;
    price: number;
    commission?: number;
}

export interface MaintainerTransactionResult {
    position: { ticker: string; qty: number; avgCost: number | null } | null;
    cash: number;
    currency: string;
}

export const fetchMaintainerAccounts = async (): Promise<MaintainerAccount[]> => {
    const res = await fetch('/api/portfolio-maintainer/accounts');
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to fetch maintainer accounts');
    }
    return res.json();
};

export const createMaintainerAccount = async (name: string, type: MaintainerAccountType, currency?: string): Promise<MaintainerAccount> => {
    const res = await fetch('/api/portfolio-maintainer/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, type, currency }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to create account');
    return data;
};

export const updateMaintainerAccount = async (accountId: string, patch: { name?: string; currency?: string }): Promise<MaintainerAccount> => {
    const res = await fetch(`/api/portfolio-maintainer/accounts/${encodeURIComponent(accountId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to update account');
    return data;
};

export const setMaintainerInitialCash = async (accountId: string, amount: number): Promise<{ accountId: string; cash: number }> => {
    const res = await fetch(`/api/portfolio-maintainer/accounts/${encodeURIComponent(accountId)}/cash`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to set initial cash');
    return data;
};

export const fetchMaintainerPositions = async (): Promise<MaintainerPosition[]> => {
    const res = await fetch('/api/portfolio-maintainer/positions');
    if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to fetch maintainer positions');
    }
    return res.json();
};

export const submitMaintainerTransaction = async (req: MaintainerTransactionRequest): Promise<MaintainerTransactionResult> => {
    const res = await fetch('/api/portfolio-maintainer/transaction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Transaction failed');
    return data;
};

export const deleteMaintainerPosition = async (accountId: string, ticker: string): Promise<{ deleted: string }> => {
    const res = await fetch(
        `/api/portfolio-maintainer/position/${encodeURIComponent(accountId)}/${encodeURIComponent(ticker)}`,
        { method: 'DELETE' }
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete position');
    return data;
};


