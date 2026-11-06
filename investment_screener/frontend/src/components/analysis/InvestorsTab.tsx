/**
 * InvestorsTab.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Tab Inversores (S11): 13F superinvestors. Stats (holders / buying / selling from the endpoint, institutional % from
 *     overview.ownership), aria-pressed filter, movement table (symbol + text, never color alone), delay note. Fetched when the tab opens (cold up to ~50 s).
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <InvestorsTab stock={stock} ticker="MSFT" load={load} />
 */
import { useState } from 'react';
import { fetchSuperinvestors, type StockData, type SuperinvestorHolding, type Superinvestors } from '../../services/api';
import { fmtGroupedEs, fmtNumEs, fmtPctEs } from '../../utils/analysisFormat';
import { Empty, Loading, Note, Pill, SectionTitle, Seg } from './tabUi';
import { useResource, type Loader } from './useResource';

type Filter = 'all' | 'buy' | 'sell' | 'hold';
const GROUP: Record<SuperinvestorHolding['action'], Exclude<Filter, 'all'>> = { add: 'buy', new: 'buy', reduce: 'sell', sold_out: 'sell', hold: 'hold' };
const TONE = { add: 'text-emerald-400', new: 'text-emerald-400', reduce: 'text-amber-400', sold_out: 'text-red-400', hold: 'text-slate-300' };

function movementLabel(h: Pick<SuperinvestorHolding, 'action' | 'change_pct'>): string {
    const pct = h.change_pct == null ? '' : ` ${Math.abs(h.change_pct) > 1000 ? '>1000%' : `${fmtNumEs(Math.abs(h.change_pct), 1)}%`}`;
    switch (h.action) {
        case 'add': return `▲ Aumenta${pct}`;
        case 'new': return '★ Compra nueva';
        case 'reduce': return `▼ Reduce${pct}`;
        case 'sold_out': return '✕ Vende todo';
        default: return '● Mantiene';
    }
}

export function InvestorsTab({ stock, ticker, load }: { stock: StockData; ticker: string; load: Loader }) {
    const { loading, data } = useResource<Superinvestors>(load, `super:${ticker}`, () => fetchSuperinvestors(ticker));
    const [filter, setFilter] = useState<Filter>('all');
    if (loading) return <Loading>Cargando superinversores… la primera consulta puede tardar hasta 50 s.</Loading>;
    if (!data) return <Empty>No se pudieron cargar los superinversores.</Empty>;
    if (!data.cusip) return <Empty>Sin datos 13F para este valor.</Empty>;
    const items = data.items.filter((h) => filter === 'all' || GROUP[h.action] === filter);
    const inst = stock.overview?.ownership?.institutions_pct;
    const stat = (value: string, label: string, tone = '') => <div><b className={`block text-2xl font-mono ${tone}`}>{value}</b><span className="text-xs text-slate-400">{label}</span></div>;
    return (
        <div>
            <SectionTitle>Superinversores</SectionTitle>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {stat(String(data.holders), 'gestores con la acción')}
                {stat(String(data.buying), '▲ comprando o aumentando', 'text-emerald-400')}
                {stat(String(data.selling), '▼ reduciendo o vendiendo', 'text-red-400')}
                {stat(fmtPctEs(inst), 'en manos institucionales')}
            </div>
            <div className="my-3"><Seg<Filter> label="Filtrar movimientos" value={filter} onChange={setFilter}
                options={[{ value: 'all', text: 'Todos' }, { value: 'buy', text: 'Comprando' }, { value: 'sell', text: 'Vendiendo' }, { value: 'hold', text: 'Mantienen' }]} /></div>
            <div className="max-h-[360px] overflow-auto rounded-lg border border-slate-700">
                <table className="w-full text-sm">
                    <thead className="sticky top-0 bg-slate-800 text-slate-400 text-left">
                        <tr>
                            <th scope="col" className="px-4 py-2">Gestor</th><th scope="col" className="px-4 py-2">Fondo</th>
                            <th scope="col" className="px-4 py-2 text-right">% de su cartera</th><th scope="col" className="px-4 py-2 text-right">Acciones</th>
                            <th scope="col" className="px-4 py-2">Trimestre</th><th scope="col" className="px-4 py-2">Movimiento</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                        {items.map((h) => (
                            <tr key={`${h.cik}-${h.fund}-${h.manager}`} className="hover:bg-slate-800/40">
                                <th scope="row" className="px-4 py-2 text-left font-medium text-slate-200">{h.manager}</th>
                                <td className="px-4 py-2 text-slate-300">{h.fund || '—'}</td>
                                <td className="px-4 py-2 text-right font-mono">{fmtPctEs(h.portfolio_pct, 2)}</td>
                                <td className="px-4 py-2 text-right font-mono">{fmtGroupedEs(h.shares)}</td>
                                <td className="px-4 py-2 text-slate-300">{h.quarter}</td>
                                <td className="px-4 py-2"><Pill tone={TONE[h.action]}>{movementLabel(h)}</Pill></td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            <Note>Mostrando {items.length} de {data.items.length} gestores. "% de su cartera" indica cuánto pesa la acción en el fondo.</Note>
            <Note>{data.delay_note}</Note>
            {data.errors.length > 0 && <Note>No se pudo leer a {data.errors.length} gestor(es); la lista puede estar incompleta.</Note>}
        </div>
    );
}
