/**
 * FilingsTab.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Tab Filings (S12): toggle between earnings calls (honest empty state with the endpoint's reason: no free source)
 *     and SEC filings from EDGAR grouped by fiscal year (desc), each with form pill, title, date and an "Abrir" link.
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <FilingsTab ticker="MSFT" load={load} />
 */
import { useState } from 'react';
import { fetchFilings, type Filings, type SecFiling } from '../../services/api';
import { Empty, Loading, Note, Pill, Seg } from './tabUi';
import { useResource, type Loader } from './useResource';

type View = 'calls' | 'sec';

export function FilingsTab({ ticker, load }: { ticker: string; load: Loader }) {
    const { loading, data } = useResource<Filings>(load, `filings:${ticker}`, () => fetchFilings(ticker));
    const [view, setView] = useState<View>('calls');
    if (loading) return <Loading>Cargando informes…</Loading>;
    if (!data) return <Empty>No se pudieron cargar los informes.</Empty>;
    const items = data.sec_filings.items;
    const years = [...new Set(items.map((f) => f.fiscal_year))].sort((a, b) => (b ?? -1) - (a ?? -1));
    const inYear = (y: number | null) => items.filter((f) => f.fiscal_year === y);
    const row = (f: SecFiling) => (
        <li key={f.url} className="flex items-center gap-3 py-2 border-b border-slate-800">
            <Pill>{f.form}</Pill>
            <div className="flex-1"><b className="block text-sm text-slate-200">{f.title}</b><small className="text-slate-400">{f.filed}</small></div>
            <a href={f.url} target="_blank" rel="noopener noreferrer" aria-label={`Abrir ${f.form} del ${f.filed}`} className="rounded bg-slate-700 px-3 py-1 text-sm text-slate-200 hover:bg-slate-600">Abrir</a>
        </li>
    );
    return (
        <div>
            <div className="mb-3"><Seg<View> label="Tipo de documento" value={view} onChange={setView}
                options={[{ value: 'calls', text: 'Llamadas de resultados' }, { value: 'sec', text: `Informes a la SEC (${data.sec_filings.total})` }]} /></div>
            {view === 'calls' ? (
                <Empty>{data.earnings_calls.reason}</Empty>
            ) : !data.cik || items.length === 0 ? (
                <Empty>Sin informes en EDGAR para este valor.</Empty>
            ) : (
                <>
                    {years.map((y) => (
                        <section key={String(y)} aria-label={y == null ? 'Sin año fiscal' : `Año fiscal ${y}`} className="mb-4">
                            <h4 className="text-sm font-semibold text-slate-100">
                                {y == null ? 'Sin año fiscal' : `Año fiscal ${y}`} <span className="text-xs font-normal text-slate-400">{inYear(y).length} {inYear(y).length > 1 ? 'informes' : 'informe'}</span>
                            </h4>
                            <ul>{inYear(y).map(row)}</ul>
                        </section>
                    ))}
                    <Note>Mostrando {items.length} de {data.sec_filings.total}.</Note>
                </>
            )}
        </div>
    );
}
