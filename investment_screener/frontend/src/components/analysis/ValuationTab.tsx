/**
 * ValuationTab.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Tab Valoración (S10): Valuation Methods (our projection, fair value from the page header source), Multiples and
 *     Profitability (company / Sector / Industria; benchmarks are null → "—") and four cards. Every null → "—".
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <ValuationTab stock={stock} fairValue={468.9} />
 */
import type { StockData } from '../../services/api';
import { fmtCapEs, fmtMoneyEs, fmtMultEs, fmtNumEs, fmtPctEs, fmtSignedPctEs } from '../../utils/analysisFormat';
import { DASH, Note, TABLE_WRAP, TD_NUM, TH } from './tabUi';

const n2 = (v: number | null | undefined) => (v == null ? DASH : fmtNumEs(v, 2));

export function ValuationTab({ stock, fairValue }: { stock: StockData; fairValue: number | null }) {
    const o = stock.overview;
    const cur = o?.profile?.currency || stock.currency || 'USD';
    const company = o?.profile?.name || stock.symbol;
    const upside = fairValue != null && stock.price > 0 ? ((fairValue - stock.price) / stock.price) * 100 : null;
    const bench = o?.benchmarks ?? null;
    // Sector / industry benchmarks are null in the payload today; the lookup keeps the columns ready for when they arrive.
    const at = (group: Record<string, number | null> | null | undefined, key: string) => group?.[key];

    const comparison = (caption: string, first: string, rows: Array<[string, number | null | undefined, string]>, f: (x: number | null | undefined) => string) => (
        <div className={TABLE_WRAP}>
            <table className="w-full text-sm">
                <caption className="text-left text-xs text-slate-400 px-4 py-2">{caption}</caption>
                <thead className="bg-slate-800 text-slate-400">
                    <tr><th scope="col" className={TH}>{first}</th>{[company, 'Sector', 'Industria'].map((h) => <th key={h} scope="col" className={`${TH} text-right`}>{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-slate-700">
                    {rows.map(([label, v, key]) => (
                        <tr key={label}>
                            <th scope="row" className="px-4 py-2 text-left font-normal text-slate-300">{label}</th>
                            <td className={TD_NUM}>{f(v)}</td>
                            <td className={TD_NUM}>{f(at(bench?.sector, key))}</td>
                            <td className={TD_NUM}>{f(at(bench?.industry, key))}</td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
    const m = o?.multiples, p = o?.profitability, c = o?.cost_of_capital, g = o?.growth, w = o?.ownership, b = o?.balance;
    const card = (title: string, rows: Array<[string, string]>) => (
        <section aria-label={title} className="rounded-lg border border-slate-700 p-4">
            <h4 className="text-sm font-semibold text-slate-100 mb-2">{title}</h4>
            <dl className="text-sm">
                {rows.map(([k, v]) => <div key={k} className="flex justify-between py-1 border-b border-slate-800"><dt className="text-slate-400">{k}</dt><dd className="font-mono text-slate-200">{v}</dd></div>)}
            </dl>
        </section>
    );
    const cap = (v: number | null | undefined) => (v == null ? DASH : fmtCapEs(v, cur));
    return (
        <div className="space-y-4">
            <Note>* Valores referenciales.</Note>
            <div className="grid xl:grid-cols-3 gap-4">
                <div className={TABLE_WRAP}>
                    <table className="w-full text-sm">
                        <caption className="text-left text-xs text-slate-400 px-4 py-2">Métodos de valoración</caption>
                        <thead className="bg-slate-800 text-slate-400">
                            <tr><th scope="col" className={TH}>Método</th><th scope="col" className={`${TH} text-right`}>Valor</th><th scope="col" className={`${TH} text-right`}>Potencial</th><th scope="col" className={TH}>Tipo</th></tr>
                        </thead>
                        <tbody>
                            <tr>
                                <th scope="row" className="px-4 py-2 text-left font-normal text-slate-300">Proyección propia</th>
                                <td className={TD_NUM}>{fairValue != null ? fmtMoneyEs(fairValue, cur) : DASH}</td>
                                <td className={`${TD_NUM} ${upside == null ? '' : upside >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{fmtSignedPctEs(upside)}</td>
                                <td className="px-4 py-2 text-slate-300">Escenarios DCF</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
                {comparison('Múltiplos de valoración', 'Múltiplo', [['PER', m?.pe, 'pe'], ['P/VC', m?.pb, 'pb'], ['EV/EBITDA', m?.ev_ebitda, 'ev_ebitda'], ['EV/EBIT', m?.ev_ebit, 'ev_ebit'], ['EV/Ventas', m?.ev_sales, 'ev_sales'], ['EV/FCF', m?.ev_fcf, 'ev_fcf']], fmtMultEs)}
                {comparison('Rentabilidad y retornos', 'Métrica', [['ROE', p?.roe, 'roe'], ['ROIC', p?.roic, 'roic'], ['RONA', p?.rona, 'rona'], ['Margen bruto', p?.gross_margin, 'gross_margin'], ['Margen EBITDA', p?.ebitda_margin, 'ebitda_margin'], ['Margen EBIT', p?.ebit_margin, 'ebit_margin'], ['Margen neto', p?.net_margin, 'net_margin'], ['Margen FCF', p?.fcf_margin, 'fcf_margin']], fmtPctEs)}
            </div>
            <div className="grid md:grid-cols-2 xl:grid-cols-4 gap-4">
                {card('Riesgo y coste de capital', [['Beta', n2(c?.beta)], ['Beta apalancada', n2(c?.levered_beta)], ['Coste del capital propio', fmtPctEs(c?.cost_of_equity)], ['Coste de la deuda', fmtPctEs(c?.cost_of_debt)], ['WACC', fmtPctEs(c?.wacc)], ['Tasa de descuento', fmtPctEs(c?.discount_rate)]])}
                {card('Crecimiento', [['Ingresos (histórico)', fmtPctEs(g?.revenue_hist)], ['EBIT (histórico)', fmtPctEs(g?.ebit_hist)], ['Beneficio neto (histórico)', fmtPctEs(g?.net_income_hist)], ['Terminal', fmtPctEs(g?.terminal)]])}
                {card('Accionariado', [['Insiders', fmtPctEs(w?.insiders_pct)], ['Institucional', fmtPctEs(w?.institutions_pct)], ['Público', fmtPctEs(w?.public_pct)]])}
                {card('Deuda y apalancamiento', [['Deuda total', cap(b?.total_debt)], ['Deuda neta', cap(b?.net_debt)], ['Deuda neta por acción', b?.net_debt_per_share == null ? DASH : fmtMoneyEs(b.net_debt_per_share, cur)], ['Patrimonio', cap(b?.total_equity)], ['Deuda / patrimonio', b?.debt_to_equity == null ? DASH : `${n2(b.debt_to_equity)}x`]])}
            </div>
        </div>
    );
}
