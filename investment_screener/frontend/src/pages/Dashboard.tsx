/**
 * Dashboard.tsx (React Page)
 * =====================================
 *
 * Purpose:
 *     The primary analytics hub for a selected stock, providing an overview of metrics, charts, and valuation modeling.
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <Dashboard />
 *
 * Key Functions:
 *     - performSearch() - Orchestrates the full data fetching lifecycle for a ticker, including financials and AI thesis
 *     - loadAIThesis() - Retrieves and synchronizes existing AI-generated projections and rationale from storage
 *     - handleInputSubmit() - Updates the URL search parameters to trigger a new stock search
 *     - Technicals tab hosts the anonymous public TradingView embeds (TradingViewWidget), collapsed by default
 */
import { useRecommendations } from '../contexts/useRecommendations';

import { useState, useEffect, useCallback } from 'react';
import type { ComponentProps } from 'react';
import { useSearchParams } from 'react-router-dom';
import { fetchStockData, fetchTargetPortfolio, fetchTechnicalAnalysis, type StockData, type ValuationResult, type Projection, type TechnicalAnalysisData } from '../services/api';
import { useRecentTickers } from '../hooks/useRecentTickers';
import MetricsGrid from '../components/MetricsGrid';
import FinancialChart from '../components/analysis/FinancialChart';
import AnalysisChartToggle, { type ChartMode } from '../components/analysis/AnalysisChartToggle';
import ValuationModeler from '../components/ValuationModeler';
import { LayoutDashboard, BarChart3, Calculator, Code, Activity, Zap } from 'lucide-react';
import PerformanceMetrics from '../components/PerformanceMetrics';
import { AIThesisSummary } from '../components/AIThesisSummary';
import { TargetThesisDetails } from '../components/TargetThesisDetails';
import { TechnicalAnalysisSummaryCard } from '../components/TechnicalAnalysisSummaryCard';
import { AgentResearchPromptCard } from '../components/AgentResearchPromptCard';
import { AIAnalysisModal } from '../components/AIAnalysisModal';
import { PineScriptViewerModal } from '../components/PineScriptViewerModal';
import { TradeButtons } from '../components/TradeButtons';
import { TradingViewWidget } from '../components/TradingViewWidget';
import { storage } from '../services/storage';
import { SmartText } from '../components/SmartText';
import { stanceOf } from '../utils/riskReward';

type Tab = 'overview' | 'technicals' | 'analysis' | 'valuation';

export default function Dashboard() {
    const recommendations = useRecommendations();
    const [searchParams, setSearchParams] = useSearchParams();
    const [activeTab, setActiveTab] = useState<Tab>('overview');
    // Public TradingView embeds load a remote script, so they stay collapsed until asked for.
    const [showTradingView, setShowTradingView] = useState(false);
    const [chartMode, setChartMode] = useState<ChartMode>('revenue');
    const [stockData, setStockData] = useState<StockData | null>(null);
    const [technicalAnalysis, setTechnicalAnalysis] = useState<TechnicalAnalysisData | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const { addTicker } = useRecentTickers();

    const [targetHolding, setTargetHolding] = useState<any | null>(null);
    const [aiResult, setAiResult] = useState<ValuationResult | null>(null);
    const [viewingProjection, setViewingProjection] = useState<Projection | null>(null);
    const [showAIModal, setShowAIModal] = useState(false);
    const [showPineModal, setShowPineModal] = useState(false);

    const loadTargetHolding = useCallback(async (ticker: string) => {
        try {
            const data = await fetchTargetPortfolio();
            const holding = data.holdings?.find((h: any) => h.ticker.toUpperCase() === ticker.toUpperCase());
            setTargetHolding(holding || null);
        } catch (err) {
            console.error("Failed to load target holding details:", err);
            setTargetHolding(null);
        }
    }, []);

    const loadAIThesis = useCallback(async (ticker: string) => {
        try {
            const saved = await storage.syncProjections(ticker);
            const aiProjections = saved.filter(p => p.source === 'AI_AGENT' || p.source === 'ETF_ANALYSIS');
            
            if (aiProjections.length > 0) {
                // Sort by date descending
                const latest = aiProjections.sort((a, b) => new Date(b.savedAt).getTime() - new Date(a.savedAt).getTime())[0];
                
                if (latest.aiThesis) {
                    const thesis = latest.aiThesis;
                    const base = latest.scenarios.base;
                    setAiResult({
                        fair_value: thesis.fairValue,
                        model_name: thesis.model,
                        rationale: latest.rationale || thesis.rationale,
                        action: thesis.action as any,
                        growth_assumption: base ? base.growthRate / 100 : 0,
                        researchReport: thesis.researchReport
                    } as any);
                    setViewingProjection(latest);
                }
            } else {
                setAiResult(null);
                setViewingProjection(null);
            }
        } catch (err) {
            console.error("Failed to load AI thesis:", err);
        }
    }, []);

    const performSearch = async (ticker: string) => {
        if (!ticker) return;
        
        setLoading(true);
        setError(null);
        setStockData(null);
        setTechnicalAnalysis(null);
        setAiResult(null);
        setViewingProjection(null);
        setTargetHolding(null);

        try {
            const data = await fetchStockData(ticker);
            setStockData(data);
            addTicker(ticker);
            loadAIThesis(ticker);
            await loadTargetHolding(ticker);
            const taData = await fetchTechnicalAnalysis(ticker);
            setTechnicalAnalysis(taData);
        } catch (err: any) {
            console.error("Search failed:", err);
            setError(err.message || "Failed to fetch stock data");
        } finally {
            setLoading(false);
        }
    };

    // Auto-load from URL
    useEffect(() => {
        const tickerParam = searchParams.get('ticker');
        if (tickerParam) {
            // Only fetch if it's a new ticker and we're not already displaying it
            if (!stockData || stockData.symbol !== tickerParam) {
                 performSearch(tickerParam);
            }
        }
    }, [searchParams]); // Dependency on searchParams is fine now as performSearch doesn't update it

    const handleInputSubmit = (ticker: string) => {
         // Just update the URL, the useEffect will handle the fetch
        setSearchParams({ ticker });
    };

    // If no stock selected, show welcome message with search
    if (!stockData && !loading && !error) {
        return (
            <div className="flex items-center justify-center h-full">
                <div className="text-center max-w-md">
                    <div className="text-6xl mb-4">📊</div>
                    <h2 className="text-2xl font-bold text-white mb-2">Stock Analysis</h2>
                    <p className="text-slate-400 mb-6">
                        Enter a stock symbol below or click on a stock in the Heatmap.
                    </p>
                    <div className="mb-4">
                        <input
                            type="text"
                            placeholder="Enter ticker (e.g. NVDA)"
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    const val = e.currentTarget.value.trim().toUpperCase();
                                    if (val) handleInputSubmit(val);
                                }
                            }}
                            className="w-full bg-slate-900 border border-slate-700 rounded-lg px-4 py-3 text-white text-center focus:border-primary focus:outline-none placeholder:text-slate-500"
                            autoFocus
                        />
                    </div>
                    <div className="text-xs text-slate-500">
                        Examples: NVDA, AAPL, MSFT, GOOG, AMD
                    </div>
                </div>
            </div>
        );
    }

    const isETF = Boolean((stockData as any)?.profile?.type === 'ETF' || (stockData as any)?.profile?.assetType === 'ETF' || ((stockData as any)?.profile?.industry || '').toLowerCase().includes('etf'));
    const hasProjection = Boolean(stockData && Array.isArray(storage.getProjections(stockData.symbol)) && storage.getProjections(stockData.symbol).length > 0);

    return (
        <div className="flex flex-col h-full overflow-hidden">
            {loading && (
                <div className="flex-1 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-4">
                        <div className="animate-spin rounded-full h-10 w-10 border-2 border-primary border-t-transparent"></div>
                        <span className="text-slate-400">Loading stock data...</span>
                    </div>
                </div>
            )}

            {error && (
                <div className="flex-1 flex items-center justify-center p-6">
                    <div className="bg-slate-900 border border-slate-800 text-slate-300 p-8 rounded-2xl text-center max-w-lg shadow-2xl">
                        <div className="text-5xl mb-4">🔍</div>
                        <div className="text-xl font-bold text-white mb-2">
                            {/not found|delisted|insufficient/i.test(error) ? "Symbol Not Found" : "Unable to Load Stock Data"}
                        </div>
                        <div className="text-slate-400 text-sm mb-6 leading-relaxed">
                            {/not found|delisted|insufficient/i.test(error)
                                ? `We couldn't find any financial or price data for "${searchParams.get('ticker') || ''}". The symbol may be mistyped, delisted, or not covered.`
                                : error}
                        </div>
                        <div className="flex flex-col gap-3">
                            <input
                                type="text"
                                placeholder="Try another ticker (e.g. KRMN, NVDA)"
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') {
                                        const val = e.currentTarget.value.trim().toUpperCase();
                                        if (val) handleInputSubmit(val);
                                    }
                                }}
                                className="w-full bg-slate-950 border border-slate-700 rounded-lg px-4 py-3 text-white text-center focus:border-primary focus:outline-none placeholder:text-slate-500"
                                autoFocus
                            />
                            <div className="text-xs text-slate-500">
                                Press Enter to search
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {stockData && (
                <div className="flex flex-col h-full overflow-hidden">
                    {/* Header Bar */}
                    <div className="flex justify-between items-center px-6 py-4 border-b border-slate-800 flex-shrink-0">
                        <div className="flex items-center gap-6">
                            {/* Ticker Info */}
                            <div className="flex items-center gap-4">
                                <div>
                                    <h2 className="text-2xl font-bold text-white">{stockData.symbol}</h2>
                                </div>
                            </div>

                            {/* Price */}
                            <div className="h-8 w-px bg-slate-800" />
                            <div>
                                <span className="text-2xl font-bold text-primary">${stockData.price?.toFixed(2)}</span>
                                <span className="text-sm text-slate-500 ml-2">Current Price</span>
                            </div>

                            {/* Performance Strip */}
                            {stockData.performance && (
                                <>
                                    <div className="h-8 w-px bg-slate-800" />
                                    <div>
                                        <PerformanceMetrics performance={stockData.performance} />
                                    </div>
                                </>
                            )}

                            {/* Upcoming Catalyst & Binary Event Ribbon */}
                            {stockData.symbol === 'IREN' && (
                                <div className="hidden xl:flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 px-3 py-1 rounded-lg text-amber-300 text-xs font-semibold">
                                    <Zap size={13} className="text-amber-400 animate-pulse" />
                                    <span>Catalyst: Q4 Earnings & AI Cloud Update (Aug 27)</span>
                                </div>
                            )}
                            {stockData.symbol === 'STM' && (
                                <div className="hidden xl:flex items-center gap-2 bg-indigo-500/10 border border-indigo-500/30 px-3 py-1 rounded-lg text-indigo-300 text-xs font-semibold">
                                    <Zap size={13} className="text-indigo-400" />
                                    <span>Target Allocation: 3.69% · Silicon Carbide Automotive Ramp</span>
                                </div>
                            )}
                        </div>

                        {/* Trade buttons + Navigation Tabs */}
                        <div className="flex items-center gap-3">
                        <button
                            onClick={() => setShowPineModal(true)}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20 transition shadow-sm"
                            title="View / Copy TradingView Pine Script Overlay for this stock"
                        >
                            <Code size={14} />
                            <span>TV Overlay</span>
                        </button>
                        <TradeButtons ticker={stockData.symbol} size="md" rating={(stanceOf(recommendations[stockData.symbol]) ?? undefined) as ComponentProps<typeof TradeButtons>['rating']} />
                        <div className="h-6 w-px bg-slate-800" />
                        <div className="flex bg-slate-900/50 p-1 rounded-lg border border-slate-800">
                            <button
                                onClick={() => setActiveTab('overview')}
                                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'overview' ? 'bg-primary/10 text-primary shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                            >
                                <LayoutDashboard size={16} />
                                Overview
                            </button>
                            <button
                                onClick={() => setActiveTab('technicals')}
                                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'technicals' ? 'bg-primary/10 text-primary shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                            >
                                <Activity size={16} />
                                Technicals
                            </button>
                            <button
                                onClick={() => setActiveTab('analysis')}
                                className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'analysis' ? 'bg-primary/10 text-primary shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                            >
                                <BarChart3 size={16} />
                                Analysis
                            </button>

                            {/* Valuation tab is hidden for ETFs unless a projection exists */}
                            {(() => {
                                const isETF = Boolean((stockData as any)?.profile?.type === 'ETF' || (stockData as any)?.profile?.assetType === 'ETF' || ((stockData as any)?.profile?.industry || '').toLowerCase().includes('etf'));
                                const projections = storage.getProjections(stockData?.symbol || '');
                                const hasProjection = Array.isArray(projections) && projections.length > 0;
                                if (!isETF || hasProjection) {
                                    return (
                                        <button
                                            onClick={() => setActiveTab('valuation')}
                                            className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium transition-all ${activeTab === 'valuation' ? 'bg-primary/10 text-primary shadow-sm' : 'text-slate-400 hover:text-slate-200'}`}
                                        >
                                            <Calculator size={16} />
                                            Valuation
                                        </button>
                                    );
                                }
                                // For ETFs without projections show a tooltip-like disabled button
                                return (
                                    <button
                                        title="Valuation not available for ETFs"
                                        disabled
                                        className={`flex items-center gap-2 px-4 py-2 rounded-md text-sm font-medium opacity-40 cursor-not-allowed`}
                                    >
                                        <Calculator size={16} />
                                        Valuation
                                    </button>
                                );
                            })()}
                        </div>
                        </div>{/* end trade+tabs wrapper */}
                    </div>

                    {/* Tab Content */}
                    <div className="flex-1 overflow-y-auto p-6 scrollbar-thin scrollbar-thumb-slate-700 scrollbar-track-transparent">

                        {activeTab === 'overview' && (
                            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300">
                                <AgentResearchPromptCard
                                    symbol={stockData.symbol}
                                    hasThesis={Boolean(aiResult)}
                                    hasTechnicals={Boolean(technicalAnalysis)}
                                />
                                {targetHolding && (
                                    <TargetThesisDetails 
                                        holding={targetHolding} 
                                        currentPrice={stockData?.price} 
                                    />
                                )}
                                {aiResult && (
                                    <AIThesisSummary 
                                        aiResult={aiResult} 
                                        onViewFullReport={() => setShowAIModal(true)} 
                                    />
                                )}
                                <MetricsGrid stockData={stockData} projection={viewingProjection} />
                            </div>
                        )}

                        {activeTab === 'technicals' && (
                            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300 space-y-6">
                                {technicalAnalysis ? (
                                    <TechnicalAnalysisSummaryCard
                                        data={technicalAnalysis}
                                        currentPrice={stockData?.price}
                                    />
                                ) : (
                                    <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-8 text-center text-slate-400">
                                        <Activity size={32} className="mx-auto mb-3 text-slate-600 animate-pulse" />
                                        <h3 className="text-base font-bold text-white mb-1">Technical Analysis Data Loading...</h3>
                                        <p className="text-xs text-slate-500">Retrieving Multi-EMA alignment and momentum flow.</p>
                                    </div>
                                )}

                                <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-4">
                                    <button
                                        onClick={() => setShowTradingView((open) => !open)}
                                        className="flex items-center gap-2 text-sm font-semibold text-slate-200 hover:text-white"
                                        title="Widgets públicos de TradingView, sin iniciar sesión ni vincular cuentas"
                                    >
                                        <BarChart3 size={16} className="text-primary" />
                                        TradingView (público, sin cuenta)
                                        <span className="text-xs font-normal text-slate-500">{showTradingView ? 'ocultar' : 'mostrar'}</span>
                                    </button>
                                    {showTradingView && (
                                        <div className="mt-4 space-y-4">
                                            <TradingViewWidget kind="advanced-chart" symbol={stockData.symbol} height={460} />
                                            <TradingViewWidget kind="symbol-overview" symbol={stockData.symbol} height={260} />
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}

                        {activeTab === 'analysis' && (
                            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300 h-full flex flex-col space-y-4">
                                <div className="flex justify-between items-center">
                                    <h3 className="text-lg font-bold text-text">Historical Performance</h3>
                                    <AnalysisChartToggle activeMode={chartMode} onModeChange={setChartMode} />
                                </div>
                                <div className="flex-1 min-h-[500px] bg-slate-900/30 rounded-xl border border-slate-800 p-4">
                                    <FinancialChart stockData={stockData} mode={chartMode} />
                                </div>
                            </div>
                        )}

                        {activeTab === 'valuation' && (!isETF || hasProjection) && (
                            <div className="animate-in fade-in slide-in-from-bottom-4 duration-300 w-full h-full">
                                <ValuationModeler stockData={stockData} />
                            </div>
                        )}

                        {activeTab === 'valuation' && isETF && !hasProjection && (
                            <div className="p-6">
                                <div className="bg-slate-900/40 border border-slate-800 rounded-xl p-6 text-slate-400">
                                    <h3 className="text-lg font-bold text-white mb-2">Valuation not available for ETFs</h3>
                                    <p><SmartText text="Detailed DCF valuations are out-of-scope for ETFs. This ETF has no saved projections; you can request per-holding valuations or save a projection for this ETF to enable the valuation page." /></p>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}

            {/* AI Analysis Modal */}
            {stockData && (
                <AIAnalysisModal
                    isOpen={showAIModal}
                    onClose={() => setShowAIModal(false)}
                    symbol={stockData.symbol}
                    initialProjection={viewingProjection || undefined}
                />
            )}

            {/* Pine Script Viewer Modal */}
            {stockData && (
                <PineScriptViewerModal
                    isOpen={showPineModal}
                    onClose={() => setShowPineModal(false)}
                    symbol={stockData.symbol}
                    fairValue={aiResult?.fair_value || viewingProjection?.aiThesis?.fairValue}
                    targetEntry={targetHolding?.targetEntryPrice}
                    stopLoss={targetHolding?.stopLossPrice}
                    action={stockData ? stanceOf(recommendations[stockData.symbol]) : null}
                    breakerStatus={targetHolding?.breakerStatus}
                />
            )}
        </div>
    );
}
