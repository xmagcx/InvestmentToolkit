/**
 * RowDetail.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     The story of one opportunity, in three columns: why it has N stars (the checklist of every
 *     question with its value and threshold), what it is really worth (the Graham formula filled
 *     in), and why it fell plus who is buying it (Dataroma and analysts). Offers the two actions:
 *     add to the watchlist and open the analysis page.
 *
 * Layer: Frontend / UI / Opportunities
 *
 * Usage Examples:
 *     <RowDetail row={row} />
 *
 * Key Input Dependencies:
 *     - services/api.ts (addToWatchlist — the one watchlist client)
 *     - services/opportunities.ts (OpportunityRow)
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GROUP_NAMES, GROUP_ORDER, num } from './format';
import { addToWatchlist } from '../../services/api';
import type { OpportunityRow } from '../../services/opportunities';

function Mark({ ok }: { ok: boolean | null }) {
    if (ok === null) return <span aria-hidden="true" className="font-bold text-slate-500">·</span>;
    return (
        <span aria-hidden="true" className={ok ? 'font-bold text-emerald-400' : 'font-bold text-red-400'}>
            {ok ? '✓' : '✗'}
        </span>
    );
}

export default function RowDetail({ row }: { row: OpportunityRow }) {
    const navigate = useNavigate();
    const [feedback, setFeedback] = useState<string | null>(null);

    const handleWatchlist = async () => {
        try {
            await addToWatchlist(row.ticker);
            setFeedback('Agregada a seguimiento');
        } catch {
            setFeedback('No se pudo agregar a seguimiento');
        }
    };

    const graham = row.graham;
    const dataroma = row.dataroma;
    const analysts = row.analysts;

    return (
        <div className="grid grid-cols-[1.25fr_1fr_1fr] gap-4 border-t border-slate-700 px-4 py-3.5">
            <section>
                <h4 className="mb-2 text-[13px] font-semibold text-slate-100">¿Por qué tiene {row.stars} de 5 estrellas?</h4>
                {GROUP_ORDER.map(id => {
                    const group = row.groups[id];
                    return (
                        <div key={id}>
                            <p className="mt-2 mb-1 text-xs font-bold uppercase tracking-wider text-slate-400">
                                <Mark ok={group.ok} /> {GROUP_NAMES[id]}
                                {group.notApplicable ? ' — no aplica a su sector' : ''}
                            </p>
                            <ul className="flex flex-col gap-0.5">
                                {group.items.map(item => (
                                    <li key={item.key} className="grid grid-cols-[16px_1fr_auto_auto] items-baseline gap-2 text-xs text-slate-300">
                                        <Mark ok={item.ok} />
                                        <span>{item.label}</span>
                                        <span className="font-mono text-slate-200">
                                            {item.ok === null && item.value === null
                                                ? <i className="not-italic text-slate-400">{item.display || 'Datos insuficientes'}</i>
                                                : item.display}
                                        </span>
                                        <span className="min-w-18 text-right font-mono text-slate-400">{item.threshold}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    );
                })}
            </section>

            <section>
                <h4 className="mb-2 text-[13px] font-semibold text-slate-100">¿Cuánto vale realmente?</h4>
                {!graham ? (
                    <p className="mb-2 text-xs leading-relaxed text-slate-300">
                        Sin beneficio por acción positivo no se puede calcular el valor intrínseco de Graham:{' '}
                        <b className="text-white">datos insuficientes</b>.
                    </p>
                ) : (
                    <>
                        <p className="mb-2 text-xs leading-relaxed text-slate-300">
                            Benjamin Graham, el maestro de Warren Buffett, estimaba cuánto vale una acción a partir de lo
                            que gana. Usamos su ganancia por acción de <b className="text-white">{num(graham.formula.eps, 2)} USD</b>, un
                            crecimiento esperado de <b className="text-white">{num(graham.formula.g, 0)} %</b> anual y el bono AAA en{' '}
                            <b className="text-white">{num(graham.formula.y, 2)} %</b>.
                        </p>
                        <div className="rounded border border-slate-700 bg-slate-800 p-2 font-mono text-xs leading-relaxed text-slate-200">
                            V = EPS × (8,5 + 2g) × 4,4 / Y<br />
                            {`V = ${num(graham.formula.eps, 2)} × (8,5 + 2×${num(graham.formula.g, 0)}) × 4,4 / ${num(graham.formula.y, 2)}`}<br />
                            {`V = ${num(graham.value, 2)} USD · precio ${num(row.price, 2)} USD`}<br />
                            {`Margen de seguridad = ${num(graham.mos, 1)} %`}
                        </div>
                        <p className="mt-2 text-xs leading-relaxed text-slate-300">
                            {graham.mos >= 25 ? (
                                <>
                                    En palabras simples: pagas <b className="text-white">{num(100 - graham.mos, 0)} centavos por cada dólar</b> que
                                    vale. Ese <b className="text-white">{num(graham.mos, 0)} % de colchón</b> te protege si la estimación resulta
                                    optimista.
                                </>
                            ) : graham.mos >= 0 ? (
                                'Cuesta apenas menos de lo que vale: el colchón es pequeño, conviene esperar un mejor precio.'
                            ) : (
                                <>Hoy cuesta <b className="text-white">más</b> de lo que vale según Graham: no hay colchón.</>
                            )}
                        </p>
                    </>
                )}
            </section>

            <section>
                <h4 className="mb-2 text-[13px] font-semibold text-slate-100">¿Por qué bajó?</h4>
                <p className="mb-2 text-xs leading-relaxed text-slate-300">
                    Hoy vale {num(row.price, 2)} USD, un {num(-row.dropPct, 0)} % menos que su máximo del año ({num(row.high52, 2)} USD).{' '}
                    {row.aboveSma50 ? (
                        <><b className="text-white">Ya empezó a recuperarse</b>: volvió sobre su promedio de 50 días.</>
                    ) : (
                        <><b className="text-white">Todavía no se recupera</b>: sigue bajo su promedio de 50 días; puede seguir bajando.</>
                    )}
                </p>

                <h4 className="mb-2 mt-3 text-[13px] font-semibold text-slate-100">¿Quién está comprando?</h4>
                {dataroma.superinvestors > 0 && (
                    <p className="mb-2 text-xs leading-relaxed text-slate-300">
                        <b className="text-white">{dataroma.superinvestors === 1 ? '1 superinversor' : `${dataroma.superinvestors} superinversores`}</b> {dataroma.superinvestors === 1 ? 'compró' : 'compraron'} en el último trimestre
                        {dataroma.holdPrice !== null && <>, a un precio medio declarado de <b className="text-white">{num(dataroma.holdPrice, 2)} USD</b></>}.
                        {dataroma.holdPrice !== null && ` Hoy cotiza ${num((row.price / dataroma.holdPrice - 1) * 100, 1)} % respecto a ese precio.`}
                    </p>
                )}
                {dataroma.insiders > 0 && (
                    <p className="mb-2 text-xs leading-relaxed text-slate-300">
                        <b className="text-white">{dataroma.insiders} compras de directivos</b> en el mismo mes
                        {dataroma.insiderCluster ? ' (compra agrupada: más de un directivo)' : ''}, ninguna de accionistas del 10 %.
                    </p>
                )}
                {dataroma.superinvestors === 0 && dataroma.insiders === 0 && (
                    <p className="mb-2 text-xs leading-relaxed text-slate-300">Sin compras registradas en Dataroma.</p>
                )}
                {analysts && analysts.total > 0 && (
                    <p className="mb-2 text-xs leading-relaxed text-slate-300">
                        <b className="text-white">Analistas:</b> {analysts.buy} recomiendan comprar, {analysts.hold} mantener y{' '}
                        {analysts.sell} vender.
                        {analysts.targetPct !== null && <> En promedio esperan que el precio suba <b className="text-white">{num(analysts.targetPct, 0)} %</b> en 12 meses.</>}
                    </p>
                )}

                <div className="mt-2.5 flex items-center gap-2">
                    <button
                        type="button"
                        onClick={handleWatchlist}
                        className="rounded bg-emerald-700 px-4 py-2 text-[13px] font-semibold text-white hover:bg-emerald-600"
                    >
                        Agregar a seguimiento
                    </button>
                    <button
                        type="button"
                        onClick={() => navigate(`/analysis?ticker=${row.ticker}`)}
                        className="rounded border border-slate-700 bg-slate-800 px-3.5 py-2 text-[13px] font-semibold text-slate-200 hover:bg-slate-700"
                    >
                        Abrir análisis
                    </button>
                    {feedback && <span role="status" className="text-xs text-emerald-300">{feedback}</span>}
                </div>
            </section>
        </div>
    );
}
