/**
 * HeaderCard.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Nivel 1 · Escanear (S3, S16): identity from overview.profile, price with date, fair value from our projection
 *     (never a placeholder), one interpretation sentence and the metric list (value + state word + "?").
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <HeaderCard stock={stock} fairValue={468.9} priceDate="2026-01-01" />
 */
import type { StockData } from '../../services/api';
import { fmtCapEs, fmtMoneyEs, fmtPctEs } from '../../utils/analysisFormat';
import { metricState, type MetricStateName } from '../../utils/metricState';
import { buildMetrics } from './headerMetrics';
import { HelpTip } from './HelpTip';

const STATE_TEXT: Record<MetricStateName, string> = {
    strong: 'text-emerald-400',
    weak: 'text-red-400',
    neutral: 'text-slate-400',
};

interface Props { stock: StockData; fairValue: number | null; priceDate: string | null }

export function HeaderCard({ stock, fairValue, priceDate }: Props) {
    const profile = stock.overview?.profile ?? null;
    const company = profile?.name || stock.symbol;
    const currency = profile?.currency || stock.currency || 'USD';
    const sector = profile?.sector || stock.profile?.sector || null;
    const industry = profile?.industry || stock.profile?.industry || null;
    const upside = fairValue && stock.price > 0 ? ((fairValue - stock.price) / stock.price) * 100 : null;
    const rate = stock.overview?.cost_of_capital?.discount_rate ?? stock.overview?.cost_of_capital?.wacc ?? null;
    const metrics = buildMetrics(stock, fairValue);
    const ctx = { company, value: null, price: stock.price, fairValue, upside, currency };

    let reading = 'Sin valoración guardada: no se puede comparar el precio con un valor justo.';
    if (fairValue && stock.price > 0) {
        const diff = (stock.price / fairValue - 1) * 100;
        reading = Math.abs(diff) < 1
            ? `El precio está en línea con el valor justo de ${fmtMoneyEs(fairValue, currency)}.`
            : `El precio cotiza ${fmtPctEs(Math.abs(diff))} ${diff > 0 ? 'por encima' : 'por debajo'} del valor justo de ${fmtMoneyEs(fairValue, currency)}.`;
        if (rate != null) reading += ` Tasa de descuento del modelo: ${fmtPctEs(rate)}.`;
    }

    return (
        <section aria-label="Nivel 1 · Escanear" className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3">Nivel 1 · Escanear</p>
            <div className="flex flex-wrap justify-between gap-6">
                <div>
                    <h2 className="text-2xl font-bold text-white">{company}</h2>
                    <span className="font-mono text-sm text-primary">{stock.symbol}</span>
                    <p className="text-sm text-slate-300 mt-1">{[sector, industry].filter(Boolean).join(' · ')}</p>
                    <p className="text-sm text-slate-400">
                        {[profile?.country, currency, profile?.market_cap != null ? fmtCapEs(profile.market_cap, currency) : null].filter(Boolean).join(' · ')}
                    </p>
                </div>
                <div className="flex gap-8">
                    <div>
                        <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Precio</p>
                        <p className="text-3xl font-bold text-white font-mono">{fmtMoneyEs(stock.price, currency)}</p>
                        {priceDate && <p data-testid="price-date" className="text-xs text-slate-400">al {priceDate}</p>}
                    </div>
                    <div>
                        <p className="text-xs font-bold uppercase tracking-widest text-slate-400">Valor justo<HelpTip term="valuation" ctx={ctx} /></p>
                        {fairValue ? (
                            <p data-testid="fair-value" className="text-3xl font-bold text-white font-mono">{fmtMoneyEs(fairValue, currency)}</p>
                        ) : (
                            <p data-testid="fair-value" className="text-sm text-slate-400 mt-2">Sin valoración guardada</p>
                        )}
                    </div>
                </div>
            </div>
            <p className="text-sm text-slate-200 mt-4">{reading}</p>
            <ul className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-x-8 gap-y-1">
                {metrics.map((m) => {
                    const st = metricState(m.key, m.value);
                    return (
                        <li key={m.key} data-testid={`metric-${m.key}`} className="flex items-center justify-between py-1.5 border-b border-slate-800 text-sm">
                            <span className="text-slate-300">{m.label}<HelpTip term={m.key} ctx={{ ...ctx, value: m.value }} /></span>
                            <span className="flex items-center gap-3">
                                <b className="font-mono text-slate-100">{m.display}</b>
                                <span className={`w-20 text-xs font-semibold ${STATE_TEXT[st.state]}`}>{st.symbol} {st.word}</span>
                            </span>
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
