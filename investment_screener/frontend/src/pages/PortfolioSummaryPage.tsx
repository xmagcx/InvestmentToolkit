/**
 * PortfolioSummaryPage.tsx (React Page)
 * =====================================
 *
 * Purpose:
 *     Executive overview of portfolio performance, including YTD returns, period-over-period changes (1D, 1W, 1M), and strategy allocation.
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <PortfolioSummaryPage />
 *
 * Key Functions:
 *     - fetchPortfolioSummary() - Retrieves core valuation and currency data (Market Value, Book Value, FX Rate)
 *     - fetchPortfolioPerformance() - Asynchronously fetches time-series performance metrics from the backend
 *     - PeriodCard() - Sub-component for rendering standardized performance delta cards with conditional coloring
 */
import { useState, useEffect } from 'react';
import {
    fetchPortfolioSummary,
    fetchPortfolioPerformance,
    fetchStrategyAllocation,
    syncAndRefreshPortfolio,
    refreshPrices,
    type PortfolioSummary,
    type PortfolioPerformance,
    type StrategyAllocation,
} from '../services/api';
import PortfolioSummaryCards from '../components/PortfolioSummaryCards';
import PortfolioBreakdown from '../components/PortfolioBreakdown';
import StrategyAllocationChart from '../components/StrategyAllocationChart';
import { PriceSourceBadge } from '../components/PriceSourceBadge';
import { useFeatureFlags } from '../hooks/useFeatureFlags';
import { usePrivacy } from '../context/PrivacyContext';
import { PRICE_CHANGE_PERIODS } from '../utils/priceChangePeriods';
import { deltaColor } from '../utils/formatters';

// Portfolio-level periods the /api/portfolio/performance endpoint returns.
const PORTFOLIO_PERF_KEYS = { '1d': true, '1w': true, '1m': true, '3m': true } as const;

function PeriodCard({
    label,
    perf,
    loading,
}: {
    label: string;
    perf: { change: number; changePct: number } | null | undefined;
    loading: boolean;
}) {
    const { isPrivacyMode } = usePrivacy();
    const isPos = (perf?.change ?? 0) >= 0;
    const sign = isPos ? '+' : '';
    const color = deltaColor(perf?.change ?? 0);   // shared delta colours
    const glow = (perf?.change ?? 0) > 0 ? 'shadow-emerald-500/10' : (perf?.change ?? 0) < 0 ? 'shadow-red-500/10' : '';

    function fmt(v: number) {
        if (isPrivacyMode) return '$••••';
        const abs = Math.abs(v);
        if (abs >= 1000) return `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`;
        return `$${Math.abs(v).toFixed(2)}`;
    }

    return (
        <div className={`bg-slate-900/80 border border-slate-800 rounded-xl px-4 py-3 shadow-lg flex items-center gap-4 ${glow}`}>
            <div className="text-xs font-bold text-slate-500 uppercase tracking-widest w-14 shrink-0">{label}</div>
            {loading ? (
                <div className="flex gap-3 items-center">
                    <div className="h-6 w-20 bg-slate-800 rounded animate-pulse" />
                    <div className="h-4 w-14 bg-slate-800/60 rounded animate-pulse" />
                </div>
            ) : perf ? (
                <div className="flex items-baseline gap-3">
                    <span className={`text-xl font-bold ${color}`}>{sign}{perf.changePct.toFixed(2)}%</span>
                    <span className={`text-sm font-semibold ${color}`}>{sign}{fmt(perf.change)}</span>
                </div>
            ) : (
                <div className="text-slate-600 text-sm">Unavailable</div>
            )}
        </div>
    );
}

export default function PortfolioSummaryPage() {
    const [summary, setSummary] = useState<PortfolioSummary | null>(null);
    const [perf, setPerf] = useState<PortfolioPerformance | null>(null);
    const [allocation, setAllocation] = useState<StrategyAllocation | null>(null);
    const [loading, setLoading] = useState(true);
    const [perfLoading, setPerfLoading] = useState(true);
    const [allocLoading, setAllocLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
    const [priceSource, setPriceSource] = useState<string | null>(null);
    const [syncing, setSyncing] = useState(false);
    const [refreshNote, setRefreshNote] = useState<{ text: string; ok: boolean } | null>(null);
    const { broker_integration } = useFeatureFlags();

    function loadAll() {
        setLoading(true);
        setAllocLoading(true);
        setPerfLoading(true);
        fetchPortfolioSummary()
            .then(d => { setSummary(d); setLastRefreshedAt(new Date(d.lastUpdated)); setPriceSource(d.price_source ?? null); })
            .catch(err => setError(err.message || 'Failed to load portfolio summary'))
            .finally(() => setLoading(false));
        fetchStrategyAllocation()
            .then(setAllocation)
            .catch(() => setAllocation(null))
            .finally(() => setAllocLoading(false));
        fetchPortfolioPerformance()
            .then(setPerf)
            .catch(() => setPerf(null))
            .finally(() => setPerfLoading(false));
    }

    async function syncAndRefresh() {
        setSyncing(true);
        setRefreshNote(null);
        try {
            // Screener-only mode (spec S6): holdings are maintained by hand, so Refresh runs
            // only the one price refresh (AGENTS rule 25) and never the broker position sync,
            // which would answer 410 and report a failure the owner cannot act on.
            if (!broker_integration) {
                const prices = await refreshPrices();
                const missing = prices.missingPrices ?? [];
                setRefreshNote({
                    text: `prices: ${prices.updated} updated`
                        + (missing.length ? ` · no quote for ${missing.join(', ')}` : ''),
                    ok: prices.success && missing.length === 0,
                });
                return;
            }
            const result = await syncAndRefreshPortfolio();
            setRefreshNote({ text: result.message, ok: result.pricesOk });
        } catch (e) {
            console.error('Unified sync failed', e);
            setRefreshNote({ text: `Refresh failed: ${e instanceof Error ? e.message : String(e)}`, ok: false });
        } finally {
            setSyncing(false);
            loadAll();
            window.dispatchEvent(new CustomEvent('portfolio-synced'));
        }
    }

    useEffect(() => {
        loadAll();

        const handleSyncEvent = () => {
            loadAll();
        };
        window.addEventListener('portfolio-synced', handleSyncEvent);
        return () => window.removeEventListener('portfolio-synced', handleSyncEvent);
    }, []);

    if (loading) {
        return (
            <div className="p-6 h-full flex items-center justify-center">
                <div className="text-slate-500 text-sm">Loading portfolio summary...</div>
            </div>
        );
    }

    if (error || !summary) {
        return (
            <div className="p-6 h-full flex items-center justify-center">
                <div className="text-red-400 text-sm">{error || 'No data available'}</div>
            </div>
        );
    }

    return (
        <div className="p-4 h-full space-y-4">
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-xl font-bold text-white mb-0.5">Portfolio Summary</h1>
                    <p className="text-sm text-slate-500">
                        YTD performance and total value across all accounts
                    </p>
                </div>
                <div className="mt-1 flex items-center gap-3">
                    <button
                        onClick={syncAndRefresh}
                        disabled={syncing}
                        className="px-3 py-1 bg-zinc-800 text-zinc-300 rounded text-xs hover:bg-zinc-700 disabled:opacity-50 transition-colors"
                    >
                        {syncing ? '⟳ Syncing…' : '↻ Refresh'}
                    </button>
                    <PriceSourceBadge priceSource={priceSource} lastRefreshedAt={lastRefreshedAt} />
                </div>
            </div>

            {refreshNote && (
                <p className={`text-xs ${refreshNote.ok ? 'text-emerald-400' : 'text-amber-400'}`} role="status">
                    {refreshNote.ok ? 'Refreshed: ' : 'Not fully refreshed: '}{refreshNote.text}
                </p>
            )}

            {/* Row 1: Original 4 summary cards */}
            <PortfolioSummaryCards data={summary} />

            {/* Row 2: Period performance cards (1d / 1w / 1m) */}
            {/* Periods and labels from the shared list (utils/priceChangePeriods); the
                API supplies the portfolio-level ones it computes (1D/1W/1M/3M). */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {PRICE_CHANGE_PERIODS.filter(p => p.key in PORTFOLIO_PERF_KEYS).map(p => (
                    <PeriodCard key={p.key} label={p.label} perf={perf?.[p.key as keyof typeof PORTFOLIO_PERF_KEYS]} loading={perfLoading} />
                ))}
            </div>

            {/* Row 3: Strategy allocation chart */}
            <div className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-lg">
                <div className="flex items-center justify-between mb-3">
                    <div>
                        <h3 className="text-sm font-bold text-slate-500 uppercase tracking-widest">Strategy Allocation</h3>
                        <p className="text-xs text-slate-600 mt-0.5">Actual holdings by investment pillar</p>
                    </div>
                </div>
                {allocLoading ? (
                    <div className="h-[280px] flex items-center justify-center">
                        <div className="text-slate-600 text-sm">Loading allocation...</div>
                    </div>
                ) : allocation && allocation.allocation.length > 0 ? (
                    <StrategyAllocationChart
                        data={allocation.allocation}
                        totalCAD={summary.totalMarketValueCAD}
                        usdCadRate={summary.liveUsdCadRate}
                    />
                ) : (
                    <div className="h-[300px] flex items-center justify-center text-slate-600 text-sm">
                        No allocation data available
                    </div>
                )}
            </div>

            {/* Row 4: Detailed breakdown table */}
            <PortfolioBreakdown data={summary} />
        </div>
    );
}
