/**
 * SignalCard.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Nivel 2 · Entender (S5, S16): the signal chip (symbol + text + "?"), the Vender / Mantener / Comprar scale with a marker
 *     at the ticker's distance to fair value (±15% band = ACT_THRESHOLD_PCT), the four rules and the suspension note.
 *     The action comes from the recommendation entry; no entry means "Sin señal" with the reason.
 *
 * Layer: Frontend / Components / Analysis
 */
import type { RecommendationRecord } from '../../services/api';
import { fmtPctEs } from '../../utils/analysisFormat';
import { signalFor, type Signal } from '../../utils/signalLabel';
import { HelpTip } from './HelpTip';

const ACT_THRESHOLD_PCT = 15; // recommendation.py ACT_THRESHOLD_PCT
const SCALE_MAX = 30; // the scale shows ±30%; the marker pins at the edge beyond it

const CHIP: Record<Signal['tone'], string> = {
    buy: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30',
    sell: 'bg-red-500/10 text-red-400 border-red-500/30',
    hold: 'bg-sky-500/10 text-sky-400 border-sky-500/30',
    watch: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30',
    none: 'bg-zinc-500/10 text-zinc-300 border-zinc-500/30',
};

const RULES = [
    'Dentro de ±15% del valor justo: Mantener (En vigilancia si no la tienes).',
    'Precio 15% o más por debajo del valor justo: Comprar si no la tienes, Comprar más si ya la tienes.',
    'Precio 15% o más por encima del valor justo: Vender (reducir).',
    'Alerta de salida activada (tesis rota): Vender (todo).',
];

export function SignalCard({ rec, company }: { rec: RecommendationRecord | null; company: string }) {
    const signal = signalFor(rec?.action);
    const upside = rec?.upside_pct ?? null;
    const reason = rec ? rec.reason : 'No hay valoración guardada para este ticker, así que no hay distancia al valor ni señal.';
    const gate = rec?.review_gate?.withheld ? rec.review_gate.detail || rec.review_gate.why : rec?.flip_check?.held ? rec.flip_check.note : null;
    const left = upside == null ? null : (Math.max(-SCALE_MAX, Math.min(SCALE_MAX, upside)) + SCALE_MAX) / (2 * SCALE_MAX) * 100;
    const ctx = { company, value: null, price: rec?.price ?? null, fairValue: rec?.fair_value ?? null, upside };

    return (
        <section aria-label="Nivel 2 · Entender" className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3">Nivel 2 · Entender</p>
            <div className="flex items-center gap-2">
                <span data-testid="signal-chip" className={`inline-flex items-center gap-1.5 rounded border px-3 py-1 text-sm font-semibold ${CHIP[signal.tone]}`}>
                    <span aria-hidden="true">{signal.symbol}</span><span>{signal.label}</span>
                </span>
                <HelpTip term="signal" ctx={ctx} />
            </div>
            <p className="text-sm text-slate-300 mt-2">{reason}</p>
            {gate && <p role="status" className="text-xs text-amber-400 mt-1">Señal suspendida: {gate}</p>}

            <div data-testid="signal-scale" className="mt-6 mb-8">
                <div className="relative h-2 rounded bg-slate-800">
                    <div className="absolute inset-y-0 left-0 rounded-l bg-red-500/40" style={{ width: `${(SCALE_MAX - ACT_THRESHOLD_PCT) / (2 * SCALE_MAX) * 100}%` }} />
                    <div className="absolute inset-y-0 right-0 rounded-r bg-emerald-500/40" style={{ width: `${(SCALE_MAX - ACT_THRESHOLD_PCT) / (2 * SCALE_MAX) * 100}%` }} />
                    {left != null && (
                        <span data-testid="signal-marker" className="absolute -top-1 -translate-x-1/2 text-xs font-mono text-white" style={{ left: `${left}%` }}>
                            <span className="block h-4 w-1 mx-auto rounded bg-white" />
                            <span className="block mt-1 whitespace-nowrap">{fmtPctEs(upside)}</span>
                        </span>
                    )}
                </div>
                <div className="mt-8 flex justify-between text-xs text-slate-400">
                    <span>Vender</span><span>Mantener</span><span>Comprar</span>
                </div>
            </div>

            <ol className="list-decimal pl-5 space-y-1 text-sm text-slate-300">
                {RULES.map((r) => <li key={r}>{r}</li>)}
            </ol>
            <p className="text-xs text-slate-400 mt-3">
                La señal se suspende si la valoración tiene más de 30 días (hay que revalorar antes de actuar) o si hubo una compra hace menos de 30 días (no se vende) o una venta (no se compra).
            </p>
        </section>
    );
}
