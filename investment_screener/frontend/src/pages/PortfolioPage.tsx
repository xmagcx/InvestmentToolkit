/**
 * PortfolioPage.tsx (React Page)
 * =====================================
 *
 * Purpose:
 *     The one page for the positions table. It replaces the old Portfolio Table and Portfolio
 *     Advisor pages: a scope toggle (Holdings, Watchlist, All), action chips, sector and
 *     strategy filters, per-column filters, a column picker with saved choices, add-to-watchlist,
 *     the valuation range and reward:risk columns, trade and log buttons, totals and a refresh
 *     that syncs from the broker. Rows come from the shared position provider, the live price,
 *     sector and % changes from the heatmap (only for the tickers the scope needs), and every
 *     cell from the shared column registry.
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <Route path="portfolio" element={<PortfolioPage />} />
 *
 * Key Functions:
 *     - PortfolioPage() - toolbar, filters and the PositionsTable with the portfolio preset
 *
 * Key Input Dependencies:
 *     - components/positions (provider, registry, scope, extras, table, picker, sizing)
 *     - contexts/useRecommendations, services/api (watchlist), existing modals
 *
 * Key Output Dependencies:
 *     - /portfolio route and the sidebar
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { BookOpen, FileBarChart2, Filter, Star, Terminal } from 'lucide-react';
import { useRecommendations } from '../contexts/useRecommendations';
import { usePrivacy } from '../context/PrivacyContext';
import { addToWatchlist, removeFromWatchlist } from '../services/api';
import { isReduceCandidate } from '../utils/riskReward';
import AgentGuideModal from '../components/AgentGuideModal';
import InvestmentThesisModal from '../components/InvestmentThesisModal';
import LatestReviewModal from '../components/LatestReviewModal';
import { HelpTrigger } from '../components/HelpModal';
import { PriceSourceBadge } from '../components/PriceSourceBadge';
import { ReduceCandidatesChip } from '../components/RiskRewardCell';
import { TradeButtons } from '../components/TradeButtons';
import { TradeLogModal } from '../components/TradeLogModal';
import { useFeatureFlags } from '../hooks/useFeatureFlags';
import { ColumnPicker } from '../components/positions/ColumnPicker';
import { COLUMNS, type TableRow } from '../components/positions/columns';
import { moneyText } from '../components/positions/positionMath';
import { PORTFOLIO_PRESET } from '../components/positions/presets';
import { PositionsTable, type SortState } from '../components/positions/PositionsTable';
import { countsFor, filterRows, sectorOptions, strategyOptions, type FilterState, type Scope, type StatusFilter } from '../components/positions/scope';
import { suggestedShares } from '../components/positions/tradeSizing';
import { useColumnPrefs } from '../components/positions/useColumnPrefs';
import { useHeatmapExtras } from '../components/positions/useHeatmapExtras';
import { usePositionRows } from '../components/positions/usePositionRows';

const STORAGE_KEY = 'portfolio-table-prefs-v1';
const SCOPES: Array<{ id: Scope; label: string }> = [
    { id: 'holdings', label: '💼 Holdings' }, { id: 'watchlist', label: '⭐ Watchlist' }, { id: 'all', label: 'All' },
];
const CHIPS: Array<{ id: StatusFilter; label: string; tone: string }> = [
    { id: 'actionable', label: '⚡ Actionable', tone: 'bg-cyan-600' },
    { id: 'exit', label: '🔴 Exits', tone: 'bg-red-600' },
    { id: 'trim', label: '🟠 Trims', tone: 'bg-orange-600' },
    { id: 'initiate', label: '🟢 Initiate', tone: 'bg-green-600' },
    { id: 'accumulate', label: '🔵 Accumulate', tone: 'bg-blue-600' },
    { id: 'gaps', label: '🚨 Needs valuation', tone: 'bg-rose-600' },
];

const SCOPE_ONLY: FilterState = { scope: 'holdings', status: 'all', sector: 'all', strategy: 'all', text: {} };

export default function PortfolioPage() {
    const navigate = useNavigate();
    const recommendations = useRecommendations();
    const { isPrivacyMode } = usePrivacy();
    const { rows: positionRows, loading, error, refresh: refreshRows } = usePositionRows();

    const [filter, setFilter] = useState<FilterState>(SCOPE_ONLY);
    const [showFilterRow, setShowFilterRow] = useState(false);
    const [sort, setSort] = useState<SortState>(PORTFOLIO_PRESET.sort);
    const [showThesis, setShowThesis] = useState(false);
    const [showReview, setShowReview] = useState(false);
    const [showGuide, setShowGuide] = useState(false);
    const [logTicker, setLogTicker] = useState<string | null>(null);
    // The trade journal posts to /api/trading/log, which is off with the broker; trades are
    // recorded on the Portafolio page instead.
    const { broker_integration: brokerOn } = useFeatureFlags();

    const prefs = useColumnPrefs(STORAGE_KEY, COLUMNS, PORTFOLIO_PRESET.columns);

    // Ask the heatmap only for the tickers the chosen scope shows.
    const wanted = useMemo(
        () => filterRows(positionRows, { ...SCOPE_ONLY, scope: filter.scope }, recommendations, () => null).map(r => r.ticker),
        [positionRows, filter.scope, recommendations],
    );
    const extras = useHeatmapExtras(wanted);

    const tableRows: TableRow[] = useMemo(
        () => positionRows.map(r => ({ ...r, ...extras.extrasFor(r.ticker) })),
        [positionRows, extras],
    );
    const sectorOf = useCallback((r: TableRow) => r.sector ?? null, []);
    const scopedRows = useMemo(
        () => filterRows(tableRows, { ...SCOPE_ONLY, scope: filter.scope }, recommendations, sectorOf),
        [tableRows, filter.scope, recommendations, sectorOf],
    );
    const shown = useMemo(
        () => filterRows(tableRows, filter, recommendations, sectorOf),
        [tableRows, filter, recommendations, sectorOf],
    );
    const scopeCounts = useMemo(() => countsFor(tableRows, recommendations), [tableRows, recommendations]);
    const chipCounts = useMemo(() => countsFor(scopedRows, recommendations), [scopedRows, recommendations]);
    const sectors = useMemo(() => sectorOptions(tableRows, sectorOf), [tableRows, sectorOf]);
    const strategies = useMemo(() => strategyOptions(tableRows), [tableRows]);
    const reduceActive = filter.status === 'reduce';
    const reduceCount = useMemo(
        () => scopedRows.filter(r => isReduceCandidate(recommendations[r.ticker])).length, [scopedRows, recommendations],
    );

    const columnIds = useMemo(() => prefs.order.filter(id => prefs.visible.has(id)), [prefs.order, prefs.visible]);
    const setStatus = (status: StatusFilter) => setFilter(f => ({ ...f, status: f.status === status ? 'all' : status }));

    const toggleWatch = useCallback(async (row: TableRow) => {
        try {
            if (row.isWatched) await removeFromWatchlist(row.ticker); else await addToWatchlist(row.ticker);
            await refreshRows();
        } catch (e) {
            console.error('Error toggling watchlist:', e);
        }
    }, [refreshRows]);

    const refreshAll = async () => { await extras.refresh(); await refreshRows(); };

    const heldCount = shown.filter(r => r.held).length;
    const cad = extras.totals.cad;

    if (loading && positionRows.length === 0) {
        return <div className="flex h-64 items-center justify-center text-sm text-zinc-400">Loading portfolio…</div>;
    }
    if (error && positionRows.length === 0) {
        return <div className="m-4 rounded-lg bg-red-900/30 p-4 text-center text-red-400">{error}</div>;
    }

    return (
        <div className="flex h-full flex-col p-4">
            <div className="mb-3 flex items-center justify-between">
                <div>
                    <h1 className="text-xl font-bold leading-tight text-white">Portfolio</h1>
                    <div className="mt-0.5 flex items-center gap-3">
                        <p className="text-xs text-slate-500">{heldCount} positions · {shown.length} shown</p>
                        <span className="flex items-baseline gap-1.5 text-sm">
                            <span className="font-bold text-white">{moneyText(extras.totals.usd, isPrivacyMode, v => `$${Math.round(v).toLocaleString()}`)}</span>
                            <span className="text-xs text-zinc-500">USD</span>
                            <span className="text-zinc-600">/</span>
                            <span className="font-semibold text-zinc-400">{moneyText(cad, isPrivacyMode, v => `$${Math.round(v).toLocaleString()}`)}</span>
                            <span className="text-xs text-zinc-500">CAD</span>
                        </span>
                        <PriceSourceBadge priceSource={extras.priceSource} lastRefreshedAt={extras.refreshedAt} />
                    </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                    <button type="button" onClick={() => setShowThesis(true)} className="flex items-center gap-1.5 rounded-lg border border-indigo-500/20 bg-indigo-500/10 px-2.5 py-1.5 text-xs font-bold text-indigo-300 hover:bg-indigo-500/20"><BookOpen size={13} />Investment Thesis</button>
                    <button type="button" onClick={() => setShowReview(true)} className="flex items-center gap-1.5 rounded-lg border border-amber-500/20 bg-amber-500/10 px-2.5 py-1.5 text-xs font-bold text-amber-300 hover:bg-amber-500/20"><FileBarChart2 size={13} />Latest Review</button>
                    <button type="button" onClick={() => setShowGuide(true)} className="flex items-center gap-1.5 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-2.5 py-1.5 text-xs font-bold text-emerald-300 hover:bg-emerald-500/20"><Terminal size={13} />Agent Guide</button>
                </div>
            </div>

            <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs">
                <div role="group" aria-label="Scope" className="inline-flex overflow-hidden rounded-md border border-zinc-700 font-bold">
                    {SCOPES.map(s => (
                        <button key={s.id} type="button" aria-pressed={filter.scope === s.id}
                            onClick={() => setFilter(f => ({ ...f, scope: s.id }))}
                            className={`px-3 py-1 ${filter.scope === s.id ? 'bg-emerald-600 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'}`}>
                            {s.label} <span className="ml-1 text-[10px] opacity-80">{scopeCounts[s.id === 'all' ? 'all' : s.id]}</span>
                        </button>
                    ))}
                </div>
                <span className="mx-1 h-4 w-px bg-zinc-700" />
                {CHIPS.map(c => (
                    <button key={c.id} type="button" aria-pressed={filter.status === c.id} onClick={() => setStatus(c.id)}
                        className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-bold ${filter.status === c.id ? `${c.tone} text-white` : 'text-zinc-400 hover:text-zinc-200'}`}>
                        {c.label}
                        <span className="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-300">{chipCounts[c.id as keyof typeof chipCounts]}</span>
                    </button>
                ))}
                <HelpTrigger topicId="riskReward" size={13} />
                <ReduceCandidatesChip count={reduceCount} active={reduceActive} onToggle={() => {
                    if (!reduceActive) setSort({ id: 'rr_ratio', dir: 'asc' });
                    setStatus('reduce');
                }} />
                <button type="button" onClick={() => setSort({ id: 'action', dir: 'asc' })}
                    className="rounded border border-zinc-700 px-2 py-1 font-bold text-amber-400 hover:bg-zinc-800">⚡ Prioritize actions</button>

                <div className="ml-auto flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-1 text-zinc-500">Sector
                        <select aria-label="Sector" value={filter.sector} onChange={e => setFilter(f => ({ ...f, sector: e.target.value }))}
                            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300">
                            <option value="all">All</option>
                            {sectors.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </label>
                    <label className="flex items-center gap-1 text-zinc-500">Strategy
                        <select aria-label="Strategy" value={filter.strategy} onChange={e => setFilter(f => ({ ...f, strategy: e.target.value }))}
                            className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300">
                            <option value="all">All</option>
                            {strategies.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </label>
                    <form onSubmit={async e => {
                        e.preventDefault();
                        const input = e.currentTarget.elements.namedItem('watchlistTicker') as HTMLInputElement;
                        const ticker = input.value.trim().toUpperCase();
                        if (!ticker) return;
                        try { await addToWatchlist(ticker); input.value = ''; await refreshRows(); } catch (err) { console.error('Error adding to watchlist:', err); }
                    }} className="flex items-center rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-0.5 focus-within:border-indigo-500/50">
                        <input name="watchlistTicker" type="text" placeholder="Add ticker…" aria-label="Add ticker to watchlist"
                            className="w-24 bg-transparent px-1 py-0.5 text-xs font-bold text-white placeholder:text-slate-500 focus:outline-none" />
                        <button type="submit" className="px-2 text-xs font-black text-indigo-400 hover:text-indigo-300">+ Add</button>
                    </form>
                    <button type="button" onClick={() => setShowFilterRow(s => !s)} aria-pressed={showFilterRow}
                        className={`flex items-center gap-1.5 rounded px-3 py-1 ${showFilterRow ? 'border border-amber-500/50 bg-amber-500/20 text-amber-400' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}>
                        <Filter size={13} /> Filter
                    </button>
                    <ColumnPicker order={prefs.order} visible={prefs.visible} columns={COLUMNS} onToggle={prefs.toggle} onMove={prefs.move} onReset={prefs.reset} />
                    <button type="button" onClick={() => { void refreshAll(); }} className="rounded bg-zinc-800 px-3 py-1 text-zinc-300 hover:bg-zinc-700">↻ Refresh</button>
                </div>
            </div>

            {extras.error && <div className="mb-2 rounded bg-amber-900/30 px-3 py-1.5 text-xs text-amber-300">{extras.error}: live prices, sectors and % changes may be missing.</div>}
            {extras.loading && <div className="mb-2 text-xs text-zinc-500">Loading live prices…</div>}

            <div className="min-h-0 flex-1 overflow-auto">
                <PositionsTable
                    rows={shown}
                    columnIds={columnIds}
                    initialSort={PORTFOLIO_PRESET.sort}
                    sort={sort}
                    onSortChange={setSort}
                    totals={PORTFOLIO_PRESET.totals}
                    widths={prefs.widths}
                    onResize={prefs.resize}
                    filters={showFilterRow ? filter.text : undefined}
                    onFilterChange={(id, value) => setFilter(f => ({ ...f, text: { ...f.text, [id]: value } }))}
                    onRowClick={row => navigate(`/analysis?ticker=${row.ticker}`)}
                    tickerAddon={row => (
                        <button type="button" onClick={e => { e.stopPropagation(); void toggleWatch(row); }}
                            title={row.isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
                            aria-label={row.isWatched ? `Remove ${row.ticker} from watchlist` : `Add ${row.ticker} to watchlist`}
                            className="p-0.5 focus:outline-none">
                            <Star size={13} className={row.isWatched ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-600 hover:text-yellow-400'} />
                        </button>
                    )}
                    renderActions={row => (
                        <>
                            <TradeButtons ticker={row.ticker} size="sm" shares={suggestedShares({
                                actualPct: row.actualPct, targetPct: row.targetPct,
                                price: row.livePrice ?? row.currentPrice, portfolioValue: extras.totals.usd })} />
                            {brokerOn && <button type="button" onClick={() => setLogTicker(row.ticker)} title="Log a trade to journal"
                                className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-bold text-zinc-400 hover:bg-zinc-700 hover:text-amber-400">Log</button>}
                            <button type="button" onClick={() => navigate(`/analysis?ticker=${row.ticker}`)} title="Analyze in Stock Analysis"
                                className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-bold text-zinc-400 hover:bg-zinc-700 hover:text-white">Analyze</button>
                        </>
                    )}
                    emptyMessage={filter.scope === 'watchlist' ? 'Nothing on the watchlist matches.' : 'No stocks match these filters.'}
                />
            </div>

            {showThesis && <InvestmentThesisModal onClose={() => setShowThesis(false)} />}
            {showReview && <LatestReviewModal onClose={() => setShowReview(false)} />}
            {showGuide && <AgentGuideModal onClose={() => setShowGuide(false)} />}
            {brokerOn && logTicker && <TradeLogModal ticker={logTicker} onClose={() => setLogTicker(null)} />}
        </div>
    );
}
