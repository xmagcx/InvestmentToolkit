/**
 * DescriptionTab.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose: Tab Descripción (S8): revenue-to-profit Sankey with its one-line reading, plus the organization (description and facts table; null rows are omitted).
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <DescriptionTab stock={stock} />
 */
import type { StockData } from '../../services/api';
import { fmtCapEs, fmtGroupedEs, sankeyReading } from '../../utils/analysisFormat';
import { SankeyChart } from './SankeyChart';
import { Note } from './tabUi';

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

export function DescriptionTab({ stock }: { stock: StockData }) {
    const o = stock.overview;
    const p = o?.profile ?? null;
    const company = p?.name || stock.symbol;
    const income = o?.income_quarter ?? null;
    const reading = sankeyReading(company, income);
    const currency = p?.currency || stock.currency || 'USD';
    const month = p?.fiscal_year_end != null ? MONTHS[p.fiscal_year_end - 1] : null;
    const web = p?.website ?? null;
    const rows: Array<[string, React.ReactNode]> = [
        ['Sector · industria', [p?.sector, p?.industry].filter(Boolean).join(' · ') || null],
        ['Sede', p ? [p.hq?.city, p.hq?.state, p.hq?.country].filter(Boolean).join(', ') || null : null],
        ['Empleados', p?.employees != null ? fmtGroupedEs(p.employees) : null],
        ['Presidente y CEO', p?.ceo ?? null],
        ['Director financiero', p?.cfo ?? null],
        ['Cierre del año fiscal', month ? month[0].toUpperCase() + month.slice(1) : null],
        ['Capitalización', p?.market_cap != null ? fmtCapEs(p.market_cap, currency) : null],
        ['ISIN', p?.isin ?? null],
        ['Web', web ? <a href={web} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{web.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}</a> : null],
    ];
    return (
        <div className="space-y-6">
            <section aria-labelledby="h-sk">
                <h3 id="h-sk" className="text-lg font-semibold text-slate-100">¿De dónde vienen los ingresos y a dónde van?</h3>
                {income?.revenue != null && income.revenue > 0 ? (
                    <>
                        <p className="text-xs text-slate-400 mb-2">
                            Trimestre {income.period} · <span className="text-emerald-400">■ beneficio</span> <span className="text-red-400">■ gasto</span> <span className="text-slate-400">■ ingreso</span>
                        </p>
                        <SankeyChart income={income} />
                        {reading && <p className="text-sm text-slate-200 mt-2">{reading}</p>}
                        <Note>Sin desglose por segmento: los ingresos se muestran como una sola fuente.</Note>
                    </>
                ) : (
                    <p className="text-slate-400 text-sm mt-2">Sin resultados trimestrales para dibujar el flujo de ingresos.</p>
                )}
            </section>
            <div className="grid md:grid-cols-2 gap-6">
                <section aria-labelledby="h-org">
                    <h3 id="h-org" className="text-lg font-semibold text-slate-100 mb-2">La organización</h3>
                    <p className="text-sm text-slate-300">{p?.description || 'Sin descripción disponible.'}</p>
                </section>
                <table aria-label="Datos generales de la organización" className="text-sm self-start">
                    <tbody>
                        {rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => (
                            <tr key={k} className="border-b border-slate-800">
                                <th scope="row" className="text-left font-medium text-slate-400 pr-4 py-1.5">{k}</th>
                                <td className="text-slate-200 py-1.5">{v}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
