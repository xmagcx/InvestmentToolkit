/**
 * TechnicalTab.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose: Tab Técnico (S15): the project's technical summary card plus the opt-in public TradingView embeds, as the old Dashboard did.
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <TechnicalTab stock={stock} load={load} />
 */
import { useState } from 'react';
import { BarChart3 } from 'lucide-react';
import { fetchTechnicalAnalysis, type StockData, type TechnicalAnalysisData } from '../../services/api';
import { TechnicalAnalysisSummaryCard } from '../TechnicalAnalysisSummaryCard';
import { TradingViewWidget } from '../TradingViewWidget';
import { Empty, Loading } from './tabUi';
import { useResource, type Loader } from './useResource';

export function TechnicalTab({ stock, load }: { stock: StockData; load: Loader }) {
    const { loading, data } = useResource<TechnicalAnalysisData>(load, `tech:${stock.symbol}`, () => fetchTechnicalAnalysis(stock.symbol));
    const [showTv, setShowTv] = useState(false);
    return (
        <div className="space-y-6">
            {loading ? <Loading>Cargando análisis técnico…</Loading>
                : data ? <TechnicalAnalysisSummaryCard data={data} currentPrice={stock.price} />
                    : <Empty>Sin análisis técnico disponible para este valor.</Empty>}
            <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                <button type="button" onClick={() => setShowTv((v) => !v)} aria-expanded={showTv}
                    title="Widgets públicos de TradingView, sin iniciar sesión ni vincular cuentas"
                    className="flex items-center gap-2 text-sm font-semibold text-slate-200 hover:text-white">
                    <BarChart3 size={16} className="text-primary" />
                    TradingView (público, sin cuenta)
                    <span className="text-xs font-normal text-slate-400">{showTv ? 'ocultar' : 'mostrar'}</span>
                </button>
                {showTv && (
                    <div className="mt-4 space-y-4">
                        <TradingViewWidget kind="advanced-chart" symbol={stock.symbol} height={460} />
                        <TradingViewWidget kind="symbol-overview" symbol={stock.symbol} height={260} />
                    </div>
                )}
            </div>
        </div>
    );
}
