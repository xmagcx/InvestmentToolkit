import { useRecommendations } from '../contexts/useRecommendations';
import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { X, CheckCircle, AlertTriangle, Loader2, ShieldCheck, Clock, Wifi, TrendingUp, RefreshCw } from 'lucide-react';
import { runTradePreflight, runTradeExecute, runTradeSubmit, logTrade, fetchMarketQuotes, fetchTVQuote, type MarketQuote } from '../services/api';
import { SmartText } from './SmartText';
import { useFeatureFlags } from '../hooks/useFeatureFlags';

type ModalStep =
    | 'configure'
    | 'running_preflight'
    | 'preflight_result'
    | 'running_execute'
    | 'submitting'
    | 'done';

interface Provenance {
    portfolioSyncAgeMin: number | null;
    priceSource: string | null;
    tvConnected: boolean;
    dcfAction: string | null;
    dcfFairValue: number | null;
    dcfTimestamp: string | null;
}

interface AccountHolding { account: string; shares: number; avgFillPrice: number | null; }
interface HoldingsData { accounts: AccountHolding[]; total: number; avgFillPrice: number | null; dataSource: string; }

interface TradePrepModalProps {
    ticker: string;
    initialAction: 'buy' | 'sell';
    initialShares?: number;
    onClose: () => void;
}

const ORDER_TYPES = [
    { value: 'market', label: 'Market' },
    { value: 'limit', label: 'Limit' },
    { value: 'stop', label: 'Stop' },
    { value: 'stop_limit', label: 'Stop Limit' },
];
const ACCOUNTS = ['tfsa', 'rrsp', 'margin'];
const TIME_IN_FORCE = [
    { value: 'day', label: 'Day' },
    { value: 'good_till_cancelled', label: 'Good till cancelled' },
    { value: 'good_till_date', label: 'Good till date' },
    { value: 'good_til_extended_market', label: 'Good til extended market' },
];

function ProvenanceRow({ icon, label, value, warn }: { icon: React.ReactNode; label: string; value: string; warn?: boolean }) {
    return (
        <div className={`flex items-center gap-2 text-xs ${warn ? 'text-amber-400' : 'text-slate-400'}`}>
            <span className="text-slate-500 shrink-0">{icon}</span>
            <span className="text-slate-500 w-28 shrink-0"><SmartText text={label} /></span>
            <span className={`font-medium ${warn ? 'text-amber-400' : 'text-slate-200'}`}>{value}</span>
        </div>
    );
}

function ConfRow({ label, value, flag, warn, valueClass }: { label: string; value: string; flag?: string; warn?: boolean; valueClass?: string }) {
    return (
        <div className="flex items-center justify-between px-4 py-2">
            <span className="text-slate-500 text-xs">{label}</span>
            <div className="flex items-center gap-2">
                <span className={`text-xs font-mono font-medium ${valueClass ?? 'text-slate-200'}`}>{value}</span>
                {flag && <span className={`text-[10px] font-bold ${warn ? 'text-amber-400' : 'text-emerald-400'}`}>{flag}</span>}
            </div>
        </div>
    );
}

/**
 * Screener-only guard (spec S6): with the broker disabled every call this modal makes
 * (/api/trading/*, /api/portfolio/sync-tv) answers 410, so the modal is not mounted at
 * all — its effects never run and no trading request is sent. The trigger buttons are
 * hidden too; this is the backstop for any trigger that is not.
 */
export function TradePrepModal(props: TradePrepModalProps) {
    const { broker_integration } = useFeatureFlags();
    if (!broker_integration) return null;
    return <TradePrepModalContent {...props} />;
}

function TradePrepModalContent({ ticker, initialAction, initialShares = 1, onClose }: TradePrepModalProps) {
    const recommendations = useRecommendations();
    const [step, setStep] = useState<ModalStep>('configure');
    const [action] = useState<'buy' | 'sell'>(initialAction);
    const [shares, setShares] = useState(initialShares);
    const [orderType, setOrderType] = useState('market');
    const [limitPrice, setLimitPrice] = useState('');
    const [stopPrice, setStopPrice] = useState('');
    const [timeInForce, setTimeInForce] = useState('day');
    const [account, setAccount] = useState('tfsa');
    const [ackStale, setAckStale] = useState(false);

    const [provenance, setProvenance] = useState<Provenance | null>(null);
    const [holdings, setHoldings] = useState<HoldingsData | null>(null);
    const [quote, setQuote] = useState<MarketQuote | null>(null);
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [preflightCard, setPreflightCard] = useState<Record<string, any> | null>(null);
    const [preflightState, setPreflightState] = useState<string | null>(null);
    const [preflightError, setPreflightError] = useState<string | null>(null);
    const [, setScreenshot] = useState<string | null>(null);
    const [submitResult, setSubmitResult] = useState<any>(null);
    const [executeError, setExecuteError] = useState<string | null>(null);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [quoteRefreshing, setQuoteRefreshing] = useState(false);

    const refreshQuote = async () => {
        setQuoteRefreshing(true);
        try {
            let q: MarketQuote | null = null;
            if (provenance?.tvConnected) {
                try {
                    q = await fetchTVQuote(ticker);
                } catch {
                    // Fall back to batch quotes (yfinance) on any TV failure
                    q = null;
                }
            }
            
            if (!q) {
                const quotesMap = await fetchMarketQuotes([ticker]);
                q = quotesMap?.[ticker] ?? null;
            }

            if (q) {
                setQuote(q);
                const defaultPrice = action === 'sell' ? q.bid : q.ask;
                if (defaultPrice != null) {
                    setLimitPrice(defaultPrice.toFixed(2));
                    setStopPrice(defaultPrice.toFixed(2));
                }
            }
        } catch { /* silently fail */ }
        setQuoteRefreshing(false);
    };

    // Load provenance + holdings on mount — also triggers a live TV position refresh
    // when TV is connected so "Current Holdings" always reflects the latest positions.
    useEffect(() => {
        const load = async () => {
            const [tvRes, syncRes, projRes, holdingsRes, quoteRes] = await Promise.allSettled([
                fetch('/api/tv-status').then(r => r.json()),
                fetch('/api/portfolio/status').then(r => r.json()),
                fetch(`/api/projections/${ticker}`).then(r => r.ok ? r.json() : null),
                fetch(`/api/portfolio/holdings/${ticker}`).then(r => r.json()),
                fetchMarketQuotes([ticker]),
            ]);

            // If TV is connected, silently refresh positions in the background then
            // re-fetch holdings so "Current Holdings" is always current.
            const tvData = tvRes.status === 'fulfilled' ? tvRes.value : null;
            if (tvData?.price_source === 'tradingview') {
                fetch('/api/portfolio/sync-tv', { method: 'POST' })
                    .then(() => fetch(`/api/portfolio/holdings/${ticker}`).then(r => r.json()))
                    .then(fresh => { if (fresh) setHoldings(fresh); })
                    .catch(() => {});
            }

            const tv = tvRes.status === 'fulfilled' ? tvRes.value : null;
            const sync = syncRes.status === 'fulfilled' ? syncRes.value : null;
            const projs = projRes.status === 'fulfilled' ? projRes.value : null;
            const holdingsData = holdingsRes.status === 'fulfilled' ? holdingsRes.value : null;
            if (holdingsData) setHoldings(holdingsData);
            const quotesMap = quoteRes.status === 'fulfilled' ? quoteRes.value : null;
            if (quotesMap?.[ticker]) {
                const q = quotesMap[ticker];
                setQuote(q);
                const defaultPrice = action === 'sell' ? q.bid : q.ask;
                if (defaultPrice != null) {
                    setLimitPrice(defaultPrice.toFixed(2));
                    setStopPrice(defaultPrice.toFixed(2));
                }
                // Outside regular hours, Day orders expire immediately — default to GTC
                if (q.marketState && q.marketState !== 'REGULAR') {
                    setTimeInForce('good_till_cancelled');
                }
            }

            let syncAgeMin: number | null = null;
            if (sync?.lastSync) {
                syncAgeMin = Math.round((Date.now() - new Date(sync.lastSync).getTime()) / 60000);
            }

            // Latest AI projection for this ticker
            const aiProjs = Array.isArray(projs) ? projs.filter((p: any) => p.source === 'AI_AGENT') : [];
            const latest = aiProjs.sort((a: any, b: any) =>
                new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime()
            )[0] ?? null;

            setProvenance({
                portfolioSyncAgeMin: syncAgeMin,
                priceSource: tv?.price_source ?? null,
                tvConnected: tv?.price_source === 'tradingview',
                dcfAction: recommendations[ticker]?.valuation ?? null,
                dcfFairValue: latest?.aiThesis?.fairValue ?? null,
                dcfTimestamp: latest?.savedAt ?? null,
            });
        };
        load().catch(() => {});
    }, [ticker, recommendations]);

    const runPreflight = async () => {
        setStep('running_preflight');
        setPreflightError(null);
        try {
            const result = await runTradePreflight({
                ticker,
                action,
                shares,
                orderType,
                limitPrice: limitPrice ? parseFloat(limitPrice) : undefined,
                account,
                ackStale,
            });
            setSessionId(result.sessionId);
            setPreflightCard(result.card ?? null);
            setPreflightState(result.state);
            if (result.error && result.state !== 'DATA_STALE_BLOCKED') {
                setPreflightError(result.error);
            }
            setStep('preflight_result');
        } catch (e: any) {
            setPreflightError(e.message ?? 'Preflight failed');
            setStep('preflight_result');
        }
    };

    const runExecute = async () => {
        if (!sessionId) return;
        setStep('running_execute');
        setExecuteError(null);
        try {
            const executeResult = await runTradeExecute(sessionId);
            setScreenshot(executeResult.screenshot ?? null);
            // Auto-submit — no intermediate "review in TV" screen
            setStep('submitting');
            setSubmitError(null);
            const result = await runTradeSubmit(sessionId);
            setSubmitResult(result.result ?? result);
            setStep('done');
            const isLimitOrder = orderType === 'limit' || orderType === 'stop' || orderType === 'stop_limit';
            const tvOrderId: string | null =
                (result as any).tvOrderId ??
                result.result?.brokerVerification?.best?.orderId ??
                null;
            logTrade({
                ticker, action, shares, price: 0, account, orderType,
                limitPrice: limitPrice ? parseFloat(limitPrice) : undefined,
                date: (() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; })(),
                notes: 'Auto-logged from TradingView CDP execution',
                status: isLimitOrder ? 'inactive' : 'submitted',
                source: 'cdp_execution',
                tvOrderId,
            }).catch(() => {});
        } catch (e: any) {
            const isExecutePhase = step === 'running_execute';
            if (isExecutePhase) {
                setExecuteError(e.message ?? 'Execute failed');
            } else {
                setSubmitError(e.message ?? 'Submit failed');
            }
            setStep('preflight_result');
        }
    };

    const actionColor = action === 'buy'
        ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/10'
        : 'text-red-400 border-red-500/30 bg-red-500/10';
    const headerLabel = (step === 'preflight_result' && preflightState === 'PREFLIGHT_PASSED')
        ? 'Order Confirmation'
        : step === 'submitting'
        ? `Submit ${action.toUpperCase()}`
        : action === 'buy' ? 'Prepare Buy' : 'Prepare Sell';

    const isBrokerReady = provenance?.tvConnected;
    // When TV is live, prices are always current — only warn if NOT connected AND data is old.
    const isDataStale = !provenance?.tvConnected && provenance?.portfolioSyncAgeMin != null && provenance.portfolioSyncAgeMin > 60;

    return createPortal(
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm">
            <div className="w-full max-w-2xl bg-slate-900 border border-slate-700 rounded-2xl shadow-2xl flex flex-col max-h-[90vh] overflow-hidden">

                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-slate-800">
                    <div className="flex items-center gap-3">
                        <span className={`px-2.5 py-0.5 rounded border text-xs font-black uppercase tracking-wider ${actionColor}`}>
                            {headerLabel}
                        </span>
                        <span className="text-white font-bold text-lg">{ticker}</span>
                    </div>
                    <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-800 text-slate-400 hover:text-white transition-colors">
                        <X size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto">

                    {/* Step: Configure */}
                    {step === 'configure' && (
                        <div className="p-5 space-y-4">

                            {/* ── Top row: Provenance (left) + Holdings (right) ── */}
                            <div className="grid grid-cols-2 gap-3">

                                {/* Data Provenance */}
                                <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 p-3 space-y-1.5">
                                    <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Data Provenance</div>
                                    {provenance ? (
                                        <>
                                            <ProvenanceRow icon={<Clock size={11} />} label="Portfolio sync"
                                                value={provenance.portfolioSyncAgeMin != null ? `${provenance.portfolioSyncAgeMin} min ago` : 'Unknown'}
                                                warn={isDataStale} />
                                            <ProvenanceRow icon={<Wifi size={11} />} label="Price source"
                                                value={provenance.priceSource === 'tradingview' ? 'TradingView Live' : 'yfinance'} />
                                            <ProvenanceRow icon={<ShieldCheck size={11} />} label="Broker"
                                                value={provenance.tvConnected ? 'Connected (Broker via TV)' : 'Not connected'}
                                                warn={!provenance.tvConnected} />
                                            {provenance.dcfAction && (
                                                <ProvenanceRow icon={<TrendingUp size={11} />} label="DCF signal"
                                                    value={`${provenance.dcfAction}${provenance.dcfFairValue ? ` · $${provenance.dcfFairValue.toFixed(2)}` : ''}`} />
                                            )}
                                        </>
                                    ) : (
                                        <div className="flex items-center gap-2 text-slate-500 text-xs">
                                            <Loader2 size={11} className="animate-spin" /> Loading...
                                        </div>
                                    )}
                                </div>

                                {/* Current Holdings */}
                                <div className="bg-slate-800/40 rounded-xl border border-slate-700/50 p-3">
                                    <div className="text-[10px] font-black uppercase tracking-widest text-slate-500 mb-2">Current Holdings</div>
                                    {holdings === null ? (
                                        <div className="flex items-center gap-2 text-slate-500 text-xs">
                                            <Loader2 size={11} className="animate-spin" /> Loading...
                                        </div>
                                    ) : holdings.total === 0 ? (
                                        <div className="text-xs text-slate-500 italic">No position in {ticker}</div>
                                    ) : (
                                        <div className="space-y-1">
                                            <div className="grid grid-cols-3 text-[10px] text-slate-600 uppercase tracking-wide pb-1">
                                                <span>Acct</span><span className="text-right">Shares</span><span className="text-right">Avg $</span>
                                            </div>
                                            {holdings.accounts.map(({ account: acct, shares: s, avgFillPrice }) => (
                                                <div key={acct} className="grid grid-cols-3 text-xs">
                                                    <span className="text-slate-400">{acct}</span>
                                                    <span className="text-right text-slate-200 font-mono">{s.toLocaleString()}</span>
                                                    <span className="text-right text-slate-400 font-mono">
                                                        {avgFillPrice != null ? `$${avgFillPrice.toFixed(2)}` : '—'}
                                                    </span>
                                                </div>
                                            ))}
                                            <div className="grid grid-cols-3 text-xs pt-1 border-t border-slate-700/60">
                                                <span className="text-slate-400 font-semibold">Total</span>
                                                <span className="text-right text-white font-mono font-bold">{holdings.total.toLocaleString()}</span>
                                                <span className="text-right text-slate-300 font-mono">
                                                    {holdings.avgFillPrice != null ? `$${holdings.avgFillPrice.toFixed(2)}` : '—'}
                                                </span>
                                            </div>
                                        </div>
                                    )}
                                </div>
                            </div>

                            {/* Warnings */}
                            {!isBrokerReady && (
                                <div className="flex items-start gap-2 bg-amber-500/10 border border-amber-500/30 rounded-xl p-3">
                                    <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
                                    <p className="text-amber-300 text-xs">TradingView not connected — open TV Desktop with <code className="bg-slate-800 px-1 rounded">--remote-debugging-port=9222</code> and ensure Broker is connected.</p>
                                </div>
                            )}
                            {isDataStale && (
                                <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 space-y-2">
                                    <div className="flex items-start gap-2">
                                        <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
                                        <p className="text-amber-300 text-xs">Portfolio data is stale ({provenance?.portfolioSyncAgeMin} min old). Run <strong>/tv-portfolio-sync</strong> to refresh.</p>
                                    </div>
                                    <label className="flex items-center gap-2 cursor-pointer pl-5">
                                        <input type="checkbox" checked={ackStale} onChange={e => setAckStale(e.target.checked)}
                                            className="w-3.5 h-3.5 rounded accent-amber-500" />
                                        <span className="text-amber-400/80 text-xs">Proceed anyway with stale data</span>
                                    </label>
                                </div>
                            )}

                            {/* ── Order Details — TV-style ── */}
                            <div className="space-y-3">
                                <div className="text-[10px] font-black uppercase tracking-widest text-slate-500">Order Details</div>

                                {/* Bid/Ask bar — active side highlighted based on action */}
                                <div className="flex items-center justify-between mb-1">
                                    <div className="flex items-center gap-2">
                                        <span className="text-[10px] font-black uppercase tracking-widest text-slate-500">Bid / Ask</span>
                                        {quote?.source && (
                                            <span className={`text-[9px] font-black px-1.5 py-0.5 rounded font-mono ${
                                                quote.source === 'tradingview'
                                                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                                                    : 'bg-slate-800 text-slate-400 border border-slate-700'
                                            }`}>
                                                {quote.source === 'tradingview' ? 'TV LIVE' : 'YFINANCE'}
                                            </span>
                                        )}
                                    </div>
                                    <button onClick={refreshQuote} disabled={quoteRefreshing}
                                        className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40">
                                        <RefreshCw size={10} className={quoteRefreshing ? 'animate-spin' : ''} />
                                        {quoteRefreshing ? 'Refreshing…' : 'Refresh'}
                                    </button>
                                </div>
                                {quote && (quote.bid != null || quote.ask != null) && (() => {
                                    const isBuyAction = action === 'buy';
                                    return (
                                        <div className="flex rounded-lg overflow-hidden border border-slate-700">
                                            <div className={`flex-1 flex flex-col items-center py-2.5 transition-colors ${!isBuyAction ? 'bg-red-950/60' : 'bg-slate-800/40'}`}>
                                                <span className={`text-[10px] uppercase tracking-widest mb-0.5 ${!isBuyAction ? 'text-red-400/80' : 'text-slate-600'}`}>Sell / Bid</span>
                                                <span className={`font-mono font-bold text-lg leading-none ${!isBuyAction ? 'text-red-300' : 'text-slate-500'}`}>
                                                    {quote.bid != null ? quote.bid.toFixed(2) : '—'}
                                                </span>
                                            </div>
                                            {quote.bid != null && quote.ask != null && (
                                                <div className="flex items-center justify-center px-3 text-slate-600 text-[10px] font-mono border-x border-slate-700/60 min-w-[48px]">
                                                    {(quote.ask - quote.bid).toFixed(2)}
                                                </div>
                                            )}
                                            <div className={`flex-1 flex flex-col items-center py-2.5 transition-colors ${isBuyAction ? 'bg-emerald-950/60' : 'bg-slate-800/40'}`}>
                                                <span className={`text-[10px] uppercase tracking-widest mb-0.5 ${isBuyAction ? 'text-emerald-400/80' : 'text-slate-600'}`}>Ask / Buy</span>
                                                <span className={`font-mono font-bold text-lg leading-none ${isBuyAction ? 'text-emerald-300' : 'text-slate-500'}`}>
                                                    {quote.ask != null ? quote.ask.toFixed(2) : '—'}
                                                </span>
                                            </div>
                                        </div>
                                    );
                                })()}

                                {/* Order type — horizontal tabs, TV underline style */}
                                <div className="flex border-b border-slate-700">
                                    {ORDER_TYPES.map(t => (
                                        <button key={t.value} onClick={() => setOrderType(t.value)}
                                            className={`flex-1 py-1.5 text-xs font-semibold transition-colors border-b-2 -mb-px ${
                                                orderType === t.value
                                                    ? 'text-white border-white'
                                                    : 'text-slate-500 border-transparent hover:text-slate-300'
                                            }`}>
                                            {t.label}
                                        </button>
                                    ))}
                                </div>

                                {/* Price fields (before Shares, matching TV layout) */}
                                <div className="grid grid-cols-2 gap-3">
                                    {/* Stop Price — Stop and Stop Limit */}
                                    {(orderType === 'stop' || orderType === 'stop_limit') && (
                                        <label className="flex flex-col gap-1">
                                            <span className="text-xs text-slate-500">Stop Price</span>
                                            <div className="relative">
                                                <input type="number" step="0.01" value={stopPrice}
                                                    onChange={e => setStopPrice(e.target.value)}
                                                    className="w-full bg-slate-800 border border-indigo-500/50 rounded-lg px-3 py-2 pr-10 text-white text-sm focus:outline-none focus:border-indigo-400"
                                                />
                                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 font-mono">
                                                    {action === 'sell' ? 'Bid' : 'Ask'}
                                                </span>
                                            </div>
                                        </label>
                                    )}
                                    {/* Limit Price — Limit and Stop Limit */}
                                    {(orderType === 'limit' || orderType === 'stop_limit') && (
                                        <label className="flex flex-col gap-1">
                                            <span className="text-xs text-slate-500">{orderType === 'stop_limit' ? 'Limit Price' : 'Price'}</span>
                                            <div className="relative">
                                                <input type="number" step="0.01" value={limitPrice}
                                                    onChange={e => setLimitPrice(e.target.value)}
                                                    placeholder={action === 'sell' ? quote?.bid?.toFixed(2) : quote?.ask?.toFixed(2)}
                                                    className="w-full bg-slate-800 border border-indigo-500/50 rounded-lg px-3 py-2 pr-10 text-white text-sm focus:outline-none focus:border-indigo-400"
                                                />
                                                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-slate-500 font-mono">
                                                    {orderType === 'stop_limit' ? 'Stop+1' : action === 'sell' ? 'Bid' : 'Ask'}
                                                </span>
                                            </div>
                                        </label>
                                    )}
                                </div>

                                {/* Shares + Account in a row */}
                                <div className="grid grid-cols-2 gap-3">
                                    <label className="flex flex-col gap-1">
                                        <span className="text-xs text-slate-500">Shares</span>
                                        <input type="number" min={1} value={shares}
                                            onChange={e => setShares(Math.max(1, parseInt(e.target.value) || 1))}
                                            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-slate-500"
                                        />
                                    </label>
                                    <label className="flex flex-col gap-1">
                                        <span className="text-xs text-slate-500">Account</span>
                                        <select value={account} onChange={e => setAccount(e.target.value)}
                                            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-slate-500">
                                            {ACCOUNTS.map(a => <option key={a} value={a}>{a.toUpperCase()}</option>)}
                                        </select>
                                    </label>
                                </div>

                                {/* Time in Force — shown for all order types; market state badge */}
                                <div className="space-y-1.5">
                                    <div className="flex items-center justify-between">
                                        <span className="text-xs text-slate-500">Time in Force</span>
                                        {quote?.marketState && (() => {
                                            const ms = quote.marketState;
                                            const cfg: Record<string, { label: string; cls: string }> = {
                                                REGULAR: { label: 'Market Open', cls: 'bg-emerald-500/15 text-emerald-400' },
                                                PRE:     { label: 'Pre-Market',  cls: 'bg-sky-500/15 text-sky-400' },
                                                POST:    { label: 'After Hours', cls: 'bg-amber-500/15 text-amber-400' },
                                                CLOSED:  { label: 'Closed',      cls: 'bg-slate-700 text-slate-400' },
                                            };
                                            const c = cfg[ms] ?? cfg.CLOSED;
                                            return <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${c.cls}`}>{c.label}</span>;
                                        })()}
                                    </div>
                                    <select value={timeInForce} onChange={e => setTimeInForce(e.target.value)}
                                        className="w-full bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-white text-sm focus:outline-none focus:border-slate-500">
                                        {TIME_IN_FORCE.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                                    </select>
                                    {/* Warn if Day selected outside regular hours */}
                                    {timeInForce === 'day' && quote?.marketState && quote.marketState !== 'REGULAR' && (
                                        <div className="flex items-start gap-1.5 text-amber-400/90 text-[10px]">
                                            <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                                            <span>Day orders expire at market close — use <strong>Good till cancelled</strong> or <strong>Good til extended market</strong> for {quote.marketState === 'PRE' ? 'pre-market' : 'after-hours'} execution.</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {/* Step: Running preflight */}
                    {step === 'running_preflight' && (
                        <div className="p-8 flex flex-col items-center gap-4 text-center">
                            <Loader2 size={32} className="text-indigo-400 animate-spin" />
                            <div>
                                <div className="text-white font-semibold">Running preflight check...</div>
                                <div className="text-slate-500 text-sm mt-1">Checking broker status and buying power via CDP</div>
                            </div>
                        </div>
                    )}

                    {/* Step: Preflight result — TV "Order confirmation" style */}
                    {step === 'preflight_result' && (
                        <div className="p-5 space-y-4">
                            {preflightState === 'PREFLIGHT_PASSED' && preflightCard ? (() => {
                                const isSell = action === 'sell';
                                const tif = TIME_IN_FORCE.find(t => t.value === timeInForce)?.label ?? timeInForce;
                                const orderSummary = (() => {
                                    const side = isSell ? 'Sell' : 'Buy';
                                    const qty = preflightCard.shares ?? shares;
                                    const sym = preflightCard.ticker ?? ticker;
                                    if (orderType === 'market') return `${side} ${qty} ${sym} Market`;
                                    if (orderType === 'limit') return `${side} ${qty} ${sym} @ $${limitPrice} Limit ${tif}`;
                                    if (orderType === 'stop') return `${side} ${qty} ${sym} @ $${stopPrice} Stop ${tif}`;
                                    return `${side} ${qty} ${sym} @ $${stopPrice} Stop $${limitPrice} Limit ${tif}`;
                                })();
                                const tradeValue = preflightCard.costEstimate != null
                                    ? `${preflightCard.shares ?? shares} × $${(orderType === 'limit' || orderType === 'stop_limit') ? limitPrice : (quote?.price?.toFixed(2) ?? '—')} = ${isSell ? 'CR' : 'DR'} ${preflightCard.costEstimateDisplay}`
                                    : '—';
                                return (
                                    <>
                                        {/* Order summary callout — like TV's amber banner */}
                                        <div className="flex items-start gap-2.5 bg-amber-500/10 border border-amber-500/30 rounded-xl px-4 py-3">
                                            <AlertTriangle size={15} className="text-amber-400 shrink-0 mt-0.5" />
                                            <div>
                                                <p className={`text-sm font-bold ${isSell ? 'text-red-300' : 'text-emerald-300'}`}>{orderSummary}</p>
                                                <p className="text-amber-400/70 text-[10px] mt-0.5">Exchange and ECN fees, SEC fees may apply for US securities.</p>
                                            </div>
                                        </div>

                                        {/* Market snapshot */}
                                        <div className="rounded-xl border border-slate-700/50 overflow-hidden">
                                            <div className="bg-slate-800/30 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Market</div>
                                            <div className="divide-y divide-slate-800/60">
                                                <ConfRow label="Symbol" value={`NASDAQ:${preflightCard.ticker ?? ticker}`} />
                                                {quote?.ask != null && <ConfRow label="Ask" value={`${quote.ask.toFixed(2)}`} />}
                                                {quote?.bid != null && <ConfRow label="Bid" value={`${quote.bid.toFixed(2)}`} />}
                                                {quote?.price != null && <ConfRow label="Last" value={`${quote.price.toFixed(2)}`} />}
                                            </div>
                                        </div>

                                        {/* Order details */}
                                        <div className="rounded-xl border border-slate-700/50 overflow-hidden">
                                            <div className="bg-slate-800/30 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Order</div>
                                            <div className="divide-y divide-slate-800/60">
                                                <ConfRow label="Type" value={preflightCard.priceDisplay ?? orderType} />
                                                <ConfRow label="Side" value={String(preflightCard.action ?? action).toUpperCase()}
                                                    valueClass={isSell ? 'text-red-400' : 'text-emerald-400'} />
                                                <ConfRow label="Quantity" value={String(preflightCard.shares ?? shares)} />
                                                {(orderType === 'limit' || orderType === 'stop_limit') && limitPrice &&
                                                    <ConfRow label="Limit Price" value={`$${limitPrice}`} />}
                                                {(orderType === 'stop' || orderType === 'stop_limit') && stopPrice &&
                                                    <ConfRow label="Stop Price" value={`$${stopPrice}`} />}
                                                <ConfRow label="Account"
                                                    value={`${preflightCard.accountType ?? account.toUpperCase()}${preflightCard.accountId ? ` (#${preflightCard.accountId})` : ''}`} />
                                                <ConfRow label="Time in Force" value={tif} />
                                            </div>
                                        </div>

                                        {/* Estimated + Buying power */}
                                        <div className="rounded-xl border border-slate-700/50 overflow-hidden">
                                            <div className="bg-slate-800/30 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500">Estimated</div>
                                            <div className="divide-y divide-slate-800/60">
                                                <ConfRow label="Commission & fees*" value="$0.00" />
                                                <ConfRow label="Trade value" value={tradeValue} />
                                            </div>
                                            <div className="bg-slate-800/30 px-4 py-2 text-[10px] font-black uppercase tracking-widest text-slate-500 border-t border-slate-700/50">Buying Power</div>
                                            <div className="divide-y divide-slate-800/60">
                                                <ConfRow label="Available"
                                                    value={preflightCard.buyingPowerDisplay ?? '—'}
                                                    flag={preflightCard.coverage?.sufficient ? '✓ Sufficient' : '✗ Insufficient'}
                                                    warn={!preflightCard.coverage?.sufficient} />
                                                {preflightCard.dataFreshnessMinutes != null && (
                                                    <ConfRow label="Data age"
                                                        value={`${preflightCard.dataFreshnessMinutes} min`}
                                                        flag={preflightCard.dataFreshnessMinutes <= 60 ? '✓ Fresh' : '⚠ Stale'}
                                                        warn={preflightCard.dataFreshnessMinutes > 60} />
                                                )}
                                            </div>
                                        </div>

                                        {(executeError || submitError) && (
                                            <div className="flex items-start gap-2 bg-red-500/10 border border-red-500/30 rounded-xl p-3">
                                                <AlertTriangle size={14} className="text-red-400 mt-0.5 shrink-0" />
                                                <p className="text-red-300 text-xs">{executeError || submitError}</p>
                                            </div>
                                        )}
                                    </>
                                );
                            })() : (
                                <div className="space-y-3">
                                    <div className="flex items-center gap-2">
                                        <AlertTriangle size={18} className="text-red-400" />
                                        <span className="text-red-400 font-bold">
                                            {preflightState === 'DATA_STALE_BLOCKED' ? 'Blocked — Stale Data'
                                                : preflightState === 'SIZE_CAP_BLOCKED' ? 'Blocked — Size Cap'
                                                : 'Preflight Failed'}
                                        </span>
                                    </div>
                                    <p className="text-slate-300 text-sm">{preflightError || preflightCard?._freshnessWarning}</p>
                                    {preflightCard?._sizeWarning && (
                                        <p className="text-amber-300 text-xs">{preflightCard._sizeWarning}</p>
                                    )}
                                </div>
                            )}
                        </div>
                    )}

                    {/* Step: Running execute */}
                    {step === 'running_execute' && (
                        <div className="p-8 flex flex-col items-center gap-4 text-center">
                            <Loader2 size={32} className="text-indigo-400 animate-spin" />
                            <div>
                                <div className="text-white font-semibold">Opening order dialog in TradingView...</div>
                                <div className="text-slate-500 text-sm mt-1">Filling the form via CDP — this may take 15–30 seconds</div>
                            </div>
                        </div>
                    )}

                    {/* Step: Submitting */}
                    {step === 'submitting' && (
                        <div className="p-8 flex flex-col items-center gap-4 text-center">
                            <Loader2 size={32} className="text-indigo-400 animate-spin" />
                            <div>
                                <div className="text-white font-semibold">Submitting order...</div>
                                <div className="text-slate-500 text-sm mt-1">Confirming and syncing portfolio after submission</div>
                            </div>
                        </div>
                    )}

                    {/* Step: Done */}
                    {step === 'done' && (
                        <div className="p-5 space-y-4">
                            <div className="flex items-center gap-2">
                                <CheckCircle size={20} className="text-emerald-400" />
                                <span className="text-emerald-400 font-bold text-lg">Order Submitted</span>
                            </div>
                            <p className="text-slate-300 text-sm">Your order has been submitted via TradingView. Portfolio sync is running in the background.</p>
                            {submitResult?.status && (
                                <div className="bg-slate-800/60 rounded-xl border border-slate-700/50 p-3">
                                    <span className="text-slate-400 text-xs font-mono">{JSON.stringify(submitResult, null, 2)}</span>
                                </div>
                            )}
                        </div>
                    )}

                </div>

                {/* Footer */}
                <div className="px-5 py-4 border-t border-slate-800 flex items-center justify-between gap-3">
                    {step === 'done' ? (
                        <button onClick={onClose} className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-bold transition-colors">
                            Done
                        </button>
                    ) : step === 'configure' ? (
                        <>
                            <button onClick={onClose} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors">
                                Cancel
                            </button>
                                <button
                                onClick={() => runPreflight()}
                                disabled={!isBrokerReady || !provenance || (isDataStale && !ackStale)}
                                title={!isBrokerReady ? 'TradingView must be connected' : (isDataStale && !ackStale) ? 'Check the box to proceed with stale data' : undefined}
                                className={`flex-1 px-4 py-2 rounded-lg text-sm font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed text-white flex flex-col items-center leading-tight py-2.5 ${
                                    action === 'sell'
                                        ? 'bg-red-700 hover:bg-red-600 shadow-lg shadow-red-900/20'
                                        : 'bg-emerald-700 hover:bg-emerald-600 shadow-lg shadow-emerald-900/20'
                                }`}
                            >
                                <span className="text-base font-black">{action === 'sell' ? 'Sell' : 'Buy'}</span>
                                <span className="text-[10px] opacity-80 font-normal">
                                    {shares} {ticker}
                                    {orderType === 'market' ? ' MARKET'
                                        : orderType === 'limit' && limitPrice ? ` @ $${limitPrice} LIMIT`
                                        : orderType === 'stop' && stopPrice ? ` @ $${stopPrice} STOP`
                                        : orderType === 'stop_limit' && stopPrice ? ` @ $${stopPrice} STOP $${limitPrice} LIMIT`
                                        : ` ${orderType.toUpperCase()}`}
                                </span>
                            </button>
                        </>
                    ) : step === 'preflight_result' && preflightState === 'PREFLIGHT_PASSED' ? (
                        <>
                            <button onClick={onClose} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors">
                                Cancel
                            </button>
                            <button
                                onClick={runExecute}
                                className={`flex-1 px-4 py-2 text-white rounded-lg text-sm font-bold transition-colors ${
                                    action === 'sell'
                                        ? 'bg-red-700 hover:bg-red-600'
                                        : 'bg-emerald-700 hover:bg-emerald-600'
                                }`}
                            >
                                {action === 'sell' ? 'Sell' : 'Buy'} via TradingView →
                            </button>
                        </>
                    ) : step === 'preflight_result' ? (
                        <>
                            <button onClick={() => setStep('configure')} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors">
                                ← Back
                            </button>
                            <button onClick={onClose} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-sm font-medium transition-colors">
                                Close
                            </button>
                        </>
                    ) : (
                        // Loading states: no footer buttons
                        <div className="flex-1" />
                    )}
                </div>
            </div>
        </div>,
        document.body
    );
}
