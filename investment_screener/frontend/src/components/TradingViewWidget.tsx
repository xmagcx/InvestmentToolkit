/**
 * TradingViewWidget.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     Embeds a public TradingView widget (anonymous mode): the official external-embedding
 *     script is injected into a local container with a JSON config. No login, no account,
 *     no cookies set by us, no CDP and no unofficial websocket.
 *
 * Layer: Frontend / UI / Components
 *
 * Key Input Dependencies:
 *     - https://s3.tradingview.com/external-embedding/embed-widget-<kind>.js (loaded by the browser)
 *     - src/utils/tradingViewSymbol.ts for the ticker -> TradingView symbol mapping
 *
 * Usage Examples:
 *     <TradingViewWidget kind="advanced-chart" symbol="AAPL" height={420} />
 *     <TradingViewWidget kind="symbol-overview" symbol="RY.TO" />
 *     <TradingViewWidget kind="screener" height={500} />
 *
 * Key Functions:
 *     - TradingViewWidget() - injects/cleans the embed script and renders the required attribution.
 *     - widgetConfig() - builds the documented JSON config for each widget kind.
 */
import { useEffect, useRef } from 'react';
import { toTradingViewSymbol } from '../utils/tradingViewSymbol';

export type TradingViewWidgetKind = 'advanced-chart' | 'symbol-overview' | 'screener';

interface TradingViewWidgetProps {
    kind: TradingViewWidgetKind;
    /** Portfolio ticker; mapped to a TradingView symbol. Not used by the screener widget. */
    symbol?: string;
    /** Container height in pixels (the widgets are autosize inside it). */
    height?: number;
}

// Builds the JSON configuration TradingView documents for each embed widget.
function widgetConfig(kind: TradingViewWidgetKind, symbol: string): Record<string, unknown> {
    /**
     * Shared keys keep the widget anonymous and aligned with the dark UI: Spanish locale,
     * dark theme, autosize, no side toolbar and no symbol search (allow_symbol_change false),
     * so the embed never offers account-bound features.
     */
    const base = {
        autosize: true,
        symbol,
        locale: 'es',
        colorTheme: 'dark',
        theme: 'dark',
        hide_side_toolbar: true,
        allow_symbol_change: false,
        save_image: false,
        isTransparent: true,
    };
    if (kind === 'advanced-chart') {
        return { ...base, interval: 'D', style: '1', withdateranges: true, timezone: 'Etc/UTC' };
    }
    if (kind === 'symbol-overview') {
        return { ...base, symbols: [[symbol]], chartOnly: false, width: '100%', height: '100%' };
    }
    return { ...base, market: 'america', screener_type: 'stock', defaultColumn: 'overview' };
}

export function TradingViewWidget({ kind, symbol, height = 420 }: TradingViewWidgetProps) {
    const hostRef = useRef<HTMLDivElement>(null);
    let mapped = '';
    try {
        mapped = symbol ? toTradingViewSymbol(symbol) : '';
    } catch {
        mapped = '';
    }
    const needsSymbol = kind !== 'screener';

    useEffect(() => {
        const host = hostRef.current;
        if (!host || (needsSymbol && !mapped)) return;
        const widget = document.createElement('div');
        widget.className = 'tradingview-widget-container__widget';
        widget.style.height = '100%';
        const script = document.createElement('script');
        script.src = `https://s3.tradingview.com/external-embedding/embed-widget-${kind}.js`;
        script.async = true;
        script.innerHTML = JSON.stringify(widgetConfig(kind, mapped));
        host.appendChild(widget);
        host.appendChild(script);
        return () => {
            host.innerHTML = '';
        };
    }, [kind, mapped, needsSymbol]);

    return (
        <div className="tradingview-widget-container">
            {needsSymbol && !mapped ? (
                <p className="text-xs text-slate-500">Sin símbolo para mostrar en TradingView.</p>
            ) : (
                <div ref={hostRef} data-testid="tradingview-widget-host" style={{ height }} />
            )}
            <p className="mt-1 text-[11px] text-slate-500">
                Datos de TradingView, pueden estar diferidos ·{' '}
                <a
                    href="https://www.tradingview.com/"
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="text-slate-400 hover:text-slate-200 underline"
                >
                    TradingView
                </a>
            </p>
        </div>
    );
}

export default TradingViewWidget;
