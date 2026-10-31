/**
 * DailyBriefPage.tsx (React Page)
 *
 * Purpose:
 *     "Brief diario": the day's review list (artboard design/daily-brief/02-lista-del-dia.html).
 *     A slim market bar in plain Spanish, the tasks ordered from most to least urgent — each one
 *     says why, what to do and where to go — the TA-stale notice, and a collapsed table with the
 *     holdings that have nothing pending today. None of it is a buy or sell order.
 *
 * Layer: Frontend / Pages
 * Usage Examples:
 *     <Route path="daily-brief" element={<DailyBriefPage />} />
 * Key Functions: DailyBriefPage, MarketBar, TaskRow, UntaskedTable.
 * Key Input Dependencies:
 *     - services/dailyBrief.ts (GET /api/daily-brief/today and the regeneration routes, contract S10)
 *     - services/api.ts addToWatchlist for the "Agregar a seguimiento" link
 */
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import {
    BriefBusyError,
    NoBriefError,
    fetchRegenerationStatus,
    fetchTodayBrief,
    startBriefRegeneration,
    type BriefTask,
    type DailyBriefToday,
    type Urgency,
} from '../services/dailyBrief';
import { addToWatchlist } from '../services/api';

const POLL_MS = 5000;

const URGENCY: Record<Urgency, { label: string; rank: number; text: string; dot: string }> = {
    alta:  { label: 'Alta',  rank: 0, text: 'text-red-400',    dot: 'bg-red-400' },
    media: { label: 'Media', rank: 1, text: 'text-amber-400',  dot: 'bg-amber-400' },
    baja:  { label: 'Baja',  rank: 2, text: 'text-slate-400',  dot: 'bg-slate-400' },
};

/** "Viernes 30 de octubre de 2026" — Intl gives "viernes, 30 de octubre de 2026". */
function longDate(value: Date): string {
    const parts = new Intl.DateTimeFormat('es-ES', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    }).formatToParts(value);
    const part = (type: Intl.DateTimeFormatPartTypes) => parts.find(p => p.type === type)?.value ?? '';
    const weekday = part('weekday');
    return `${weekday.charAt(0).toUpperCase()}${weekday.slice(1)} ${part('day')} de ${part('month')} de ${part('year')}`;
}

function generatedStamp(generatedAt: string): string {
    const when = new Date(generatedAt);
    if (Number.isNaN(when.getTime())) return '';
    const time = when.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    const isToday = when.toDateString() === new Date().toDateString();
    // Mid-sentence the weekday stays lowercase: "Generado el viernes 30 de octubre…".
    return isToday ? `Generado hoy a las ${time}` : `Generado el ${longDate(when).toLowerCase()} a las ${time}`;
}

/** Green for a positive reading, red for a negative one, plain otherwise. */
function indicatorTone(display: string): string {
    if (display.startsWith('+')) return 'text-emerald-400';
    if (display.startsWith('−') || display.startsWith('-')) return 'text-red-400';
    return 'text-slate-100';
}

function MarketBar({ market }: { market: DailyBriefToday['market'] }) {
    return (
        <section aria-label="Contexto del mercado"
            className="flex flex-wrap items-center gap-5 rounded-xl border border-slate-800 bg-slate-900/80 px-5 py-3 shadow-lg">
            <p className="whitespace-nowrap text-[15px] font-semibold text-slate-100">
                <span className="text-amber-400">{market.label}</span>
            </p>
            <span aria-hidden="true" className="h-7 w-px bg-slate-700" />
            <p className="flex-1 text-[13px] text-slate-300">{market.sentence}</p>
            <span aria-hidden="true" className="h-7 w-px bg-slate-700" />
            <div className="flex flex-wrap gap-4 text-[13px] text-slate-300">
                {market.indicators.map(ind => (
                    <span key={ind.key} className="whitespace-nowrap">
                        {ind.label}{' '}
                        <b className={`font-mono font-semibold ${indicatorTone(ind.display)}`}>{ind.display}</b>
                    </span>
                ))}
            </div>
        </section>
    );
}

function TaskRow({ task }: { task: BriefTask }) {
    const [added, setAdded] = useState(false);
    const [addError, setAddError] = useState<string | null>(null);
    const urgency = URGENCY[task.urgency] ?? URGENCY.baja;

    const add = async () => {
        try {
            await addToWatchlist(task.ticker);
            setAdded(true);
        } catch (err) {
            setAddError(err instanceof Error ? err.message : String(err));
        }
    };

    return (
        <li className="grid grid-cols-[96px_76px_1fr_190px_170px] items-center gap-4 rounded-xl border border-slate-800 bg-slate-900/80 px-5 py-3.5 shadow-lg">
            <span className={`inline-flex items-center gap-2 text-xs font-bold uppercase tracking-widest ${urgency.text}`}>
                <i aria-hidden="true" className={`inline-block h-2.5 w-2.5 rounded-sm ${urgency.dot}`} />
                {urgency.label}
            </span>
            <span className="font-mono text-lg font-bold text-white">{task.ticker}</span>
            <p className="text-sm text-slate-300">{task.summary}</p>
            <p className="text-sm font-semibold text-slate-100">
                {task.action}
                <span className="mt-1 block w-fit rounded bg-slate-800 px-2 py-0.5 text-xs font-normal text-slate-400">
                    {task.tag}
                </span>
            </p>
            {task.link === 'analysis' ? (
                <Link to={`/analysis?ticker=${task.ticker}`}
                    className="inline-flex min-h-11 items-center justify-center rounded border border-slate-700 px-3.5 text-[13px] font-semibold text-amber-400 hover:bg-slate-800">
                    Abrir análisis
                </Link>
            ) : added ? (
                <span className="text-[13px] font-semibold text-emerald-300">Agregada a seguimiento</span>
            ) : (
                <button type="button" onClick={add}
                    className="inline-flex min-h-11 items-center justify-center rounded border border-slate-700 px-3.5 text-[13px] font-semibold text-amber-400 hover:bg-slate-800">
                    Agregar a seguimiento
                </button>
            )}
            {addError && <span className="col-span-5 text-xs text-red-400">{addError}</span>}
        </li>
    );
}

function UntaskedTable({ rows }: { rows: DailyBriefToday['untasked'] }) {
    return (
        <details className="group">
            <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 px-1 text-[13px] font-semibold text-slate-400 hover:text-slate-200">
                <ChevronRight aria-hidden="true" size={14} className="transition-transform group-open:rotate-90" />
                <span>Ver las otras {rows.length} acciones sin tareas para hoy</span>
            </summary>
            <div className="mt-2 overflow-x-auto rounded-lg border border-slate-700">
                <table className="w-full text-[13px]">
                    <caption className="sr-only">Acciones sin tareas pendientes hoy</caption>
                    <thead className="bg-slate-800 text-left text-slate-400">
                        <tr>
                            <th scope="col" className="px-3 py-2 font-semibold">Ticker</th>
                            <th scope="col" className="px-3 py-2 font-semibold">Estado</th>
                            <th scope="col" className="px-3 py-2 text-right font-semibold">RSI</th>
                            <th scope="col" className="px-3 py-2 font-semibold">Nota</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                        {rows.map(row => (
                            <tr key={row.ticker} className="text-slate-300 hover:bg-slate-800/40">
                                <td className="px-3 py-2 font-mono">{row.ticker}</td>
                                <td className="px-3 py-2">{row.status}</td>
                                <td className="px-3 py-2 text-right font-mono">
                                    {row.rsi === null ? '—' : row.rsi.toFixed(1).replace('.', ',')}
                                </td>
                                <td className="px-3 py-2">{row.note}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </details>
    );
}

export default function DailyBriefPage() {
    const [brief, setBrief] = useState<DailyBriefToday | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<{ noBrief: boolean; message: string } | null>(null);
    const [regenerating, setRegenerating] = useState(false);
    const [feedback, setFeedback] = useState<string | null>(null);

    // No setLoading(true) here: the first render already starts loading, and a reload keeps
    // the current list on screen until the new one arrives.
    const load = useCallback(() => {
        return fetchTodayBrief()
            .then(data => { setBrief(data); setError(null); })
            .catch((err: Error) => setError({ noBrief: err instanceof NoBriefError, message: err.message }))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { void load(); }, [load]);

    // While the background run is going, ask every 5 s and reload the brief when it ends.
    useEffect(() => {
        if (!regenerating) return;
        const timer = setInterval(() => {
            void fetchRegenerationStatus()
                .then(status => {
                    if (status.running) return;
                    setRegenerating(false);
                    setFeedback('Brief regenerado');
                    return load();
                })
                .catch((err: Error) => { setRegenerating(false); setFeedback(err.message); });
        }, POLL_MS);
        return () => clearInterval(timer);
    }, [regenerating, load]);

    const regenerate = async () => {
        setFeedback(null);
        try {
            await startBriefRegeneration();
            setRegenerating(true);
            setFeedback('Generando el brief…');
        } catch (err) {
            setFeedback(err instanceof BriefBusyError ? 'Ya se está generando' : String(err));
        }
    };

    const tasks = [...(brief?.tasks ?? [])].sort(
        (a, b) => (URGENCY[a.urgency]?.rank ?? 9) - (URGENCY[b.urgency]?.rank ?? 9),
    );
    const taskCount = brief?.counts?.tasks ?? tasks.length;

    return (
        <div className="mx-auto flex max-w-7xl flex-col gap-3.5 p-6">

            <header className="flex items-start justify-between">
                <div>
                    <h1 className="text-xl font-bold text-white">Brief diario</h1>
                    {brief && (
                        <p className="text-sm text-slate-400">
                            {longDate(new Date(`${brief.date}T00:00:00`))} ·{' '}
                            {taskCount === 1 ? '1 cosa para revisar' : `${taskCount} cosas para revisar`}, de más a menos urgente
                        </p>
                    )}
                </div>
                <div className="flex items-center gap-3">
                    {brief && <p className="text-xs text-slate-400">{generatedStamp(brief.generatedAt)}</p>}
                    <button type="button" onClick={regenerate} disabled={regenerating}
                        className="min-h-11 rounded bg-zinc-800 px-3.5 text-xs font-semibold text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
                        ↻ Regenerar brief
                    </button>
                </div>
            </header>

            <p role="status" className="min-h-4 text-xs text-amber-400">{feedback}</p>

            {loading && !brief && !error && (
                <p className="flex items-center gap-2 text-sm text-slate-500">
                    <RefreshCw className="animate-spin" size={16} /> Cargando el brief…
                </p>
            )}

            {error?.noBrief && (
                <div className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 text-center">
                    <p className="text-slate-300">Todavía no hay brief de hoy</p>
                    <p className="mt-1 text-sm text-slate-400">Genéralo para ver la lista del día.</p>
                </div>
            )}

            {error && !error.noBrief && <p className="text-sm text-red-400">{error.message}</p>}

            {brief && (
                <>
                    <MarketBar market={brief.market} />

                    <div className="mx-0.5 flex items-baseline justify-between">
                        <h2 className="text-lg font-semibold text-slate-100">Lista del día</h2>
                        <p className="text-[13px] text-slate-400">
                            Ninguna de estas tareas es una orden de compra o venta: son revisiones sugeridas.
                        </p>
                    </div>

                    {tasks.length === 0 ? (
                        <p className="rounded-xl border border-slate-800 bg-slate-900/80 p-6 text-center text-sm text-slate-400">
                            Hoy no hay nada urgente que revisar
                        </p>
                    ) : (
                        <ol className="flex flex-col gap-2.5">
                            {tasks.map(task => <TaskRow key={task.ticker} task={task} />)}
                        </ol>
                    )}

                    {!brief.taFresh && (
                        <div className="flex items-center gap-2.5 rounded border border-slate-700 bg-slate-800 px-3.5 py-2.5 text-[13px] text-amber-400">
                            <AlertTriangle aria-hidden="true" size={14} />
                            Análisis técnico no actualizado hoy
                            {brief.taNote && <span className="text-slate-300">— {brief.taNote}</span>}
                        </div>
                    )}

                    {(brief.untasked ?? []).length > 0 && <UntaskedTable rows={brief.untasked} />}
                </>
            )}
        </div>
    );
}
