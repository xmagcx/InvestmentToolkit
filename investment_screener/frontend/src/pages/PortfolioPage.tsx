/**
 * PortfolioPage.tsx - The two-panel Portafolio page: accounting table on the left, risk detail on the right.
 *
 * Purpose:
 *     Left: the shared PositionsTable with four accounting columns (ticker, value, weight and risk bars,
 *     gain), biggest weight first; cash is never a row. Selecting a row drives the right panel (Riesgo and
 *     Valoración tabs for that ticker) and, below it, "Mejorar la cartera" (suggested orders, never executed).
 *     The header holds the hero total, gain line, cash and volatility chips and one insight sentence.
 *     Demoted but reachable: status chips, sector/strategy filters, column picker and the full analyst
 *     columns (under "Filtros y columnas"), thesis / review / guide modals ("Más"), trade buttons, journal
 *     log and the link into Stock Analysis (the selected ticker's panel). Holdings / Watchlist / Todo scope,
 *     watch star, add-ticker form, privacy masking and refresh are kept.
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <Route path="/portfolio" element={<PortfolioPage />} />
 *
 * Key Functions (Index):
 *     - PortfolioPage(): state, row building (positions + live extras + risk + optimizer targets), layout
 *
 * Key Input Dependencies:
 *     - GET /api/portfolio/risk (usePortfolioRisk), POST /api/portfolio/optimize (ImprovePanel),
 *       positions/* (rows, columns, presets, scope), contexts/useRecommendations, context/PrivacyContext
 *
 * Key Output Dependencies:
 *     - App.tsx route
 */
import { useCallback, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Star } from 'lucide-react';
import { useRecommendations } from '../contexts/useRecommendations';
import { usePrivacy } from '../context/PrivacyContext';
import { addToWatchlist, removeFromWatchlist, type OptimizeResponse } from '../services/api';
import { isReduceCandidate } from '../utils/riskReward';
import AgentGuideModal from '../components/AgentGuideModal';
import InvestmentThesisModal from '../components/InvestmentThesisModal';
import LatestReviewModal from '../components/LatestReviewModal';
import { TradeButtons } from '../components/TradeButtons';
import { TradeLogModal } from '../components/TradeLogModal';
import { useFeatureFlags } from '../hooks/useFeatureFlags';
import { ImprovePanel } from '../components/portfolio/ImprovePanel';
import { PortfolioHeader } from '../components/portfolio/PortfolioHeader';
import { PortfolioToolbar } from '../components/portfolio/PortfolioToolbar';
import { insightSentence, liveWeights, nameLine, portfolioGain } from '../components/portfolio/portfolioMath';
import { RiskPanel } from '../components/portfolio/RiskPanel';
import { usePortfolioRisk } from '../components/portfolio/usePortfolioRisk';
import { COLUMNS, type TableRow } from '../components/positions/columns';
import { ACCOUNTING_PRESET } from '../components/positions/presets';
import { PositionsTable, type SortState } from '../components/positions/PositionsTable';
import { countsFor, filterRows, sectorOptions, strategyOptions, type FilterState, type StatusFilter } from '../components/positions/scope';
import { suggestedShares } from '../components/positions/tradeSizing';
import { useColumnPrefs } from '../components/positions/useColumnPrefs';
import { useHeatmapExtras } from '../components/positions/useHeatmapExtras';
import { usePositionRows } from '../components/positions/usePositionRows';

// v3: the accounting columns are the default; the old analyst set is still in the column picker.
const STORAGE_KEY = 'portfolio-accounting-prefs-v3';
const SCOPE_ONLY: FilterState = { scope: 'holdings', status: 'all', sector: 'all', strategy: 'all', text: {} };
const isCash = (r: { ticker: string; assetClass: string }) => r.assetClass === 'CASH' || r.ticker === 'CASH';

export default function PortfolioPage() {
    const navigate = useNavigate();
    const recommendations = useRecommendations();
    const { isPrivacyMode } = usePrivacy();
    const { rows: allPositionRows, loading, error, refresh: refreshRows } = usePositionRows();
    const { risk, error: riskError, refresh: refreshRisk } = usePortfolioRisk();
    const { broker_integration: brokerOn } = useFeatureFlags();

    const [filter, setFilter] = useState<FilterState>(SCOPE_ONLY);
    const [showFilterRow, setShowFilterRow] = useState(false);
    const [sort, setSort] = useState<SortState>(ACCOUNTING_PRESET.sort);
    const [selected, setSelected] = useState<string | null>(null);
    const [optimization, setOptimization] = useState<OptimizeResponse | null>(null);
    const [showThesis, setShowThesis] = useState(false);
    const [showReview, setShowReview] = useState(false);
    const [showGuide, setShowGuide] = useState(false);
    const [logTicker, setLogTicker] = useState<string | null>(null);

    // Cash belongs to the totals, never to a row.
    const positionRows = useMemo(() => allPositionRows.filter(r => !isCash(r)), [allPositionRows]);
    const prefs = useColumnPrefs(STORAGE_KEY, COLUMNS, ACCOUNTING_PRESET.columns);
    const wanted = useMemo(
        () => filterRows(positionRows, { ...SCOPE_ONLY, scope: filter.scope }, recommendations, () => null).map(r => r.ticker),
        [positionRows, filter.scope, recommendations],
    );
    const extras = useHeatmapExtras(wanted);

    // One valuation: live price for every row, weights over holdings plus cash. The risk API only supplies the risk fields.
    const cashUsd = risk?.portfolio.cash_usd
        ?? allPositionRows.filter(isCash).reduce((s, r) => s + (r.marketValue ?? 0), 0);
    const targetByTicker = useMemo(() => new Map((optimization?.weights ?? []).map(w => [w.ticker, w.target_pct])), [optimization]);
    const withExtras = useMemo(() => positionRows.map(r => ({ ...r, ...extras.extrasFor(r.ticker) })), [positionRows, extras]);
    const live = useMemo(() => liveWeights(withExtras, cashUsd), [withExtras, cashUsd]);
    const liveByTicker = useMemo(() => new Map(live.rows.map(r => [r.ticker, r])), [live]);
    const riskByTicker = useMemo(() => new Map((risk?.rows ?? []).map(r => {
        const l = liveByTicker.get(r.ticker);
        return [r.ticker, { ...r, market_value: l?.marketValue ?? r.market_value, weight_pct: l?.actualPct ?? r.weight_pct }];
    })), [risk, liveByTicker]);
    const tableRows: TableRow[] = useMemo(() => live.rows.map(r => {
        const rr = riskByTicker.get(r.ticker);
        return {
            ...r, name: nameLine(r),
            riskContributionPct: rr?.risk_contribution_pct ?? null, riskEstimated: rr?.estimated ?? false,
            optimizedTargetPct: targetByTicker.get(r.ticker) ?? null,
        };
    }), [live, riskByTicker, targetByTicker]);

    const sectorOf = useCallback((r: TableRow) => r.sector ?? null, []);
    const scopedRows = useMemo(
        () => filterRows(tableRows, { ...SCOPE_ONLY, scope: filter.scope }, recommendations, sectorOf),
        [tableRows, filter.scope, recommendations, sectorOf],
    );
    // filterRows returns the same objects it was given, so the extras and risk fields are still on them.
    const shown = useMemo(() => filterRows(tableRows, filter, recommendations, sectorOf) as TableRow[], [tableRows, filter, recommendations, sectorOf]);
    const scopeCounts = useMemo(() => countsFor(tableRows, recommendations), [tableRows, recommendations]);
    const chipCounts = useMemo(() => countsFor(scopedRows, recommendations), [scopedRows, recommendations]);
    const reduceCount = useMemo(() => scopedRows.filter(r => isReduceCandidate(recommendations[r.ticker])).length, [scopedRows, recommendations]);
    const reduceActive = filter.status === 'reduce';
    const columnIds = useMemo(() => prefs.order.filter(id => prefs.visible.has(id)), [prefs.order, prefs.visible]);

    // The panel follows the clicked row; until then, the biggest shown holding.
    const selectedRow = shown.find(r => r.ticker === selected)
        ?? [...shown].sort((a, b) => (b.actualPct ?? 0) - (a.actualPct ?? 0))[0];
    const heldRows = tableRows.filter(r => r.held);
    const gain = useMemo(() => portfolioGain(heldRows), [heldRows]);

    const setStatus = (status: StatusFilter) => setFilter(f => ({ ...f, status: f.status === status ? 'all' : status }));
    const toggleWatch = useCallback(async (row: TableRow) => {
        try {
            if (row.isWatched) await removeFromWatchlist(row.ticker); else await addToWatchlist(row.ticker);
            await refreshRows();
        } catch (e) {
            console.error('Error toggling watchlist:', e);
        }
    }, [refreshRows]);
    const refreshAll = async () => { await extras.refresh(); await refreshRows(); await refreshRisk(); };
    const analyze = (ticker: string) => navigate(`/analysis?ticker=${ticker}`);

    if (loading && positionRows.length === 0) {
        return <div className="flex h-64 items-center justify-center text-sm text-zinc-400">Loading portfolio…</div>;
    }
    if (error && positionRows.length === 0) {
        return <div className="m-4 rounded-lg bg-red-900/30 p-4 text-center text-red-400">{error}</div>;
    }

    return (
        <div className="flex h-full flex-col gap-7 overflow-y-auto px-8 pb-10 pt-7">
            <PortfolioHeader positions={heldRows.length} totalUsd={live.totalUsd}
                risk={risk} riskError={riskError} gain={gain} insight={insightSentence([...riskByTicker.values()])} hidden={isPrivacyMode}
                priceSource={extras.priceSource} refreshedAt={extras.refreshedAt} onRefresh={() => { void refreshAll(); }}
                onThesis={() => setShowThesis(true)} onReview={() => setShowReview(true)} onGuide={() => setShowGuide(true)} />

            {extras.error && <div className="rounded bg-amber-900/30 px-3 py-1.5 text-xs text-amber-300">{extras.error}: live prices, sectors and % changes may be missing.</div>}
            {extras.loading && <div className="text-xs text-zinc-500">Loading live prices…</div>}

            <div className="grid grid-cols-1 items-start gap-12 xl:grid-cols-[minmax(0,1fr)_400px]">
                <section aria-label="Posiciones" className="min-w-0">
                    <PortfolioToolbar filter={filter} onFilter={setFilter} scopeCounts={scopeCounts} chipCounts={chipCounts}
                        sectors={sectorOptions(tableRows, sectorOf)} strategies={strategyOptions(tableRows)}
                        reduceCount={reduceCount} reduceActive={reduceActive} onToggleStatus={setStatus}
                        onToggleReduce={() => { if (!reduceActive) setSort({ id: 'rr_ratio', dir: 'asc' }); setStatus('reduce'); }}
                        onPrioritize={() => setSort({ id: 'action', dir: 'asc' })}
                        showFilterRow={showFilterRow} onToggleFilterRow={() => setShowFilterRow(s => !s)}
                        onAddTicker={async t => { await addToWatchlist(t); await refreshRows(); }}
                        picker={{ order: prefs.order, visible: prefs.visible, columns: COLUMNS, onToggle: prefs.toggle, onMove: prefs.move, onReset: prefs.reset }} />
                    <p className="mb-2 flex items-center gap-3 text-xs text-slate-400">
                        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-1 w-3 rounded-sm bg-slate-600" />Peso</span>
                        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-1 w-3 rounded-sm bg-amber-400" />Riesgo</span>
                        <span>misma escala, 0–40 %</span>
                    </p>
                    <PositionsTable
                        rows={shown} columnIds={columnIds} initialSort={ACCOUNTING_PRESET.sort} sort={sort} onSortChange={setSort}
                        totals={ACCOUNTING_PRESET.totals} totalLabel={n => `TOTAL (${n})`} widths={prefs.widths} onResize={prefs.resize}
                        filters={showFilterRow ? filter.text : undefined}
                        onFilterChange={(id, value) => setFilter(f => ({ ...f, text: { ...f.text, [id]: value } }))}
                        selectedTicker={selectedRow?.ticker ?? null}
                        onRowClick={row => setSelected(row.ticker)}
                        tickerAddon={row => (
                            <button type="button" onClick={e => { e.stopPropagation(); void toggleWatch(row); }}
                                title={row.isWatched ? 'Remove from watchlist' : 'Add to watchlist'}
                                aria-label={row.isWatched ? `Remove ${row.ticker} from watchlist` : `Add ${row.ticker} to watchlist`}
                                className="p-0.5 focus:outline-none">
                                <Star size={13} className={row.isWatched ? 'fill-yellow-400 text-yellow-400' : 'text-zinc-600 hover:text-yellow-400'} />
                            </button>
                        )}
                        emptyMessage={filter.scope === 'watchlist' ? 'Nothing on the watchlist matches.' : 'No stocks match these filters.'}
                    />
                    <p className="mx-2 mt-3 text-xs leading-relaxed text-slate-400">
                        Riesgo = peso × volatilidad, normalizado a 100 % (sin correlaciones). Ganancia = precio actual − costo promedio, distinta del
                        potencial de una valoración. Valor, peso y ganancia usan el precio en vivo (el de la fuente indicada arriba); pesos sobre el total con la caja
                        incluida. El riesgo es un ranking que suma 100 %, no dinero.
                    </p>
                </section>

                <div className="flex flex-col gap-8">
                    {selectedRow && (
                        <RiskPanel key={selectedRow.ticker} row={selectedRow} riskRow={riskByTicker.get(selectedRow.ticker)} risk={risk}
                            rec={recommendations[selectedRow.ticker]} hidden={isPrivacyMode} onAnalyze={() => analyze(selectedRow.ticker)}
                            actions={(
                                <>
                                    <TradeButtons ticker={selectedRow.ticker} size="sm" shares={suggestedShares({
                                        actualPct: selectedRow.actualPct, targetPct: selectedRow.targetPct,
                                        price: selectedRow.livePrice ?? selectedRow.currentPrice, portfolioValue: extras.totals.usd })} />
                                    {brokerOn && <button type="button" onClick={() => setLogTicker(selectedRow.ticker)} title="Log a trade to journal"
                                        className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] font-bold text-zinc-400 hover:bg-zinc-700 hover:text-amber-400">Log</button>}
                                </>
                            )} />
                    )}
                    <ImprovePanel hidden={isPrivacyMode} onResult={setOptimization} />
                </div>
            </div>

            {showThesis && <InvestmentThesisModal onClose={() => setShowThesis(false)} />}
            {showReview && <LatestReviewModal onClose={() => setShowReview(false)} />}
            {showGuide && <AgentGuideModal onClose={() => setShowGuide(false)} />}
            {brokerOn && logTicker && <TradeLogModal ticker={logTicker} onClose={() => setLogTicker(null)} />}
        </div>
    );
}
