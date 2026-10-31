import { useState, useEffect } from 'react';
import { TradePrepModal } from './TradePrepModal';
import { useFeatureFlags } from '../hooks/useFeatureFlags';

interface TradeButtonsProps {
    ticker: string;
    shares?: number;
    size?: 'sm' | 'md';
    rating?: 'BUY' | 'SELL' | 'HOLD' | 'INITIATE' | 'ACCUMULATE' | 'MAINTAIN' | 'TRIM' | 'EXIT' | 'WATCHLIST';
    className?: string;
}

export function TradeButtons({ ticker, shares = 1, size = 'md', rating, className = '' }: TradeButtonsProps) {
    const { broker_integration } = useFeatureFlags();
    const [tvConnected, setTvConnected] = useState(false);
    const [modal, setModal] = useState<{ action: 'buy' | 'sell' } | null>(null);

    useEffect(() => {
        fetch('/api/tv-status')
            .then(r => r.json())
            .then(d => setTvConnected(d.price_source === 'tradingview'))
            .catch(() => {});
    }, []);

    // Screener-only mode (spec S6): order placement is disabled backend-side, so offering
    // Buy/Sell here could only produce a 410. Nothing is rendered rather than a dead button.
    if (!broker_integration) return null;

    const sm = size === 'sm';
    const cls = sm
        ? 'px-2 py-0.5 text-[10px] font-bold rounded'
        : 'px-3.5 py-1.5 text-xs font-bold rounded-lg';
    const offlineTip = 'TradingView not connected — open TV Desktop with --remote-debugging-port=9222';

    // When a DCF signal is present, emphasize the signal-aligned button and ghost the other.
    const buyPrimary = !rating || ['BUY', 'HOLD', 'INITIATE', 'ACCUMULATE', 'MAINTAIN'].includes(rating);
    const sellPrimary = !rating || ['SELL', 'HOLD', 'TRIM', 'EXIT', 'MAINTAIN'].includes(rating);
    const buyStyle = tvConnected
        ? buyPrimary
            ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
            : 'bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-emerald-400 border border-slate-600'
        : 'bg-slate-800 text-slate-600 border border-slate-700 cursor-not-allowed';
    const sellStyle = tvConnected
        ? sellPrimary
            ? 'bg-red-700 hover:bg-red-600 text-white'
            : 'bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-red-400 border border-slate-600'
        : 'bg-slate-800 text-slate-600 border border-slate-700 cursor-not-allowed';

    return (
        <div className={`inline-flex items-center gap-1.5 ${className}`} onClick={e => e.stopPropagation()}>
            <button
                disabled={!tvConnected}
                onClick={() => setModal({ action: 'buy' })}
                title={tvConnected ? `Prepare buy order for ${ticker}` : offlineTip}
                className={`${cls} transition-colors ${buyStyle}`}
            >
                Buy
            </button>
            <button
                disabled={!tvConnected}
                onClick={() => setModal({ action: 'sell' })}
                title={tvConnected ? `Prepare sell order for ${ticker}` : offlineTip}
                className={`${cls} transition-colors ${sellStyle}`}
            >
                Sell
            </button>
            {!tvConnected && !sm && (
                <span className="text-[10px] text-slate-600 font-medium" title={offlineTip}>
                    TV Offline
                </span>
            )}

            {modal && (
                <TradePrepModal
                    ticker={ticker}
                    initialAction={modal.action}
                    initialShares={shares}
                    onClose={() => setModal(null)}
                />
            )}
        </div>
    );
}
