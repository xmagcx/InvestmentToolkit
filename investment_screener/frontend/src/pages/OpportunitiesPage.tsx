/**
 * OpportunitiesPage.tsx (React Page)
 * =====================================
 *
 * Purpose:
 *     "Oportunidades": the guided screener over the Racional universe. Six plain-Spanish
 *     questions filter (when "exigidas") or score (stars) the universe; the table explains every
 *     survivor — how much it fell, what Graham says it is worth, whether it is a good business,
 *     whether it stopped falling, what analysts say and who is buying it.
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <Route path="opportunities" element={<OpportunitiesPage />} />
 *
 * Key Input Dependencies:
 *     - services/opportunities.ts (GET /api/opportunities, contract S8)
 *     - components/opportunities/* (stepper, table, detail)
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import StepperCard from '../components/opportunities/StepperCard';
import OpportunitiesTable from '../components/opportunities/OpportunitiesTable';
import { int } from '../components/opportunities/format';
import {
    DEFAULT_OPPORTUNITIES_PARAMS,
    ScreenDataMissingError,
    fetchOpportunities,
    type OpportunitiesParams,
    type OpportunitiesResponse,
} from '../services/opportunities';

type NumericKey = Exclude<keyof OpportunitiesParams, 'require' | 'etf'>;

const DEBOUNCE_MS = 300;

export default function OpportunitiesPage() {
    const [params, setParams] = useState<OpportunitiesParams>(DEFAULT_OPPORTUNITIES_PARAMS);
    const [data, setData] = useState<OpportunitiesResponse | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<{ missing: boolean; message: string } | null>(null);

    // Every change refetches, debounced; the previous rows stay on screen meanwhile.
    useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(() => {
            setLoading(true);
            fetchOpportunities(params)
                .then(response => {
                    if (cancelled) return;
                    setData(response);
                    setError(null);
                })
                .catch((err: Error) => {
                    if (cancelled) return;
                    setError({ missing: err instanceof ScreenDataMissingError, message: err.message });
                })
                .finally(() => {
                    if (!cancelled) setLoading(false);
                });
        }, DEBOUNCE_MS);
        return () => {
            cancelled = true;
            clearTimeout(timer);
        };
    }, [params]);

    const toggleRequire = (n: number) =>
        setParams(prev => ({
            ...prev,
            require: prev.require.includes(n)
                ? prev.require.filter(x => x !== n)
                : [...prev.require, n].sort((a, b) => a - b),
        }));

    const setThreshold = (key: NumericKey, value: number) => setParams(prev => ({ ...prev, [key]: value }));

    const asOf = data ? new Date(data.asOf).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : null;

    return (
        <div className="flex h-full flex-col gap-3 p-4">
            <div>
                <h1 className="text-xl font-bold text-white">Oportunidades</h1>
                <p className="text-sm text-slate-400">
                    {data ? `Universo Racional, ${int(data.universe)} acciones` : 'Universo Racional'}
                </p>
            </div>

            {error?.missing ? (
                <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 text-sm text-slate-300 shadow-lg">
                    <p className="mb-2 text-slate-200">Todavía no hay datos del screener.</p>
                    <p>
                        Ejecuta la sincronización «TradingView – métricas del screener» en{' '}
                        <Link to="/sources" className="text-primary underline">Fuentes</Link> y vuelve a esta página: ahí
                        se descargan los precios, ratios y señales de todo el universo Racional.
                    </p>
                </section>
            ) : (
                <>
                    <StepperCard
                        steps={data?.steps ?? []}
                        resultCount={data?.resultCount ?? 0}
                        params={params}
                        onToggleRequire={toggleRequire}
                        onThreshold={setThreshold}
                        onEtf={on => setParams(prev => ({ ...prev, etf: on }))}
                    />

                    {error && !error.missing && (
                        <p className="rounded border border-red-800 bg-red-900/40 px-4 py-2 text-sm text-red-300">{error.message}</p>
                    )}

                    <div
                        role="note"
                        aria-label="Cómo leer los resultados"
                        className="flex items-center gap-4 rounded-lg border border-slate-700 bg-slate-950/50 px-3 py-2 text-[13px] text-slate-300"
                    >
                        <span>
                            <b className="text-white">{int(data?.resultCount ?? 0)} resultados.</b> Cada fila responde:{' '}
                            <b className="text-white">¿buen negocio?</b> · <b className="text-white">¿cuesta menos de lo que vale?</b> ·{' '}
                            <b className="text-white">¿dejó de caer?</b> Pasa el cursor por <b className="text-white">?</b> para entender
                            cada columna y pulsa una empresa para ver su historia.
                        </span>
                        <span className="ml-auto flex shrink-0 gap-2" aria-label="Leyenda de colores">
                            <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-0.5 text-[11px] font-semibold text-emerald-300">Favorable</span>
                            <span className="rounded-full border border-amber-500/30 bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-400">Revisar</span>
                            <span className="rounded-full border border-red-400/30 bg-red-400/10 px-2 py-0.5 text-[11px] font-semibold text-red-300">Desfavorable</span>
                        </span>
                    </div>

                    {!data && loading && <p className="text-sm text-slate-500">Cargando oportunidades…</p>}
                    {data && data.rows.length === 0 && (
                        <p className="text-sm text-slate-400">
                            Ninguna acción cumple todas las preguntas exigidas: desactiva alguna
                        </p>
                    )}
                    {data && data.rows.length > 0 && <OpportunitiesTable rows={data.rows} loading={loading} />}
                </>
            )}

            <footer className="flex justify-between pt-0.5 text-xs text-slate-400">
                <span>Datos: TradingView (15 min de retraso, sin cuenta) · Dataroma · FRED AAA</span>
                <span>
                    Solo screener: la plataforma no envía órdenes.{asOf ? ` · Actualizado ${asOf}` : ''}
                </span>
            </footer>
        </div>
    );
}
