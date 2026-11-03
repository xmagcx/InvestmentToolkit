/**
 * RiskPanel.tsx - The right panel of the Portafolio page: the selected ticker, Riesgo and Valoración tabs.
 *
 * Purpose:
 *     Riesgo (first tab) shows three figures, each with its value, an Alto/Medio/Bajo chip and the basis
 *     in plain Spanish, a footnote stating the criterion (the owner's other holdings with history, not the
 *     market) and a collapsible with Sortino, downside beta, the other big drawdowns and the naive-volatility
 *     caveat. Valoración (second tab) is a calm empty state with an "Analizar X" button until a saved
 *     recommendation carries a fair value; then it shows the bear-base-bull range, fair value, upside and
 *     reward:risk through the shared RiskRewardCell / riskReward helpers (no new maths). The trade buttons,
 *     the broker-journal "Log" button and the link into Stock Analysis live in the panel header.
 *
 * Layer: Frontend / Components / Portfolio
 *
 * Usage Examples:
 *     <RiskPanel row={row} riskRow={r} risk={risk} rec={rec} hidden={isPrivacyMode} onAnalyze={go} actions={<TradeButtons ... />} />
 *
 * Key Functions (Index):
 *     - RiskPanel(): header, tabs
 *     - RiskTab(), ValuationTab(): the two tab bodies
 *
 * Key Input Dependencies:
 *     - portfolioMath.ts (riskCards, gain), RiskRewardCell, utils/riskReward (fairValueGap, formatSignedPct), services/api types
 *
 * Key Output Dependencies:
 *     - pages/PortfolioPage.tsx
 */
import { useState, type ReactNode } from 'react';
import type { PortfolioRisk, RecommendationRecord, RiskRow } from '../../services/api';
import { fairValueGap, formatSignedPct } from '../../utils/riskReward';
import { fmtPrice } from '../../utils/formatters';
import { RiskRewardCell } from '../RiskRewardCell';
import type { TableRow } from '../positions/columns';
import { esNum, esNumMax, esPct, esUsd, holdingGain, nameLine, riskCards, type Level } from './portfolioMath';

const CHIP: Record<Level, string> = {
    Alto: 'bg-red-400/15 text-red-400',
    Medio: 'bg-slate-400/15 text-slate-300',
    Bajo: 'bg-slate-400/15 text-slate-300',
};

function RiskTab({ riskRow, risk, ticker }: { riskRow?: RiskRow; risk: PortfolioRisk | null; ticker: string }) {
    if (!riskRow || !risk) {
        return <p className="m-0 text-base leading-relaxed text-slate-100">{`Aún no hay datos de riesgo para ${ticker}: solo se calculan para tenencias.`}</p>;
    }
    const cards = riskCards(riskRow, risk.medians);
    const others = risk.rows.filter(r => r.ticker !== ticker && r.max_drawdown_3y != null)
        .sort((a, b) => a.max_drawdown_3y! - b.max_drawdown_3y!).slice(0, 3);
    const peers = Math.max(0, risk.portfolio.holdings_with_history - (riskRow.estimated ? 0 : 1));
    const p = risk.portfolio;
    return (
        <div>
            <dl className="m-0 flex flex-col">
                {cards.map(c => (
                    <div key={c.title} className="grid grid-cols-[1fr_auto] items-baseline gap-3 border-b border-slate-800 py-2.5">
                        <dd className="m-0 text-[13px] text-slate-300">
                            <b className="block text-sm font-semibold text-slate-100">{c.title}</b>
                            <span className="text-xs text-slate-400">
                                {c.level && <span className={`mr-1.5 inline-block rounded px-1.5 py-px text-[11px] font-bold uppercase ${CHIP[c.level]}`}>{c.level}</span>}
                                {c.basis}
                            </span>
                        </dd>
                        <dt className="text-right font-mono text-xl font-bold text-white">{c.value}</dt>
                    </div>
                ))}
            </dl>
            <p className="mt-2.5 text-[11px] leading-snug text-slate-400">
                {`Alto, medio o bajo se mide contra tus otras ${peers} posiciones con historia, no contra el mercado.`}
            </p>
            <details className="border-t border-slate-800 pt-1">
                <summary className="flex min-h-[44px] cursor-pointer items-center text-[13px] font-semibold text-slate-400 hover:text-slate-200">Ver más riesgo de la cartera</summary>
                <ul className="mb-3 list-disc pl-5 text-[13px] leading-7 text-slate-300">
                    {riskRow.sortino_3y != null && riskRow.downside_beta_3y != null && (
                        <li>{`Sortino ${esNum(riskRow.sortino_3y, 2)} y beta bajista ${esNum(riskRow.downside_beta_3y, 2)}`}</li>
                    )}
                    {others.length > 0 && <li>{`Peores caídas de otras grandes: ${others.map(o => `${o.ticker} ${esPct(o.max_drawdown_3y! * 100)}`).join(', ')}`}</li>}
                    <li>{`"Cuánto riesgo aporta" es un ranking que suma 100 % entre tus posiciones (peso × volatilidad), no dinero.`}</li>
                    {riskRow.estimated && <li>{`${ticker}: sin historia suficiente, riesgo estimado`}</li>}
                    {p.volatility_ann != null && <li>{`Volatilidad de la cartera ~${esPct(p.volatility_ann * 100)} sin correlaciones; con correlaciones será menor`}</li>}
                </ul>
                <p className="mb-2 text-xs text-slate-400">{`Datos reales de 3 años de precios (${p.holdings_with_history} de ${p.holdings_total} posiciones).`}</p>
            </details>
        </div>
    );
}

function ValuationTab({ row, rec, hidden, onAnalyze }: {
    row: TableRow; rec?: RecommendationRecord | null; hidden: boolean; onAnalyze: () => void;
}) {
    if (rec?.fair_value == null) {
        return (
            <div className="flex flex-col gap-4">
                <p className="m-0 text-base leading-relaxed text-slate-100">{`Aún no sabemos si ${row.ticker} está cara o barata: nunca se ha analizado.`}</p>
                <button type="button" onClick={onAnalyze}
                    className="min-h-[44px] self-start rounded bg-slate-200 px-5 text-sm font-bold text-slate-950 hover:bg-white">{`Analizar ${row.ticker}`}</button>
            </div>
        );
    }
    const price = row.livePrice ?? row.currentPrice ?? rec.price;
    const { upside } = fairValueGap(rec.fair_value, price);
    return (
        <div className="flex flex-col gap-3">
            <RiskRewardCell columnId="rr_range" rec={rec} hideValues={hidden} />
            <dl className="m-0 grid grid-cols-3 gap-2 text-xs text-slate-400">
                <div><dt>Valor justo</dt><dd className="m-0 font-mono text-sm text-slate-100">{hidden ? '$••••' : `$${fmtPrice(rec.fair_value)}`}</dd></div>
                <div><dt>Potencial</dt><dd className="m-0 font-mono text-sm text-slate-100">{formatSignedPct(upside)}</dd></div>
                <div><dt>Recompensa:riesgo</dt><dd className="m-0 text-sm"><RiskRewardCell columnId="rr_ratio" rec={rec} /></dd></div>
            </dl>
            <button type="button" onClick={onAnalyze}
                className="self-start rounded px-3 py-2 text-[13px] font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200">{`Volver a analizar ${row.ticker}`}</button>
        </div>
    );
}

interface RiskPanelProps {
    row: TableRow;
    riskRow?: RiskRow;
    risk: PortfolioRisk | null;
    rec?: RecommendationRecord | null;
    hidden: boolean;
    onAnalyze: () => void;
    /** Trade buttons, journal log: whatever the page still offers per ticker. */
    actions?: ReactNode;
}

export function RiskPanel({ row, riskRow, risk, rec, hidden, onAnalyze, actions }: RiskPanelProps) {
    const [tab, setTab] = useState<'riesgo' | 'valoracion'>('riesgo');
    const price = row.livePrice ?? row.currentPrice;
    const gain = holdingGain(row);
    const tone = !gain ? '' : gain.amount > 0 ? 'text-emerald-400' : gain.amount < 0 ? 'text-red-400' : 'text-slate-400';
    return (
        <aside aria-label={`Detalle de ${row.ticker}`} className="flex flex-col gap-5 pt-1.5">
            <div>
                <div className="flex items-baseline justify-between">
                    <h2 className="m-0 font-mono text-2xl font-bold text-white">{row.ticker}</h2>
                    <span className="font-mono text-xl font-bold text-white">{price == null ? '—' : esNum(price, 2)}</span>
                </div>
                <p className="mt-1 text-xs leading-normal text-slate-400">
                    {[nameLine(row), row.held ? `${esNumMax(row.shares, 4)} acc.` : '', row.averageCost != null && row.held ? `costo prom. ${esUsd(row.averageCost, hidden, 2)}` : ''].filter(Boolean).join(' · ')}
                    {gain && <> · Ganancia <span className={tone}>{hidden ? '••••' : `${gain.amount > 0 ? '+' : ''}${esNum(gain.amount, 2)}`} ({`${gain.amount > 0 ? '+' : ''}${esNum(gain.pct, 1)} %`})</span></>}
                </p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                    {actions}
                    <button type="button" onClick={onAnalyze} className="rounded px-2 py-1 text-xs font-semibold text-slate-400 hover:bg-slate-800 hover:text-slate-200">Abrir análisis completo →</button>
                </div>
            </div>
            <div role="tablist" aria-label="Secciones" className="flex gap-5 border-b border-slate-700">
                {([['riesgo', 'Riesgo'], ['valoracion', 'Valoración']] as const).map(([id, label]) => (
                    <button key={id} role="tab" id={`tab-${id}`} aria-controls={`panel-${id}`} aria-selected={tab === id} type="button"
                        onClick={() => setTab(id)}
                        className={`-mb-px min-h-[44px] border-b-2 px-0.5 text-sm font-semibold ${tab === id ? 'border-slate-200 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`}>{label}</button>
                ))}
            </div>
            <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
                {tab === 'riesgo'
                    ? <RiskTab riskRow={riskRow} risk={risk} ticker={row.ticker} />
                    : <ValuationTab row={row} rec={rec} hidden={hidden} onAnalyze={onAnalyze} />}
            </div>
        </aside>
    );
}
