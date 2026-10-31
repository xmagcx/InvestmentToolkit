/**
 * StepperCard.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     The guided funnel of the Oportunidades page: six numbered questions in plain Spanish.
 *     Each question can be "exigida" (filters the universe) or left as "Suma ★" (only adds a
 *     star), shows how many stocks remain, and exposes its thresholds behind "Ajustar".
 *
 * Layer: Frontend / UI / Opportunities
 *
 * Usage Examples:
 *     <StepperCard steps={data.steps} universe={1645} resultCount={38} params={params}
 *                  onToggleRequire={…} onThreshold={…} onEtf={…} />
 *
 * Key Input Dependencies:
 *     - services/opportunities.ts (OpportunitiesParams, StepSummary)
 */
import { int } from './format';
import type { OpportunitiesParams, StepSummary } from '../../services/opportunities';

type NumericKey = Exclude<keyof OpportunitiesParams, 'require' | 'etf'>;

interface Field {
    key: NumericKey;
    label: string;
    aria: string;
    step?: number;
}

interface StepCopy {
    n: number;
    question: string;
    why: string;
    note: string;
    fields: Field[];
}

/** Copy and thresholds of each question, from design/oportunidades/01-embudo.html. */
const STEPS: StepCopy[] = [
    {
        n: 1,
        question: '¿Gana dinero?',
        why: 'Partimos por empresas con utilidades. Sin ganancias no hay valor que medir.',
        note: 'Sin ganancias, Graham no se puede calcular.',
        fields: [],
    },
    {
        n: 2,
        question: '¿Es un buen negocio?',
        why: 'Rinde bien sobre lo que invierte, genera caja real y no vive de la deuda.',
        note: 'Flujo de caja libre siempre positivo.',
        fields: [
            { key: 'roic', label: 'ROIC ≥', aria: 'Umbral ROIC' },
            { key: 'roe', label: 'ROE ≥', aria: 'Umbral ROE' },
            { key: 'roa', label: 'ROA ≥', aria: 'Umbral ROA' },
            { key: 'de', label: 'Deuda/Patrimonio ≤', aria: 'Umbral deuda patrimonio', step: 0.1 },
        ],
    },
    {
        n: 3,
        question: '¿Está a buen precio?',
        why: 'Cuesta menos de lo que vale según Graham y sus múltiplos son bajos.',
        note: 'P/E bajo la mediana de su sector.',
        fields: [
            { key: 'mos', label: 'Margen Graham ≥', aria: 'Umbral margen de seguridad' },
            { key: 'fcfy', label: 'FCF yield ≥', aria: 'Umbral FCF yield' },
            { key: 'peg', label: 'PEG ≤', aria: 'Umbral PEG', step: 0.1 },
            { key: 'target', label: 'Precio objetivo ≥', aria: 'Umbral precio objetivo' },
        ],
    },
    {
        n: 4,
        question: '¿Cayó por causas externas?',
        why: 'Bajó mucho desde su máximo aunque el negocio sigue sano: ahí está la oportunidad.',
        note: 'Además, precio bajo su media de 200 días.',
        fields: [{ key: 'drop', label: 'Caída desde máximo ≥', aria: 'Umbral caída desde máximo' }],
    },
    {
        n: 5,
        question: '¿Ya empezó a recuperarse?',
        why: 'Evita comprar un cuchillo que cae: busca señales de que dejó de bajar.',
        note: 'O cruce alcista del MACD, con precio sobre su media de 50 días.',
        fields: [{ key: 'rsi', label: 'RSI(14) <', aria: 'Umbral RSI' }],
    },
    {
        n: 6,
        question: '¿Lo compran los expertos?',
        why: 'Superinversores o directivos de la empresa compraron hace poco con su dinero.',
        note: 'Fuente: Dataroma. Confirma, nunca decide solo.',
        fields: [
            { key: 'sup', label: 'Superinversores ≥', aria: 'Umbral superinversores' },
            { key: 'ins', label: 'Directivos distintos ≥', aria: 'Umbral directivos' },
        ],
    },
];

/** "las preguntas 1 y 4" / "la pregunta 1" / "todo el universo (nada exigido)". */
function requiredText(required: number[]): string {
    if (required.length === 0) return 'todo el universo (nada exigido)';
    const list = required.length === 1
        ? String(required[0])
        : `${required.slice(0, -1).join(', ')} y ${required[required.length - 1]}`;
    return `«sí» a ${required.length === 1 ? 'la pregunta' : 'las preguntas'} ${list}`;
}

export default function StepperCard({
    steps,
    resultCount,
    params,
    onToggleRequire,
    onThreshold,
    onEtf,
}: {
    steps: StepSummary[];
    resultCount: number;
    params: OpportunitiesParams;
    onToggleRequire: (n: number) => void;
    onThreshold: (key: NumericKey, value: number) => void;
    onEtf: (on: boolean) => void;
}) {
    // The switches answer to the user's choice right away; the counts come from the last response.
    const required = [...params.require].sort((a, b) => a - b);

    return (
        <section className="rounded-xl border border-slate-800 bg-slate-900/80 p-4 shadow-lg" aria-labelledby="embudo-h">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h2 id="embudo-h" className="text-[15px] font-semibold text-white">
                        Encuentra buenas empresas a precio de oferta en 6 preguntas
                    </h2>
                    <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-slate-300">
                        Avanza de izquierda a derecha. Cada pregunta que <b>exiges</b> deja menos acciones; las que no
                        exiges solo suman una <b>estrella</b>. Así, arriba quedan los negocios sólidos que hoy están más
                        baratos.
                    </p>
                </div>
                <label className="flex shrink-0 items-center gap-2 text-[13px] text-slate-300">
                    <input type="checkbox" checked={params.etf} onChange={e => onEtf(e.target.checked)} />
                    Incluir ETF
                </label>
            </div>

            <ol className="mt-3 grid grid-cols-6 gap-2.5" aria-label="Preguntas para filtrar el universo de acciones">
                {STEPS.map(copy => {
                    const step = steps.find(s => s.n === copy.n);
                    const isRequired = required.includes(copy.n);
                    return (
                        <li key={copy.n} className="flex flex-col gap-1.5">
                            <span
                                aria-hidden="true"
                                className={`grid h-8 w-8 place-items-center rounded-full border-2 text-[13px] font-bold ${
                                    isRequired ? 'border-primary bg-amber-500/10 text-amber-400' : 'border-slate-600 bg-surface text-slate-300'
                                }`}
                            >
                                {copy.n}
                            </span>
                            <div
                                className={`flex flex-1 flex-col gap-1.5 rounded-lg border p-2.5 ${
                                    isRequired ? 'border-amber-500/45 bg-amber-500/5' : 'border-slate-700 bg-slate-950/50'
                                }`}
                            >
                                <p className="text-[13px] font-semibold leading-tight text-white">{copy.question}</p>
                                <p className="text-xs leading-snug text-slate-300">{copy.why}</p>
                                <div className="mt-auto flex items-center justify-between gap-1.5">
                                    <span className="font-mono text-xs text-slate-300">
                                        quedan{' '}
                                        <b className={`text-base ${isRequired ? 'text-amber-400' : 'text-white'}`}>
                                            {step ? int(step.remaining) : '—'}
                                        </b>
                                    </span>
                                    <span
                                        className={`whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-semibold ${
                                            isRequired ? 'border-amber-500/40 text-amber-400' : 'border-slate-700 text-slate-300'
                                        }`}
                                    >
                                        {isRequired ? 'Exige' : 'Suma ★'}
                                    </span>
                                </div>
                                <div className="flex items-center justify-between gap-1.5">
                                    <button
                                        type="button"
                                        role="switch"
                                        aria-checked={isRequired}
                                        aria-label={`Exigir el paso ${copy.n}: ${copy.question}`}
                                        onClick={() => onToggleRequire(copy.n)}
                                        className="inline-flex items-center gap-2 text-xs text-slate-300"
                                    >
                                        <span
                                            aria-hidden="true"
                                            className={`relative h-5 w-[34px] shrink-0 rounded-full ${isRequired ? 'bg-primary' : 'bg-slate-700'}`}
                                        >
                                            <span
                                                className={`absolute top-[3px] h-3.5 w-3.5 rounded-full transition-all ${
                                                    isRequired ? 'left-[17px] bg-white' : 'left-[3px] bg-slate-300'
                                                }`}
                                            />
                                        </span>
                                        Exigir
                                    </button>
                                    <details className="relative">
                                        <summary className="cursor-pointer list-none px-0.5 py-1 text-xs text-slate-400 hover:text-amber-400">
                                            Ajustar
                                        </summary>
                                        <div className="absolute right-0 top-9 z-10 flex w-[230px] flex-col gap-1.5 rounded-lg border border-slate-700 bg-surface p-2.5 shadow-xl">
                                            {copy.fields.map(field => (
                                                <label key={field.key} className="flex items-center justify-between gap-1.5 text-xs text-slate-300">
                                                    {field.label}
                                                    <input
                                                        type="number"
                                                        step={field.step ?? 1}
                                                        aria-label={field.aria}
                                                        value={params[field.key]}
                                                        onChange={e => onThreshold(field.key, Number(e.target.value))}
                                                        className="w-16 rounded border border-slate-700 bg-background px-1.5 py-1 text-right font-mono text-xs text-white"
                                                    />
                                                </label>
                                            ))}
                                            <small className="text-[11px] leading-snug text-slate-400">{copy.note}</small>
                                        </div>
                                    </details>
                                </div>
                            </div>
                        </li>
                    );
                })}
            </ol>

            <p role="status" className="mt-2.5 flex items-center gap-2.5 rounded-lg bg-slate-800 px-3 py-2 text-[13px] text-slate-200">
                <span className="font-mono text-lg font-bold text-amber-400">{int(resultCount)}</span>
                <span>
                    acciones responden <b className="text-white">{requiredText(required)}</b> · ordenadas por estrellas:
                    5★ cumple todo, cada pregunta no cumplida resta una.
                </span>
            </p>
        </section>
    );
}
