/**
 * OpportunitiesTable.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     The results grid of the Oportunidades page: one row per company, nine columns that each
 *     answer a question in plain Spanish (with a "?" help), a 1–5 star note with the questions it
 *     meets, and an expandable detail row telling the company's story.
 *
 * Layer: Frontend / UI / Opportunities
 *
 * Usage Examples:
 *     <OpportunitiesTable rows={data.rows} loading={loading} />
 *
 * Key Input Dependencies:
 *     - services/opportunities.ts (OpportunityRow)
 *     - components/opportunities/RowDetail.tsx (the story panel)
 */
import { useState, type ReactNode } from 'react';
import HelpTip from './HelpTip';
import RowDetail from './RowDetail';
import Verdict from './Verdict';
import { GROUP_NAMES, GROUP_ORDER, num } from './format';
import type { OpportunityRow } from '../../services/opportunities';

function Cell({ main, hint, children }: { main?: string; hint?: string; children?: ReactNode }) {
    return (
        <span className="flex flex-col items-start gap-1">
            {main && <span className="font-mono text-xs text-slate-100">{main}</span>}
            {children}
            {hint && <span className="text-[11px] text-slate-400">{hint}</span>}
        </span>
    );
}

function Stars({ row }: { row: OpportunityRow }) {
    const [open, setOpen] = useState(false);
    return (
        <span className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
            <button
                type="button"
                aria-label={`${row.stars} de 5 estrellas. Ver preguntas cumplidas.`}
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
                className="px-0.5 py-1 text-[15px] tracking-wide text-primary"
            >
                {[1, 2, 3, 4, 5].map(i => (
                    <span key={i} className={i <= row.stars ? '' : 'text-slate-600'}>★</span>
                ))}
            </button>
            {open && (
                <span role="note" className="absolute -left-1.5 top-8 z-10 block w-67 rounded-lg border border-slate-700 bg-surface p-2.5 shadow-xl">
                    <ul className="flex flex-col gap-1">
                        {GROUP_ORDER.map(id => {
                            const group = row.groups[id];
                            return (
                                <li key={id} className="flex items-baseline gap-2 text-xs text-slate-300">
                                    <span aria-hidden="true" className={group.ok ? 'font-bold text-emerald-400' : 'font-bold text-red-400'}>
                                        {group.ok ? '✓' : '✗'}
                                    </span>
                                    <span>
                                        {GROUP_NAMES[id]}
                                        {!group.ok && group.notApplicable ? ' — datos insuficientes' : ''}
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                </span>
            )}
        </span>
    );
}

function DropCell({ row }: { row: OpportunityRow }) {
    const strong = row.dropPct <= -20;
    return (
        <Cell main={`${num(row.dropPct, 0)} %`} hint={`máx. ${num(row.high52, 0)} USD`}>
            <Verdict tone={strong ? 'ok' : 'mid'}>{strong ? 'Rebaja fuerte' : 'Rebaja leve'}</Verdict>
        </Cell>
    );
}

function ValueCell({ row }: { row: OpportunityRow }) {
    if (!row.graham) {
        return (
            <Cell hint="aún no tiene ganancias">
                <Verdict tone="nd">Sin datos</Verdict>
            </Cell>
        );
    }
    const { value, mos } = row.graham;
    const scale = Math.max(value, row.price);
    const priceWidth = Math.max(4, Math.min(100, (row.price / scale) * 100));
    const valuePos = Math.min(100, (value / scale) * 100);
    return (
        <Cell main={`Cuesta ${num(row.price, 0)} · vale ~${num(value, 0)}`}>
            <span aria-hidden="true" className="relative my-0.5 block h-1.5 w-32 rounded-full bg-slate-700">
                <span
                    className={`absolute inset-y-0 left-0 rounded-full ${mos < 0 ? 'bg-red-400' : 'bg-emerald-400'}`}
                    style={{ width: `${priceWidth}%` }}
                />
                <span className="absolute -top-[3px] h-3 w-0.5 bg-white" style={{ left: `calc(${valuePos}% - 1px)` }} />
            </span>
            {mos >= 25 ? (
                <Verdict tone="ok">{`${num(mos, 0)} % más barata`}</Verdict>
            ) : mos >= 0 ? (
                <Verdict tone="mid">{`Solo ${num(mos, 0)} % bajo su valor`}</Verdict>
            ) : (
                <Verdict tone="bad">{`Cuesta ${num(-mos, 0)} % más de lo que vale`}</Verdict>
            )}
        </Cell>
    );
}

function BusinessCell({ row }: { row: OpportunityRow }) {
    if (row.groups.calidad.notApplicable || row.roic === null) {
        return (
            <Cell hint="métrica no útil en su sector">
                <Verdict tone="nd">No aplica</Verdict>
            </Cell>
        );
    }
    return (
        <Cell main={`${num(row.roic, 0)} ¢ por cada $1`}>
            {row.roic >= 15 ? (
                <Verdict tone="ok">Excelente</Verdict>
            ) : row.roic >= 10 ? (
                <Verdict tone="mid">Correcto</Verdict>
            ) : (
                <Verdict tone="bad">Débil</Verdict>
            )}
        </Cell>
    );
}

function PriceCell({ row }: { row: OpportunityRow }) {
    if (row.pe === null) {
        return (
            <Cell>
                <Verdict tone="nd">Sin datos</Verdict>
            </Cell>
        );
    }
    const hint = row.fcfYield === null ? 'efectivo: sin datos' : `genera $${num(row.fcfYield, 1)} por cada $100`;
    if (row.sectorPe === null) {
        return (
            <Cell main={`${num(row.pe, 0)} años`} hint={hint}>
                <Verdict tone="nd">Sin su sector</Verdict>
            </Cell>
        );
    }
    const cheaper = row.pe < row.sectorPe;
    return (
        <Cell main={`${num(row.pe, 0)} años (sector ${num(row.sectorPe, 0)})`} hint={hint}>
            <Verdict tone={cheaper ? 'ok' : 'mid'}>{cheaper ? 'Bajo su sector' : 'Sobre su sector'}</Verdict>
        </Cell>
    );
}

/** The artboard's "alcista" MACD is the live crossover: MACD above its signal line. */
function isTurning(row: OpportunityRow): boolean {
    const bullishMacd = row.macd !== null && row.macdSignal !== null && row.macd > row.macdSignal;
    return row.aboveSma50 && ((row.rsi !== null && row.rsi < 35) || bullishMacd);
}

function TurnCell({ row }: { row: OpportunityRow }) {
    const turning = isTurning(row);
    return (
        <Cell hint={turning ? 'sobre su media de 50 días' : 'bajo su media de 50 días'}>
            <Verdict tone={turning ? 'ok' : 'mid'}>{turning ? 'Ya sube' : 'Aún no'}</Verdict>
        </Cell>
    );
}

function AnalystsCell({ row }: { row: OpportunityRow }) {
    const a = row.analysts;
    if (!a || a.total === 0) {
        return (
            <Cell>
                <Verdict tone="nd">Sin cobertura</Verdict>
            </Cell>
        );
    }
    const share = a.buy / a.total;
    const hint = `${a.buy} de ${a.total} dicen comprar${a.targetPct === null ? '' : ` · esperan +${num(a.targetPct, 0)} %`}`;
    return (
        <Cell hint={hint}>
            {share >= 0.7 ? (
                <Verdict tone="ok">Compra fuerte</Verdict>
            ) : share >= 0.5 ? (
                <Verdict tone="ok">Compra</Verdict>
            ) : share >= 0.3 ? (
                <Verdict tone="mid">Mantener</Verdict>
            ) : (
                <Verdict tone="bad">Venta</Verdict>
            )}
            <span aria-hidden="true" className="my-0.5 flex h-1.5 w-28 overflow-hidden rounded-full bg-slate-700">
                <span className="bg-emerald-400" style={{ width: `${(a.buy / a.total) * 100}%` }} />
                <span className="bg-amber-400" style={{ width: `${(a.hold / a.total) * 100}%` }} />
                <span className="bg-red-400" style={{ width: `${(a.sell / a.total) * 100}%` }} />
            </span>
        </Cell>
    );
}

function BuyersCell({ row }: { row: OpportunityRow }) {
    const { superinvestors, insiders, insiderCluster } = row.dataroma;
    if (superinvestors === 0 && insiders === 0) {
        return <span className="text-[11px] text-slate-400">Sin compras recientes</span>;
    }
    const insiderText = insiders === 1 ? '1 compra de un directivo' : `${insiders} compras de directivos`;
    return (
        <Cell
            main={superinvestors > 0 ? (superinvestors === 1 ? '1 gran inversor' : `${superinvestors} grandes inversores`) : undefined}
            hint={insiders > 0 ? `${insiderText}${insiderCluster ? ' (varios a la vez)' : ''}` : undefined}
        />
    );
}

const TH = 'sticky top-0 z-[2] bg-slate-800 px-2.5 py-2 text-left text-xs font-semibold leading-tight text-slate-300';

export default function OpportunitiesTable({ rows, loading }: { rows: OpportunityRow[]; loading: boolean }) {
    const [open, setOpen] = useState<string | null>(null);

    return (
        <div className={`flex-1 overflow-auto rounded-lg border border-slate-700 bg-slate-900/80 transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <table className="w-full table-fixed border-collapse text-[13px]" aria-busy={loading}>
                <caption className="sr-only">Oportunidades ordenadas por estrellas. Pulse una empresa para ver su historia.</caption>
                <thead>
                    <tr>
                        <th scope="col" className={`${TH} w-[13.5%]`}>
                            <span className="inline-flex items-center gap-1.5">
                                Empresa
                                <HelpTip label="Empresa">
                                    <p>Nombre y sector. Pulsa la fila para ver por qué aparece aquí.</p>
                                </HelpTip>
                            </span>
                        </th>
                        <th scope="col" className={`${TH} w-[7.3%]`}>
                            <span className="inline-flex items-center gap-1.5">
                                Nota
                                <HelpTip label="Nota">
                                    <p><b className="text-white">De 1 a 5 estrellas.</b> Una estrella por cada pregunta del recorrido que la empresa cumple.</p>
                                    <p>5★ = buen negocio, barata, cayó, ya gira y la compran expertos.</p>
                                </HelpTip>
                            </span>
                        </th>
                        <th scope="col" className={`${TH} w-[9.6%]`}>
                            <span className="inline-flex items-center gap-1.5">
                                ¿Cuánto bajó?
                                <HelpTip label="¿Cuánto bajó?">
                                    <p>Cuánto cayó su precio desde el <b className="text-white">máximo del último año</b>.</p>
                                    <p><b className="text-white">Por qué importa:</b> si el negocio sigue sano, una caída fuerte es como una liquidación: compras lo mismo más barato.</p>
                                    <p>Favorable: −20 % o más.</p>
                                </HelpTip>
                            </span>
                        </th>
                        <th scope="col" className={`${TH} w-[14.0%]`}>
                            <span className="inline-flex items-center gap-1.5">
                                ¿Cuesta menos de lo que vale?
                                <HelpTip label="¿Cuesta menos de lo que vale?">
                                    <p>Comparamos el <b className="text-white">precio</b> con un <b className="text-white">valor estimado</b> (fórmula de Benjamin Graham, basada en sus ganancias y crecimiento).</p>
                                    <p>La diferencia es el <b className="text-white">margen de seguridad</b>: un colchón por si la estimación falla.</p>
                                    <p>Favorable: 25 % o más barata. Desfavorable: cuesta más de lo que vale.</p>
                                </HelpTip>
                            </span>
                        </th>
                        <th scope="col" className={`${TH} w-[9.8%]`}>
                            <span className="inline-flex items-center gap-1.5">
                                ¿Es buen negocio?
                                <HelpTip label="¿Es buen negocio?">
                                    <p><b className="text-white">Cuánto gana por cada dólar que invierte</b> (ROIC). Un negocio excelente gana 15 ¢ o más por cada $1, año tras año.</p>
                                    <p>Favorable ≥ 15 ¢ · Revisar 10–15 ¢ · Desfavorable &lt; 10 ¢.</p>
                                </HelpTip>
                            </span>
                        </th>
                        <th scope="col" className={`${TH} w-[13.1%]`}>
                            <span className="inline-flex items-center gap-1.5">
                                ¿Es cara para lo que gana?
                                <HelpTip label="¿Es cara para lo que gana?" align="right">
                                    <p><b className="text-white">P/E:</b> cuántos años de ganancias pagas al comprarla. Menos años que sus competidores = más barata que su sector.</p>
                                    <p>También mostramos cuánto <b className="text-white">dinero en efectivo</b> genera al año por cada $100 de precio (FCF yield). Favorable: $5 o más.</p>
                                </HelpTip>
                            </span>
                        </th>
                        <th scope="col" className={`${TH} w-[10.1%]`}>
                            <span className="inline-flex items-center gap-1.5">
                                ¿Dejó de caer?
                                <HelpTip label="¿Dejó de caer?" align="right">
                                    <p>Señal técnica de corto plazo. Evita comprar algo que <b className="text-white">sigue cayendo</b> sin freno.</p>
                                    <p>Favorable: dejó de bajar o empezó a subir (RSI bajo y MACD al alza, precio sobre su media de 50 días).</p>
                                </HelpTip>
                            </span>
                        </th>
                        <th scope="col" className={`${TH} w-[12.4%]`}>
                            <span className="inline-flex items-center gap-1.5">
                                ¿Qué opinan los analistas?
                                <HelpTip label="¿Qué opinan los analistas?" align="right">
                                    <p>Los <b className="text-white">analistas</b> son expertos de bancos y corredoras que estudian la empresa a tiempo completo y recomiendan <b className="text-white">comprar, mantener o vender</b>.</p>
                                    <p>Mostramos cuántos recomiendan cada cosa y el <b className="text-white">precio que esperan</b> en 12 meses.</p>
                                    <p>Favorable: la mayoría recomienda comprar. Es una opinión: puede equivocarse.</p>
                                    <p>Fuente: TradingView (consenso de analistas).</p>
                                </HelpTip>
                            </span>
                        </th>
                        <th scope="col" className={`${TH} w-[10.1%]`}>
                            <span className="inline-flex items-center gap-1.5">
                                ¿Quién compra?
                                <HelpTip label="¿Quién compra?" align="right">
                                    <p>Compras recientes de <b className="text-white">grandes inversores</b> (como Buffett) y de <b className="text-white">directivos de la empresa</b> con su propio dinero (Dataroma).</p>
                                    <p>Confirma la idea; nunca decide por sí sola.</p>
                                </HelpTip>
                            </span>
                        </th>
                    </tr>
                </thead>
                <tbody>
                    {rows.map(row => {
                        const isOpen = open === row.ticker;
                        return [
                            <tr
                                key={row.ticker}
                                data-testid={`row-${row.ticker}`}
                                className={`border-t border-slate-700 hover:bg-slate-800/40 ${isOpen ? 'bg-slate-800/60' : ''}`}
                            >
                                <td className="px-2.5 py-2 align-middle">
                                    <button
                                        type="button"
                                        aria-expanded={isOpen}
                                        aria-controls={`detalle-${row.ticker}`}
                                        onClick={() => setOpen(isOpen ? null : row.ticker)}
                                        className="text-left"
                                    >
                                        <span className="block font-mono text-sm font-bold text-white">{row.ticker}</span>
                                        <span className="block max-w-34 truncate text-xs text-slate-400">{row.name} · {row.sector}</span>
                                    </button>
                                </td>
                                <td className="px-2.5 py-2 align-middle"><Stars row={row} /></td>
                                <td className="px-2.5 py-2 align-middle"><DropCell row={row} /></td>
                                <td className="px-2.5 py-2 align-middle"><ValueCell row={row} /></td>
                                <td className="px-2.5 py-2 align-middle"><BusinessCell row={row} /></td>
                                <td className="px-2.5 py-2 align-middle"><PriceCell row={row} /></td>
                                <td className="px-2.5 py-2 align-middle"><TurnCell row={row} /></td>
                                <td className="px-2.5 py-2 align-middle"><AnalystsCell row={row} /></td>
                                <td className="px-2.5 py-2 align-middle"><BuyersCell row={row} /></td>
                            </tr>,
                            isOpen ? (
                                <tr key={`${row.ticker}-detail`} id={`detalle-${row.ticker}`} data-testid={`detail-${row.ticker}`} className="bg-slate-950/60">
                                    <td colSpan={9} className="p-0">
                                        <RowDetail row={row} />
                                    </td>
                                </tr>
                            ) : null,
                        ];
                    })}
                </tbody>
            </table>
        </div>
    );
}
