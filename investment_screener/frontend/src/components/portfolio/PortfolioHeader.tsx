/**
 * PortfolioHeader.tsx - The calm top of the Portafolio page.
 *
 * Purpose:
 *     One hero figure (total USD) with the gain line under it, a quiet cash chip and a portfolio-volatility
 *     chip, the price-source badge as small secondary text, and one insight sentence built from the real
 *     risk data. No primary button: refresh is a quiet link and the thesis / review / agent-guide modals
 *     sit behind "Más" (demoted, still one click away).
 *
 * Layer: Frontend / Components / Portfolio
 *
 * Usage Examples:
 *     <PortfolioHeader positions={13} totalUsd={3908.6} risk={risk} gain={gain} insight={text} ... />
 *
 * Key Functions (Index):
 *     - PortfolioHeader(): hero, chips, insight, stamp, tools
 *
 * Key Input Dependencies:
 *     - portfolioMath.ts, PriceSourceBadge, services/api (PortfolioRisk type)
 *
 * Key Output Dependencies:
 *     - pages/PortfolioPage.tsx
 */
import { BookOpen, FileBarChart2, Terminal } from 'lucide-react';
import type { PortfolioRisk } from '../../services/api';
import { PriceSourceBadge } from '../PriceSourceBadge';
import { esNum, esPct, esUsd, type Gain } from './portfolioMath';

interface PortfolioHeaderProps {
    positions: number;
    totalUsd: number | null;
    risk: PortfolioRisk | null;
    riskError: string | null;
    gain: Gain | null;
    insight: string | null;
    hidden: boolean;
    priceSource: string | null;
    refreshedAt: Date | null;
    onRefresh: () => void;
    onThesis: () => void;
    onReview: () => void;
    onGuide: () => void;
}

const chip = 'whitespace-nowrap rounded-full border border-slate-700 px-3 py-0.5 text-[13px] text-slate-300';

export function PortfolioHeader(p: PortfolioHeaderProps) {
    const cash = p.risk?.portfolio.cash_usd;
    const vol = p.risk?.portfolio.volatility_ann;
    const share = cash != null && p.totalUsd ? (cash / p.totalUsd) * 100 : null;
    const tone = !p.gain ? '' : p.gain.amount >= 0 ? 'text-emerald-400' : 'text-red-400';
    return (
        <header className="flex items-start justify-between gap-6">
            <div>
                <h1 className="mb-1.5 text-xs font-bold uppercase tracking-widest text-slate-400">{`Portafolio · ${p.positions} posiciones`}</h1>
                <div className="flex flex-wrap items-baseline gap-4">
                    <span className="font-mono text-[40px] font-bold leading-[1.1] text-white">
                        {p.totalUsd == null ? '—' : esUsd(p.totalUsd, p.hidden, 2)}<small className="ml-1.5 text-base font-medium text-slate-400">USD</small>
                    </span>
                    {cash != null && (
                        <span className={chip}>Caja <b className="font-mono font-semibold text-slate-100">{esUsd(cash, p.hidden, 2)}</b>{` USD${share != null ? ` · ${esNum(share, 1)} %` : ''}`}</span>
                    )}
                    {vol != null && (
                        <span className={chip} title="Suma ponderada de volatilidades, sin correlaciones">
                            Volatilidad anual <b className="font-mono font-semibold text-slate-100">{`~${esPct(vol * 100)}`}</b>
                        </span>
                    )}
                </div>
                {(p.insight || p.gain) && (
                    <p className="mt-2.5 max-w-[760px] text-base leading-normal text-slate-200">
                        {p.insight}{p.insight && p.gain ? ' ' : ''}
                        {p.gain && (
                            <span className={`font-mono font-semibold ${tone}`}>
                                {p.hidden ? '••••' : `${p.gain.amount >= 0 ? '+' : ''}${esNum(p.gain.amount, 2)} USD`}
                                {` (${p.gain.amount >= 0 ? '+' : ''}${esNum(p.gain.pct, 2)} %)`}
                            </span>
                        )}
                        {p.gain && <span className="text-slate-300"> sobre tu costo.</span>}
                    </p>
                )}
                <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-slate-400">
                    <PriceSourceBadge priceSource={p.priceSource} lastRefreshedAt={p.refreshedAt} />
                    {p.risk && <span>{`Riesgo: 3 años de historia, ${p.risk.portfolio.holdings_with_history} de ${p.risk.portfolio.holdings_total}`}</span>}
                    {p.riskError && <span className="text-amber-300">{`Riesgo no disponible (${p.riskError})`}</span>}
                </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
                <button type="button" onClick={p.onRefresh} className="min-h-[44px] rounded px-3 text-[13px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200">↻ Actualizar precios</button>
                <details className="relative">
                    <summary className="flex min-h-[44px] cursor-pointer list-none items-center rounded px-3 text-[13px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200">Más ▾</summary>
                    <div className="absolute right-0 z-20 mt-1 flex w-52 flex-col rounded-lg border border-slate-700 bg-slate-900 p-1 shadow-xl">
                        <button type="button" onClick={p.onThesis} className="flex items-center gap-2 rounded px-3 py-2 text-left text-xs font-semibold text-slate-300 hover:bg-slate-800"><BookOpen size={13} />Investment Thesis</button>
                        <button type="button" onClick={p.onReview} className="flex items-center gap-2 rounded px-3 py-2 text-left text-xs font-semibold text-slate-300 hover:bg-slate-800"><FileBarChart2 size={13} />Latest Review</button>
                        <button type="button" onClick={p.onGuide} className="flex items-center gap-2 rounded px-3 py-2 text-left text-xs font-semibold text-slate-300 hover:bg-slate-800"><Terminal size={13} />Agent Guide</button>
                    </div>
                </details>
            </div>
        </header>
    );
}
