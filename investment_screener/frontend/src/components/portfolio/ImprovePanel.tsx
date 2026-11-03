/**
 * ImprovePanel.tsx - "Mejorar la cartera": pick a goal, see the suggested orders, decide yourself.
 *
 * Purpose:
 *     A three-step indicator and three selectable cards in plain language. Choosing one calls
 *     POST /api/portfolio/optimize (slow: it downloads three years of prices), shows a loading state,
 *     then the order list with the before/after effect on portfolio volatility and on the largest risk
 *     contributor, plus the backend's warnings. The target weights are handed to the page so the table
 *     can show them beside each row. Nothing is ever executed; these are suggestions. The technical
 *     method names appear only inside the "Cómo se calcula" collapsible.
 *
 * Layer: Frontend / Components / Portfolio
 *
 * Usage Examples:
 *     <ImprovePanel hidden={isPrivacyMode} onResult={setOptimization} />
 *
 * Key Functions (Index):
 *     - ImprovePanel(): steps, option cards, loading and error states
 *     - OrderResult(): orders, effect and warnings of one OptimizeResponse
 *
 * Key Input Dependencies:
 *     - services/api (optimizePortfolio, OptimizeResponse), portfolioMath.ts
 *
 * Key Output Dependencies:
 *     - pages/PortfolioPage.tsx
 */
import { useRef, useState, type ReactNode } from 'react';
import { optimizePortfolio, type OptimizeObjective, type OptimizeResponse } from '../../services/api';
import { esNumMax, esPct, esUsd } from './portfolioMath';

interface Option { objective: OptimizeObjective; title: string; hint: string; viz: ReactNode }

const STROKE_DIM = '#334155';
const STROKE_LIT = '#cbd5e1';

const OPTIONS: Option[] = [
    { objective: 'min_volatility', title: 'Que se mueva menos', hint: 'Menos sustos, menos sube y baja', viz: (
        <>
            <path d="M2 30 C 22 30, 26 4, 36 4 C 46 4, 50 30, 70 30" fill="none" stroke={STROKE_DIM} strokeWidth="2" />
            <path d="M52 30 C 74 30, 78 14, 88 14 C 98 14, 102 30, 118 30" fill="none" stroke={STROKE_LIT} strokeWidth="2" />
        </>) },
    { objective: 'risk_parity', title: 'Que no dependa de una sola', hint: 'Reparte el riesgo entre todas', viz: (
        <>
            <rect x="2" y="4" width="14" height="26" fill={STROKE_DIM} /><rect x="20" y="20" width="14" height="10" fill={STROKE_DIM} />
            <rect x="38" y="24" width="14" height="6" fill={STROKE_DIM} />
            <rect x="70" y="16" width="14" height="14" fill={STROKE_LIT} /><rect x="88" y="16" width="14" height="14" fill={STROKE_LIT} />
            <rect x="106" y="16" width="12" height="14" fill={STROKE_LIT} />
        </>) },
    { objective: 'max_sharpe', title: 'Que rinda más por el riesgo que corres', hint: 'Mismo riesgo, mejor retorno esperado', viz: (
        <>
            <line x1="2" y1="30" x2="118" y2="30" stroke={STROKE_DIM} strokeWidth="2" />
            <path d="M6 28 L 40 22 L 74 14 L 112 5" fill="none" stroke={STROKE_LIT} strokeWidth="2" />
            <path d="M104 4 L 114 4 L 114 14" fill="none" stroke={STROKE_LIT} strokeWidth="2" />
        </>) },
];

const STEPS = ['Elige qué mejorar', 'Mira las órdenes', 'Decides tú'];

const pct = (v: number | null | undefined) => (v == null ? '—' : esPct(v * 100));

/** The before/after sentence; says "Riesgo de X" when the biggest contributor is the same holding. */
function effectText(r: OptimizeResponse, hidden: boolean): string {
    const { effect } = r;
    const b = effect.top_risk_before;
    const a = effect.top_risk_after;
    const top = !b || !a ? '' : b.ticker === a.ticker
        ? ` Riesgo de ${b.ticker} ${esPct(b.pct)} → ${esPct(a.pct)} (simulado).`
        : ` Mayor riesgo: ${b.ticker} ${esPct(b.pct)} → ${a.ticker} ${esPct(a.pct)} (simulado).`;
    const cash = r.cash_after_usd == null ? '' : ` La caja pasa a ${esUsd(r.cash_after_usd, hidden)} USD.`;
    return `Volatilidad de la cartera ${pct(effect.volatility_before)} → ${pct(effect.volatility_after)} (simulado).${top}${cash}`;
}

/** The suggested orders, their effect and the backend's warnings. Read-only. */
export function OrderResult({ result, hidden }: { result: OptimizeResponse; hidden: boolean }) {
    return (
        <div className="mt-4 rounded-lg border border-dashed border-slate-400 p-3.5">
            <span className="inline-block rounded border border-dashed border-slate-400 px-2 py-0.5 text-[11px] font-bold uppercase tracking-widest text-slate-300">Simulación</span>
            {result.orders.length === 0
                ? <p className="my-2 text-xs text-slate-400">Tu cartera ya está cerca de este objetivo: no hay órdenes que sugerir.</p>
                : (
                    <>
                        <p className="my-2 text-xs leading-relaxed text-slate-400">
                            {`${result.orders.length === 1 ? 'Una orden' : `${result.orders.length} órdenes`} para pasar de donde estás a donde quieres. No se ejecuta nada: tú decides.`}
                        </p>
                        <ul className="m-0 list-none p-0 text-sm text-slate-100">
                            {result.orders.map(o => (
                                <li key={`${o.action}-${o.ticker}`} className="border-b border-slate-800 py-1.5">
                                    {`${o.action === 'SELL' ? 'Vender' : 'Comprar'} ${esNumMax(o.shares, 4)} de ${o.ticker} · `}
                                    <span className="font-mono">{`${esUsd(o.amount_usd, hidden)} USD`}</span>
                                </li>
                            ))}
                        </ul>
                    </>
                )}
            <p data-testid="effect" className="mt-3 text-sm leading-normal text-slate-100">{effectText(result, hidden)}</p>
            {result.warnings.length > 0 && (
                <ul className="mt-3 list-disc pl-5 text-xs leading-relaxed text-amber-300">
                    {result.warnings.map(w => <li key={w}>{w}</li>)}
                </ul>
            )}
        </div>
    );
}

interface ImprovePanelProps {
    hidden: boolean;
    /** Receives the response (for the target weights beside each row), or null when cleared. */
    onResult: (result: OptimizeResponse | null) => void;
}

export function ImprovePanel({ hidden, onResult }: ImprovePanelProps) {
    const [objective, setObjective] = useState<OptimizeObjective | null>(null);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<OptimizeResponse | null>(null);
    const [error, setError] = useState<string | null>(null);
    const latest = useRef(0);

    const choose = async (next: OptimizeObjective) => {
        const mine = ++latest.current;
        setObjective(next); setLoading(true); setError(null); setResult(null); onResult(null);
        try {
            const response = await optimizePortfolio(next);
            if (mine !== latest.current) return;
            setResult(response); onResult(response);
        } catch (e) {
            if (mine !== latest.current) return;
            setError(e instanceof Error ? e.message : 'No se pudo calcular');
            onResult(null);
        } finally {
            if (mine === latest.current) setLoading(false);
        }
    };

    const current = result ? 2 : loading ? 1 : 0;
    return (
        <section aria-label="Mejorar la cartera">
            <h2 className="m-0 text-lg font-semibold text-slate-100">Mejorar la cartera</h2>
            <p className="mb-2 text-xs text-slate-400">Solo necesita precios, no valoraciones.</p>
            <ol aria-label="Pasos" className="mb-3.5 flex list-none items-center gap-3 p-0 text-xs text-slate-400">
                {STEPS.map((label, i) => (
                    <li key={label} aria-current={i === current ? 'step' : undefined}
                        className={`flex items-center gap-1.5 ${i === current ? 'font-semibold text-slate-100' : ''}`}>
                        <span className={`inline-flex h-[18px] w-[18px] items-center justify-center rounded-full border text-[11px] font-bold ${i === current ? 'border-slate-200 bg-slate-200 text-slate-950' : 'border-slate-700 text-slate-300'}`}>{i + 1}</span>
                        {label}
                    </li>
                ))}
            </ol>
            <fieldset className="m-0 grid grid-cols-3 gap-2 border-0 p-0">
                <legend className="sr-only">Qué quieres mejorar</legend>
                {OPTIONS.map(o => (
                    <label key={o.objective}
                        className={`relative block min-h-[44px] cursor-pointer rounded-lg border bg-slate-900/50 p-3 hover:border-slate-700 focus-within:outline focus-within:outline-2 focus-within:outline-amber-500 ${objective === o.objective ? 'border-slate-200 bg-slate-200/5' : 'border-slate-800'}`}>
                        <input type="radio" name="mejorar" value={o.objective} checked={objective === o.objective}
                            onChange={() => { void choose(o.objective); }} className="absolute h-px w-px opacity-0" />
                        <svg className="mb-2 block" width="100%" height="34" viewBox="0 0 120 34" aria-hidden="true">{o.viz}</svg>
                        <b className="block text-sm leading-snug text-slate-100">{o.title}</b>
                        <span className="mt-0.5 block text-xs leading-snug text-slate-400">{o.hint}</span>
                    </label>
                ))}
            </fieldset>
            {loading && <p role="status" className="mt-4 text-sm text-slate-300">Calculando con 3 años de precios… puede tardar un minuto.</p>}
            {error && <p role="alert" className="mt-4 rounded bg-red-900/30 px-3 py-2 text-sm text-red-300">{`No se pudo calcular: ${error}`}</p>}
            <div aria-live="polite">{result && <OrderResult result={result} hidden={hidden} />}</div>
            <details className="mt-4 border-t border-slate-800 pt-1">
                <summary className="flex min-h-[44px] cursor-pointer items-center text-[13px] font-semibold text-slate-400 hover:text-slate-200">Cómo se calcula</summary>
                <p className="mb-2 text-xs leading-relaxed text-slate-400">
                    Sobre los precios de los últimos 3 años. «Que se mueva menos» es mínima volatilidad, «que no dependa de una sola»
                    es paridad de riesgo (HRP) y «que rinda más por el riesgo» es máximo Sharpe. Las dos primeras no necesitan ninguna
                    valoración, solo precios.
                </p>
            </details>
        </section>
    );
}
