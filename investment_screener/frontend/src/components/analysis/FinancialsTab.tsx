/**
 * FinancialsTab.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose: Tab Financieros (S9): latest quarter income lines and the balance sheet (total assets, equity, long-term debt, cash); null → "—".
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <FinancialsTab stock={stock} />
 */
import type { StockData } from '../../services/api';
import { fmtCapEs, fmtPctEs } from '../../utils/analysisFormat';
import { DASH, TABLE_WRAP, TD_NUM, TH } from './tabUi';

export function FinancialsTab({ stock }: { stock: StockData }) {
    const inc = stock.overview?.income_quarter ?? null;
    const bal = stock.overview?.balance ?? null;
    const cur = stock.overview?.profile?.currency || stock.currency || 'USD';
    const money = (v: number | null | undefined) => (v == null ? DASH : fmtCapEs(v, cur));
    const margin = inc?.net_income != null && inc.revenue ? ` (margen ${fmtPctEs((inc.net_income / inc.revenue) * 100)})` : '';
    const incomeRows: Array<[string, string]> = [
        ['Ingresos', money(inc?.revenue)], ['Coste de ventas', money(inc?.cost_of_revenue)], ['Beneficio bruto', money(inc?.gross_profit)],
        ['I+D', money(inc?.research_development)], ['Ventas y administración', money(inc?.sga)], ['Resultado operativo', money(inc?.operating_income)],
        ['Impuestos', money(inc?.tax)], ['Beneficio neto', `${money(inc?.net_income)}${margin}`],
    ];
    const balanceRows: Array<[string, string]> = [
        ['Activos totales', money(bal?.total_assets)], ['Patrimonio', money(bal?.total_equity)],
        ['Deuda a largo plazo', money(bal?.long_term_debt)], ['Caja e inversiones a corto plazo', money(bal?.cash_and_short_term)],
    ];
    const table = (caption: string, rows: Array<[string, string]>) => (
        <div className={TABLE_WRAP}>
            <table aria-label={caption} className="w-full text-sm">
                <caption className="text-left text-xs text-slate-400 px-4 py-2">{caption}</caption>
                <thead className="bg-slate-800 text-slate-400"><tr><th scope="col" className={TH}>Concepto</th><th scope="col" className={`${TH} text-right`}>{cur}</th></tr></thead>
                <tbody className="divide-y divide-slate-700">
                    {rows.map(([k, v]) => <tr key={k}><th scope="row" className="px-4 py-2 text-left font-normal text-slate-300">{k}</th><td className={TD_NUM}>{v}</td></tr>)}
                </tbody>
            </table>
        </div>
    );
    return (
        <div className="grid md:grid-cols-2 gap-4">
            {table(inc ? `Resultados ${inc.period}` : 'Resultados', incomeRows)}
            {table('Balance', balanceRows)}
        </div>
    );
}
