import { useState, useEffect, useCallback } from 'react';
import { RefreshCcw, Zap, X, Filter, Pencil, RefreshCw } from 'lucide-react';
import {
    fetchTradeLog, updateTradeLogEntry, fetchMarketQuotes, cancelTrade, modifyTrade, syncTradeLogFromTV, fetchBrokerSources,
    type TradeLogEntry, type TradeLogStatus, type MarketQuote,
} from '../services/api';
import { TradePrepModal } from '../components/TradePrepModal';
import { PriceSourceBadge } from '../components/PriceSourceBadge';
import { CopyCommandChip } from '../components/CopyCommandChip';
import { useFeatureFlags } from '../hooks/useFeatureFlags';
import {
    TRADE_LOG_PAGE_SIZE, TRADE_LOG_TAB_STATUSES, TRADE_REFRESH_NUDGE_DAYS, TRADE_SYNC_COMMAND, daysSince,
    latestFilledTrade, recentFirst, tradeDateParts, type TradeLogTab,
} from '../utils/tradeLogView';

// ── Chips ─────────────────────────────────────────────────────────────────────

const STATUS_STYLES: Record<TradeLogStatus, string> = {
    suggested: 'bg-amber-500/10 border-amber-500/30 text-amber-400',
    logged:    'bg-indigo-500/10 border-indigo-500/30 text-indigo-400',
    submitted: 'bg-sky-500/10 border-sky-500/30 text-sky-400',
    inactive:  'bg-slate-500/10 border-slate-500/30 text-slate-400',
    filled:    'bg-emerald-500/10 border-emerald-500/30 text-emerald-400',
    cancelled: 'bg-slate-700/40 border-slate-600/30 text-slate-500',
};

function StatusChip({ status }: { status: TradeLogStatus }) {
    return (
        <span className={`px-2 py-0.5 rounded-full border text-[10px] font-bold uppercase tracking-wide ${STATUS_STYLES[status]}`}>
            {status}
        </span>
    );
}

function ActionChip({ action }: { action: string }) {
    return (
        <span className={`px-2 py-0.5 rounded text-[10px] font-black uppercase ${
            action === 'buy' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400'
        }`}>
            {action}
        </span>
    );
}

// ── Tabs ──────────────────────────────────────────────────────────────────────

type TabId = TradeLogTab;
type ActionFilter = 'buy' | 'sell' | 'all';

const TAB_STATUS_MAP = TRADE_LOG_TAB_STATUSES;

function resolvedStatus(e: TradeLogEntry): TradeLogStatus {
    if (e.status === 'submitted' && (e.orderType === 'limit' || e.orderType === 'stop' || e.orderType === 'stop_limit')) {
        return 'inactive';
    }
    return e.status;
}

// ── Modify Modal ──────────────────────────────────────────────────────────────

function ModifyModal({ entry, onSave, onClose }: {
    entry: TradeLogEntry;
    onSave: (id: string, updates: Partial<TradeLogEntry>) => Promise<void>;
    onClose: () => void;
}) {
    const [quote, setQuote]           = useState<MarketQuote | null>(null);
    const [shares, setShares]         = useState(String(entry.shares));
    const [limitPrice, setLimitPrice] = useState(entry.limitPrice != null ? String(entry.limitPrice) : '');
    const [notes, setNotes]           = useState(entry.notes ?? '');
    const [saving, setSaving]         = useState(false);
    const [tvError, setTvError]       = useState<string | null>(null);

    useEffect(() => {
        fetchMarketQuotes([entry.ticker]).then(q => setQuote(q[entry.ticker] ?? null)).catch(() => {});
    }, [entry.ticker]);

    const isBuy     = entry.action === 'buy';
    const rs        = resolvedStatus(entry);
    const isTvOrder = (rs === 'submitted' || rs === 'inactive') && !!entry.tvOrderId;
    const newPrice  = limitPrice ? Number(limitPrice) : null;
    const cost      = newPrice != null && shares ? Number(shares) * newPrice : null;

    const actionColor = isBuy
        ? 'border-emerald-500/30 bg-emerald-500/5 text-emerald-400'
        : 'border-red-500/30 bg-red-500/5 text-red-400';

    const savePlan = async () => {
        setSaving(true);
        try {
            await onSave(entry.id, {
                shares: Number(shares),
                limitPrice: newPrice,
                notes,
            });
            onClose();
        } finally { setSaving(false); }
    };

    const saveTv = async () => {
        if (!newPrice || !entry.tvOrderId) return;
        setSaving(true);
        setTvError(null);
        try {
            const result = await modifyTrade({
                entryId: entry.id,
                tvOrderId: entry.tvOrderId,
                ticker: entry.ticker,
                action: entry.action,
                newPrice,
                newShares: Number(shares) !== entry.shares ? Number(shares) : null,
            });
            if (result.tvModified) {
                onClose();
            } else {
                setTvError(result.tvResult?.error ?? 'TradingView modify failed — check TV is running and order is visible.');
            }
        } catch (e: any) {
            setTvError(e.message ?? 'Network error');
        } finally { setSaving(false); }
    };

    return (
        <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4">
            <div className="bg-slate-900 border border-slate-700 rounded-2xl w-full max-w-md shadow-2xl">

                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
                    <div className="flex items-center gap-3">
                        <span className={`px-3 py-1 rounded-lg border text-sm font-black uppercase ${actionColor}`}>
                            {entry.action}
                        </span>
                        <div>
                            <div className="text-base font-bold text-white">{entry.ticker}</div>
                            <div className="text-[11px] text-slate-500">
                                {entry.account} · {isTvOrder ? 'Live order — modifies in TradingView via CDP' : 'Planned trade'}
                            </div>
                        </div>
                    </div>
                    <button onClick={onClose} className="text-slate-500 hover:text-white p-1 rounded"><X size={16} /></button>
                </div>

                {/* Live price strip */}
                {quote && (
                    <div className="px-5 py-3 bg-slate-800/40 border-b border-slate-800 flex items-center justify-between">
                        <div className="text-xs text-slate-400">Current price</div>
                        <div className="flex items-baseline gap-3">
                            <span className="text-white font-mono font-semibold">
                                ${quote.price?.toFixed(2) ?? '—'}
                            </span>
                            {quote.dayChangePct != null && (
                                <span className={`text-xs font-semibold ${quote.dayChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                    {quote.dayChangePct >= 0 ? '+' : ''}{quote.dayChangePct.toFixed(2)}%
                                </span>
                            )}
                            {quote.bid != null && quote.ask != null && (
                                <span className="text-[11px] text-slate-500 font-mono">
                                    {quote.bid.toFixed(2)} / {quote.ask.toFixed(2)}
                                </span>
                            )}
                        </div>
                    </div>
                )}

                {/* Form */}
                <div className="px-5 py-4 space-y-4">
                    <div className="grid grid-cols-2 gap-3">
                        <label className="block">
                            <span className="text-[11px] text-slate-400 uppercase tracking-wide">Shares</span>
                            <input
                                type="number" min="1" value={shares}
                                onChange={e => setShares(e.target.value)}
                                className="mt-1.5 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
                            />
                        </label>
                        <label className="block">
                            <span className="text-[11px] text-slate-400 uppercase tracking-wide">Limit Price</span>
                            <div className="relative mt-1.5">
                                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
                                <input
                                    type="number" step="0.01" value={limitPrice}
                                    onChange={e => setLimitPrice(e.target.value)}
                                    className="w-full bg-slate-800 border border-slate-700 rounded-lg pl-7 pr-3 py-2 text-sm text-white font-mono focus:outline-none focus:border-indigo-500"
                                    placeholder="0.00"
                                />
                            </div>
                        </label>
                    </div>

                    {!isTvOrder && (
                        <label className="block">
                            <span className="text-[11px] text-slate-400 uppercase tracking-wide">Notes</span>
                            <input
                                type="text" value={notes} onChange={e => setNotes(e.target.value)}
                                className="mt-1.5 w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                                placeholder="Optional note…"
                            />
                        </label>
                    )}

                    {cost != null && (
                        <div className="bg-slate-800/60 rounded-lg px-4 py-3 border border-slate-700/50">
                            <div className="flex justify-between items-center text-sm">
                                <span className="text-slate-400">{shares} × ${newPrice?.toFixed(2)}</span>
                                <span className="font-mono font-semibold text-white">≈ ${cost.toFixed(2)}</span>
                            </div>
                            {newPrice != null && quote?.price && (
                                <div className="text-[11px] text-slate-500 mt-1">
                                    {newPrice < quote.price
                                        ? `$${(quote.price - newPrice).toFixed(2)} below market`
                                        : `$${(newPrice - quote.price).toFixed(2)} above market`}
                                </div>
                            )}
                        </div>
                    )}

                    {tvError && (
                        <p className="text-[11px] text-red-400 bg-red-900/10 border border-red-700/20 rounded-lg px-3 py-2">
                            {tvError}
                        </p>
                    )}
                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t border-slate-800 flex gap-3">
                    <button onClick={onClose} className="flex-1 py-2 rounded-lg text-sm text-slate-400 hover:text-white border border-slate-700 hover:border-slate-600 transition-colors">
                        Cancel
                    </button>
                    {isTvOrder ? (
                        <button
                            onClick={saveTv}
                            disabled={saving || !newPrice}
                            className="flex-1 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors"
                        >
                            {saving ? 'Modifying in TV…' : 'Modify Order'}
                        </button>
                    ) : (
                        <button
                            onClick={savePlan}
                            disabled={saving}
                            className="flex-1 py-2 rounded-lg text-sm font-semibold bg-indigo-600 hover:bg-indigo-500 text-white disabled:opacity-50 transition-colors"
                        >
                            {saving ? 'Saving…' : 'Update Trade'}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function TradeLog() {
    const [entries, setEntries]             = useState<TradeLogEntry[]>([]);
    const [loading, setLoading]             = useState(true);
    const [quotes, setQuotes]               = useState<Record<string, MarketQuote>>({});
    const [quotesLoading, setQuotesLoading] = useState(false);
    const [execModal, setExecModal]         = useState<{ ticker: string; action: 'buy' | 'sell'; shares: number } | null>(null);
    const [editModal, setEditModal]         = useState<TradeLogEntry | null>(null);
    const [priceSource, setPriceSource]     = useState<string | null>(null);
    const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
    const [cancelling, setCancelling]       = useState<Set<string>>(new Set());
    const [syncing, setSyncing]             = useState(false);
    const [syncMsg, setSyncMsg]             = useState<string | null>(null);

    const [tab, setTab]                   = useState<TabId>('all');
    const [tickerFilter, setTickerFilter] = useState('');
    const [actionFilter, setActionFilter] = useState<ActionFilter>('all');
    const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());
    const [showAll, setShowAll]           = useState(false);
    // Screener-only mode (spec S6): every broker-backed control on this page is hidden,
    // because /api/trading/* answers 410 while BROKER_INTEGRATION is not 'on'.
    const { broker_integration } = useFeatureFlags();

    // Questrade is offered only when the owner enabled it in .env; TradingView is always the default.
    const [questradeEnabled, setQuestradeEnabled] = useState(false);
    useEffect(() => {
        if (!broker_integration) return;
        fetchBrokerSources().then(sources => setQuestradeEnabled(sources.questrade));
    }, [broker_integration]);

    const loadQuotes = useCallback(async (data: TradeLogEntry[]) => {
        const unique = [...new Set(data.filter(e => e.status !== 'cancelled').map(e => e.ticker))];
        if (unique.length === 0) return;
        setQuotesLoading(true);
        try {
            const [q, tvStatus] = await Promise.all([
                fetchMarketQuotes(unique),
                fetch('/api/tv-status').then(r => r.json()).catch(() => ({ price_source: null })),
            ]);
            setQuotes(q);
            setPriceSource(tvStatus.price_source ?? 'yfinance');
            setLastRefreshedAt(new Date());
        } catch { /* non-fatal */ }
        finally { setQuotesLoading(false); }
    }, []);

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const { entries: data } = await fetchTradeLog();
            setEntries(data);
            loadQuotes(data);
        } catch { /* show empty */ }
        finally { setLoading(false); }
    }, [loadQuotes]);

    useEffect(() => {
        load();
        if (!broker_integration) return;
        // Auto-reconcile against TV on page load — silently, TV may not always be running
        syncTradeLogFromTV()
            .then(r => { if (r.success && r.cancelled > 0) { setSyncMsg(r.message); load(); } })
            .catch(() => {});
    }, [load, broker_integration]);
    useEffect(() => { setSelectedIds(new Set()); }, [tab]);

    const doSyncFromTV = async () => {
        setSyncing(true);
        setSyncMsg(null);
        try {
            // The button also imports executed trades from TradingView's order history.
            const r = await syncTradeLogFromTV(true);
            setSyncMsg(r.error ? `Error: ${r.error}` : r.message);
            if (r.success) load();
        } catch (e: any) {
            setSyncMsg(`Error: ${e.message}`);
        } finally {
            setSyncing(false);
        }
    };

    // ── Cancel ───────────────────────────────────────────────────────────────

    const doCancel = async (entry: TradeLogEntry) => {
        if (cancelling.has(entry.id)) return;
        setCancelling(prev => new Set(prev).add(entry.id));
        try {
            const rs = resolvedStatus(entry);
            if (rs === 'submitted' || rs === 'inactive') {
                await cancelTrade({ entryId: entry.id, tvOrderId: entry.tvOrderId, ticker: entry.ticker, action: entry.action, limitPrice: entry.limitPrice });
            } else {
                await updateTradeLogEntry(entry.id, { status: 'cancelled' });
            }
            setEntries(prev => prev.map(e => e.id === entry.id ? { ...e, status: 'cancelled' as TradeLogStatus } : e));
            setSelectedIds(prev => { const s = new Set(prev); s.delete(entry.id); return s; });
        } catch { /* ignore */ }
        finally { setCancelling(prev => { const s = new Set(prev); s.delete(entry.id); return s; }); }
    };

    const doBulkCancel = async () => {
        for (const id of selectedIds) {
            const entry = entries.find(e => e.id === id);
            if (entry) await doCancel(entry);
        }
    };

    const doEdit = async (id: string, updates: Partial<TradeLogEntry>) => {
        await updateTradeLogEntry(id, updates as any);
        setEntries(prev => prev.map(e => e.id === id ? { ...e, ...updates } : e));
    };

    // ── Counts / filters ──────────────────────────────────────────────────────

    const counts = Object.fromEntries((Object.keys(TAB_STATUS_MAP) as TabId[]).map(id =>
        [id, entries.filter(e => TAB_STATUS_MAP[id].includes(resolvedStatus(e))).length])) as Record<TabId, number>;

    // Newest trade date first; imported fills share one import time, so loggedAt alone would not order them.
    const matching = recentFirst(entries).filter(e => {
        if (!TAB_STATUS_MAP[tab].includes(resolvedStatus(e))) return false;
        if (actionFilter !== 'all' && e.action !== actionFilter) return false;
        if (tickerFilter && !e.ticker.includes(tickerFilter.toUpperCase())) return false;
        return true;
    });
    // The page opens on the most recent rows; "Show all" lifts the limit.
    const filtered = showAll ? matching : matching.slice(0, TRADE_LOG_PAGE_SIZE);

    // Executed trades arrive only when the owner runs the Questrade sync, so their freshness is shown.
    const lastFill = latestFilledTrade(entries);
    const lastFillAge = daysSince(lastFill?.date);
    const fillsStale = lastFillAge == null || lastFillAge > TRADE_REFRESH_NUDGE_DAYS;

    const showOrderIdCol = tab === 'open';
    // Executed trades appear on the All tab too, so their fill price and total are shown there as well.
    const showFillCols   = tab === 'filled' || tab === 'all';

    // ── Selection ─────────────────────────────────────────────────────────────

    const toggleSelect = (id: string) => setSelectedIds(prev => {
        const s = new Set(prev); s.has(id) ? s.delete(id) : s.add(id); return s;
    });

    const selectableFiltered = filtered.filter(e => {
        const rs = resolvedStatus(e);
        return rs !== 'filled' && rs !== 'cancelled';
    });
    const allSelected = selectableFiltered.length > 0 && selectableFiltered.every(e => selectedIds.has(e.id));

    // Planned and cancelled entries are not tabs: they are reached from the link under the table.
    const TABS: { id: TabId; label: string }[] = [
        { id: 'all', label: 'Open & Filled' },
        { id: 'open', label: 'Open orders' },
        { id: 'filled', label: 'Filled' },
    ];

    return (
        <div className="space-y-4">

            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h2 className="text-2xl font-bold text-text">Trade Log</h2>
                    <p className="text-xs text-slate-500 mt-0.5">
                        {counts.open} open order{counts.open === 1 ? '' : 's'} · {counts.filled} executed trade{counts.filled === 1 ? '' : 's'}
                        {quotesLoading && <span className="ml-2 text-sky-500">· fetching quotes…</span>}
                    </p>
                    <p className={`text-xs mt-0.5 ${fillsStale ? 'text-amber-400' : 'text-slate-500'}`}>
                        {lastFill
                            ? `Latest executed trade: ${lastFill.ticker} ${lastFill.action} on ${tradeDateParts(lastFill.date).day}`
                                + (lastFillAge != null ? ` (${lastFillAge === 0 ? 'today' : `${lastFillAge} day${lastFillAge === 1 ? '' : 's'} ago`})` : '')
                            : 'No executed trades recorded yet'}
                        {fillsStale && broker_integration && ' · press Sync from TV if you have traded since'}
                    </p>
                </div>
                <div className="flex items-center gap-3">
                    {selectedIds.size > 0 && (
                        <button onClick={doBulkCancel}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-900/30 hover:bg-red-800/40 border border-red-700/40 text-red-400 hover:text-red-300 text-xs font-semibold transition-colors">
                            <X size={12} /> Cancel {selectedIds.size} selected
                        </button>
                    )}
                    <PriceSourceBadge priceSource={priceSource} lastRefreshedAt={lastRefreshedAt} />
                    {broker_integration && questradeEnabled && (
                        <CopyCommandChip command={TRADE_SYNC_COMMAND} label="Or refresh via"
                            title="Optional: refresh from Questrade instead. Paste this command to your agent; it needs your Questrade sign-in. Trades already imported from TradingView are not duplicated." />
                    )}
                    {broker_integration && (
                        <button onClick={doSyncFromTV} disabled={syncing}
                            title="Reconcile open orders and import executed trades from TradingView's order history. TradingView will briefly switch through your accounts."
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-900/40 hover:bg-indigo-800/50 border border-indigo-700/50 text-indigo-400 hover:text-indigo-300 text-xs font-semibold transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                            <RefreshCw size={12} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync from TV'}
                        </button>
                    )}
                    <button onClick={load}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-400 hover:text-white text-xs font-semibold transition-colors">
                        <RefreshCcw size={12} /> Refresh
                    </button>
                </div>
            </div>

            {/* Sync status message */}
            {syncMsg && (
                <div className={`flex items-center justify-between px-4 py-2 text-xs border-b ${syncMsg.startsWith('Error') ? 'bg-red-900/20 border-red-700/30 text-red-400' : 'bg-indigo-900/20 border-indigo-700/30 text-indigo-300'}`}>
                    <span>{syncMsg}</span>
                    <button onClick={() => setSyncMsg(null)} className="text-slate-500 hover:text-white ml-4"><X size={11} /></button>
                </div>
            )}

            {/* Tabs + filters */}
            <div className="flex items-end justify-between border-b border-slate-800">
                <div className="flex">
                    {TABS.map(t => (
                        <button key={t.id} onClick={() => setTab(t.id)}
                            className={`flex items-center gap-1.5 px-4 py-2.5 text-xs font-semibold transition-colors border-b-2 -mb-px ${
                                tab === t.id ? 'text-white border-white' : 'text-slate-500 border-transparent hover:text-slate-300'
                            }`}>
                            {t.label}
                            {counts[t.id] > 0 && (
                                <span className={`text-[10px] font-bold px-1.5 py-px rounded-full ${tab === t.id ? 'bg-white/15 text-white' : 'bg-slate-800 text-slate-500'}`}>
                                    {counts[t.id]}
                                </span>
                            )}
                        </button>
                    ))}
                </div>
                <div className="flex items-center gap-2 pb-2">
                    <div className="relative">
                        <Filter size={11} className="absolute left-2 top-1/2 -translate-y-1/2 text-slate-500" />
                        <input type="text" placeholder="Ticker…" value={tickerFilter}
                            onChange={e => setTickerFilter(e.target.value)}
                            className="bg-slate-900 border border-slate-700 rounded-lg pl-6 pr-2 py-1 text-xs text-white focus:outline-none focus:border-indigo-500 w-24 placeholder:text-slate-600" />
                    </div>
                    <select value={actionFilter} onChange={e => setActionFilter(e.target.value as ActionFilter)}
                        className="bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-slate-300 focus:outline-none focus:border-indigo-500">
                        <option value="all">All sides</option>
                        <option value="buy">Buy</option>
                        <option value="sell">Sell</option>
                    </select>
                </div>
            </div>

            {/* Table */}
            <div className="bg-surface rounded-xl border border-slate-800 overflow-hidden">
                {loading ? (
                    <div className="flex items-center justify-center h-40 text-slate-500 text-sm gap-2">
                        <RefreshCcw size={14} className="animate-spin" /> Loading…
                    </div>
                ) : filtered.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-40 text-slate-500 gap-2">
                        <span className="text-sm">{tab === 'open' ? 'No open orders' : tab === 'filled' ? 'No executed trades recorded' : 'Nothing to show here'}</span>
                        {entries.length === 0 && (
                            <span className="text-xs text-slate-600 text-center max-w-sm">
                                Use Buy/Sell from the Portfolio or Stock Analysis pages.
                                The <code className="px-1 bg-slate-800 rounded">/rebalance</code> skill writes planned trades here automatically.
                            </span>
                        )}
                    </div>
                ) : (
                    <table className="w-full text-xs table-fixed">
                        {/* One width per column, in header order; built as a list so no stray whitespace lands in <colgroup>. */}
                        <colgroup>
                            {[
                                '2.5rem',                                   // select
                                '6rem',                                     // ticker
                                '7.5rem',                                   // date and order time
                                '4.5rem', '4rem', '5rem', '5.5rem',         // side, qty, type, limit
                                ...(showFillCols ? ['5.5rem', '5.5rem'] : []), // fill, total
                                '5rem',                                     // account
                                ...(showOrderIdCol ? ['8rem'] : []),        // order id
                                '6.5rem', '6rem', '8rem',                   // last / chg%, status, actions
                                undefined,                                  // notes fills the rest
                            ].map((width, index) => <col key={index} style={width ? { width } : undefined} />)}
                        </colgroup>
                        <thead>
                            <tr className="border-b border-slate-800 text-[10px] uppercase tracking-wider">
                                <th className="px-3 py-3">
                                    <input type="checkbox" checked={allSelected} onChange={() => {
                                        if (allSelected) setSelectedIds(new Set());
                                        else setSelectedIds(new Set(selectableFiltered.map(e => e.id)));
                                    }} className="accent-indigo-500 cursor-pointer" />
                                </th>
                                <th className="px-3 py-3 text-left text-slate-500 font-semibold">Ticker</th>
                                <th className="px-3 py-3 text-left text-slate-500 font-semibold" title="Trade date. A time is shown for imported market orders, in US Eastern time.">Date</th>
                                <th className="px-3 py-3 text-left text-slate-500 font-semibold">Side</th>
                                <th className="px-3 py-3 text-right text-slate-500 font-semibold">Qty</th>
                                <th className="px-3 py-3 text-left text-slate-500 font-semibold">Type</th>
                                <th className="px-3 py-3 text-right text-slate-500 font-semibold">Limit</th>
                                {showFillCols && <th className="px-3 py-3 text-right text-slate-500 font-semibold">Fill</th>}
                                {showFillCols && <th className="px-3 py-3 text-right text-slate-500 font-semibold">Total</th>}
                                <th className="px-3 py-3 text-left text-slate-500 font-semibold">Acct</th>
                                {showOrderIdCol && <th className="px-3 py-3 text-left text-slate-500 font-semibold">Order ID</th>}
                                <th className="px-3 py-3 text-right text-sky-500/70 font-semibold">Last / Chg%</th>
                                <th className="px-3 py-3 text-left text-slate-500 font-semibold">Status</th>
                                <th className="px-3 py-3 text-right text-slate-500 font-semibold">Actions</th>
                                <th className="px-3 py-3 text-left text-slate-500 font-semibold">Notes</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-800/60">
                            {filtered.map(e => {
                                const q           = quotes[e.ticker];
                                const rs          = resolvedStatus(e);
                                const isFilled    = rs === 'filled';
                                const isCancelled = rs === 'cancelled';
                                const isPlanned   = rs === 'suggested' || rs === 'logged';
                                const isActive    = rs === 'submitted' || rs === 'inactive';
                                const isCanc      = cancelling.has(e.id);
                                const isSelectable = !isFilled && !isCancelled;

                                return (
                                    <tr key={e.id} className={`hover:bg-slate-800/30 transition-colors ${isCancelled ? 'opacity-40' : ''} ${selectedIds.has(e.id) ? 'bg-indigo-900/10' : ''}`}>

                                        {/* Checkbox */}
                                        <td className="px-3 py-2.5">
                                            {isSelectable && (
                                                <input type="checkbox" checked={selectedIds.has(e.id)} onChange={() => toggleSelect(e.id)}
                                                    className="accent-indigo-500 cursor-pointer" />
                                            )}
                                        </td>

                                        {/* Ticker */}
                                        <td className="px-3 py-2.5">
                                            <div className="font-mono font-bold text-white text-[13px]">{e.ticker}</div>
                                        </td>

                                        {/* Trade date and, when known, order time */}
                                        <td className="pl-3 pr-5 py-2.5 whitespace-nowrap">
                                            <div className="font-mono text-slate-200 text-xs">{tradeDateParts(e.date).day}</div>
                                            {tradeDateParts(e.date).time && (
                                                <div className="text-[10px] text-slate-500 mt-0.5">{tradeDateParts(e.date).time}</div>
                                            )}
                                        </td>

                                        {/* Side */}
                                        <td className="px-3 py-2.5"><ActionChip action={e.action} /></td>

                                        {/* Qty */}
                                        <td className="px-3 py-2.5 text-right font-mono text-slate-200">{e.shares.toLocaleString()}</td>

                                        {/* Type */}
                                        <td className="px-3 py-2.5 text-slate-400 uppercase text-[10px] tracking-wide">{e.orderType ?? <span className="text-slate-700">—</span>}</td>

                                        {/* Limit */}
                                        <td className="px-3 py-2.5 text-right font-mono text-slate-400">
                                            {e.limitPrice != null ? `$${e.limitPrice.toFixed(2)}` : <span className="text-slate-700">—</span>}
                                        </td>

                                        {/* Fill + Total (filled tab only) */}
                                        {showFillCols && (
                                            <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                                                {e.price > 0 ? `$${e.price.toFixed(2)}` : <span className="text-slate-700">—</span>}
                                            </td>
                                        )}
                                        {showFillCols && (
                                            <td className="px-3 py-2.5 text-right font-mono text-slate-300">
                                                {e.totalCost > 0 ? `$${e.totalCost.toFixed(2)}` : <span className="text-slate-700">—</span>}
                                            </td>
                                        )}

                                        {/* Account */}
                                        <td className="px-3 py-2.5 text-slate-300 font-mono text-[11px]">{e.account}</td>

                                        {/* Order ID (working/inactive only) */}
                                        {showOrderIdCol && (
                                            <td className="px-3 py-2.5 font-mono text-[10px] text-slate-500 overflow-hidden">
                                                {e.tvOrderId
                                                    ? <span title={e.tvOrderId} className="cursor-default select-all truncate block">{e.tvOrderId.substring(0, 8)}…</span>
                                                    : <span className="text-slate-700">—</span>}
                                            </td>
                                        )}

                                        {/* Last + Chg% stacked */}
                                        <td className="px-3 py-2.5 text-right">
                                            {q?.price != null ? (
                                                <div>
                                                    <div className="font-mono text-sky-300 text-[12px]">${q.price.toFixed(2)}</div>
                                                    {q.dayChangePct != null && (
                                                        <div className={`text-[10px] font-semibold ${q.dayChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                                                            {q.dayChangePct >= 0 ? '+' : ''}{q.dayChangePct.toFixed(2)}%
                                                        </div>
                                                    )}
                                                </div>
                                            ) : <span className="text-slate-700">—</span>}
                                        </td>

                                        {/* Status */}
                                        <td className="px-3 py-2.5"><StatusChip status={rs} /></td>

                                        {/* Actions */}
                                        <td className="px-3 py-2.5">
                                            <div className="flex items-center gap-1 justify-end">
                                                {isPlanned && broker_integration && (
                                                    <button
                                                        onClick={() => setExecModal({ ticker: e.ticker, action: e.action as 'buy' | 'sell', shares: e.shares })}
                                                        title="Submit to TradingView"
                                                        className="flex items-center gap-1 px-2 py-0.5 rounded bg-emerald-900/30 hover:bg-emerald-800/40 border border-emerald-700/30 text-emerald-500 hover:text-emerald-300 text-[10px] font-bold transition-colors"
                                                    >
                                                        <Zap size={10} /> Submit
                                                    </button>
                                                )}
                                                {!isFilled && !isCancelled && (
                                                    <button onClick={() => setEditModal(e)}
                                                        title={isActive ? 'Modify order' : 'Edit trade'}
                                                        className="p-1 rounded text-slate-500 hover:text-slate-200 hover:bg-slate-700/40 transition-colors">
                                                        <Pencil size={12} />
                                                    </button>
                                                )}
                                                {!isFilled && !isCancelled && (
                                                    <button onClick={() => doCancel(e)} disabled={isCanc}
                                                        title={isActive ? 'Cancel in TradingView + log' : 'Remove from plan'}
                                                        className={`p-1 rounded transition-colors disabled:opacity-40 ${isActive ? 'text-amber-600 hover:text-red-400 hover:bg-red-900/20' : 'text-slate-600 hover:text-red-400 hover:bg-red-900/20'}`}>
                                                        {isCanc ? <RefreshCcw size={12} className="animate-spin" /> : <X size={12} />}
                                                    </button>
                                                )}
                                            </div>
                                        </td>

                                        {/* Notes — last column */}
                                        <td className="px-3 py-2.5 text-slate-500 text-[11px] overflow-hidden">
                                            <span className="truncate block max-w-full" title={e.notes}>
                                                {e.notes || <span className="text-slate-700">—</span>}
                                            </span>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                )}
                {(counts.other > 0 || tab === 'other') && (
                    <div className="px-4 py-2 border-t border-slate-800 text-xs text-slate-500">
                        <button type="button" onClick={() => setTab(tab === 'other' ? 'all' : 'other')}
                            className="hover:text-slate-300 underline decoration-dotted underline-offset-2">
                            {tab === 'other' ? 'Back to open orders and executed trades'
                                : `Show ${counts.other} planned and cancelled entr${counts.other === 1 ? 'y' : 'ies'}`}
                        </button>
                    </div>
                )}
                {matching.length > TRADE_LOG_PAGE_SIZE && (
                    <div className="flex items-center justify-between px-4 py-2.5 border-t border-slate-800 text-xs text-slate-500">
                        <span>Showing {filtered.length} of {matching.length} entries, newest first</span>
                        <button type="button" onClick={() => setShowAll(on => !on)}
                            className="px-3 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-300 hover:text-white font-semibold transition-colors">
                            {showAll ? `Show latest ${TRADE_LOG_PAGE_SIZE}` : `Show all ${matching.length}`}
                        </button>
                    </div>
                )}
            </div>

            {execModal && (
                <TradePrepModal
                    ticker={execModal.ticker}
                    initialAction={execModal.action}
                    initialShares={execModal.shares}
                    onClose={() => { setExecModal(null); load(); }}
                />
            )}

            {editModal && (
                <ModifyModal
                    entry={editModal}
                    onSave={doEdit}
                    onClose={() => setEditModal(null)}
                />
            )}
        </div>
    );
}
