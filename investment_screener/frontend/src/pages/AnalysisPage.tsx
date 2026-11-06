/**
 * AnalysisPage.tsx (React Page)
 * =====================================
 *
 * Purpose:
 *     Análisis (/analysis): the SVI-explained view of one ticker, in three levels —
 *     Nivel 1 · Escanear (header card), Nivel 2 · Entender (signal + price-vs-value chart), Nivel 3 · Investigar (the eight tabs, data fetched when each opens).
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <Route path="analysis" element={<AnalysisPage />} />   // /analysis?ticker=MSFT
 *
 * Key Functions:
 *     - AnalysisPage() - reads ?ticker=, loads fetchStockData + fetchValueHistory(range), takes the call from useRecommendations()
 * Key Input Dependencies: fair value = recommendation entry fair_value, else the value-history current fair value (our saved projection).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useRecommendations } from '../contexts/useRecommendations';
import { useRecentTickers } from '../hooks/useRecentTickers';
import { fetchStockData, fetchValueHistory, type StockData, type ValueHistory, type ValueHistoryRange } from '../services/api';
import { AnalysisTabs, type AnalysisTab } from '../components/analysis/AnalysisTabs';
import { DescriptionTab } from '../components/analysis/DescriptionTab';
import { FilingsTab } from '../components/analysis/FilingsTab';
import { FinancialsTab } from '../components/analysis/FinancialsTab';
import { InvestorsTab } from '../components/analysis/InvestorsTab';
import { MonteCarloTab } from '../components/analysis/MonteCarloTab';
import { NewsTab } from '../components/analysis/NewsTab';
import { TechnicalTab } from '../components/analysis/TechnicalTab';
import { ValuationTab } from '../components/analysis/ValuationTab';
import { makeLoader } from '../components/analysis/useResource';
import { HeaderCard } from '../components/analysis/HeaderCard';
import { SignalCard } from '../components/analysis/SignalCard';
import { ValueChart } from '../components/analysis/ValueChart';

export default function AnalysisPage() {
    const recommendations = useRecommendations();
    const [searchParams, setSearchParams] = useSearchParams();
    const ticker = searchParams.get('ticker')?.trim().toUpperCase() || '';
    const { addTicker } = useRecentTickers();
    const [stock, setStock] = useState<StockData | null>(null);
    const [history, setHistory] = useState<ValueHistory | null>(null);
    const [range, setRange] = useState<ValueHistoryRange>('1y');
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        if (!ticker) return;
        let live = true;
        setLoading(true); setError(null); setStock(null);
        fetchStockData(ticker)
            .then((data) => { if (live) { setStock(data); addTicker(ticker); } })
            .catch((err: unknown) => { if (live) setError(err instanceof Error ? err.message : 'No se pudo cargar el ticker'); })
            .finally(() => { if (live) setLoading(false); });
        return () => { live = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps -- addTicker is re-created each render; only the ticker should refetch.
    }, [ticker]);

    useEffect(() => {
        if (!ticker) return;
        let live = true;
        fetchValueHistory(ticker, range).then((h) => { if (live) setHistory(h); });
        return () => { live = false; };
    }, [ticker, range]);

    // Changing the ticker drops the previous ticker's history so its fair value never shows on the new one.
    useEffect(() => { setHistory(null); setRange('1y'); }, [ticker]);

    // Tab data is fetched when a tab first opens; this cache keeps it for the rest of the page visit.
    const cache = useRef(new Map<string, Promise<unknown>>());
    const load = useMemo(() => makeLoader(cache.current), []);

    const searchBox = (placeholder: string) => (
        <input
            type="text"
            aria-label="Ticker"
            placeholder={placeholder}
            autoFocus
            onKeyDown={(e) => {
                const val = e.currentTarget.value.trim().toUpperCase();
                if (e.key === 'Enter' && val) setSearchParams({ ticker: val });
            }}
            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white text-center focus:border-primary focus:outline-none placeholder:text-slate-500"
        />
    );

    if (!ticker) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center max-w-md">
                    <h2 className="text-2xl font-bold text-white mb-2">Análisis</h2>
                    <p className="text-slate-400 mb-6">Escribe un ticker o elige una acción del mapa de calor.</p>
                    {searchBox('Ticker (p. ej. NVDA)')}
                </div>
            </div>
        );
    }
    if (loading && !stock) return <div className="p-6 text-slate-500 text-sm">Cargando {ticker}…</div>;
    if (error || !stock) {
        return (
            <div className="flex items-center justify-center h-full p-6">
                <div className="bg-slate-900 border border-slate-800 p-8 rounded-xl text-center max-w-lg">
                    <p className="text-red-400 text-sm mb-4">{error || `No se encontraron datos de ${ticker}.`}</p>
                    {searchBox('Probar otro ticker')}
                </div>
            </div>
        );
    }

    const rec = recommendations[ticker] ?? recommendations[stock.symbol] ?? null;
    const fairValue = rec?.fair_value ?? history?.current.fair_value ?? null;
    const company = stock.overview?.profile?.name || stock.symbol;
    const currency = stock.overview?.profile?.currency || stock.currency || 'USD';

    return (
        <div className="h-full overflow-y-auto p-4 space-y-4">
            <HeaderCard stock={stock} fairValue={fairValue} priceDate={history?.current.date ?? null} />
            <SignalCard rec={rec} company={company} />
            <ValueChart history={history} range={range} onRangeChange={setRange} currency={currency} />
            <AnalysisTabs renderPanel={(tab: AnalysisTab) => {
                switch (tab) {
                    case 'Descripción': return <DescriptionTab stock={stock} />;
                    case 'Financieros': return <FinancialsTab stock={stock} />;
                    case 'Valoración': return <ValuationTab stock={stock} fairValue={fairValue} />;
                    case 'Inversores': return <InvestorsTab stock={stock} ticker={ticker} load={load} />;
                    case 'Filings': return <FilingsTab ticker={ticker} load={load} />;
                    case 'Monte Carlo': return <MonteCarloTab ticker={ticker} company={company} load={load} />;
                    case 'Técnico': return <TechnicalTab stock={stock} load={load} />;
                    case 'Noticias': return <NewsTab ticker={ticker} load={load} />;
                }
            }} />
        </div>
    );
}
