/**
 * ValueChart.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Nivel 2 · Entender (S6, S6b, S16): price against its 200-day mean (SMA200) as in the SVI references, on the dark
 *     palette. This component owns the state and the chrome: the reading sentence (zone + confirming level), the legend
 *     "··· Infravalorada ··· Sobrevalorada" with the toggles "Ocultar media", "Ocultar valoración" (our projection fair
 *     value, amber) and "Niveles" (supports / resistances, off by default), the range pills YTD 1A 3A 5A 10A MÁX and the
 *     navigator window. The plot is valueChart/PriceChart.tsx, the mini history valueChart/Navigator.tsx.
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <ValueChart history={h} range="1y" onRangeChange={setRange} currency="USD" />
 */
import { useState } from 'react';
import type { ValueHistory, ValueHistoryRange } from '../../services/api';
import { valueReading } from '../../utils/analysisFormat';
import { HelpTip } from './HelpTip';
import { Navigator } from './valueChart/Navigator';
import { PriceChart } from './valueChart/PriceChart';

const RANGES: Array<[ValueHistoryRange, string]> = [['ytd', 'YTD'], ['1y', '1A'], ['3y', '3A'], ['5y', '5A'], ['10y', '10A'], ['max', 'MÁX']];

interface Props { history: ValueHistory | null; range: ValueHistoryRange; onRangeChange: (r: ValueHistoryRange) => void; currency: string }

const toggle = 'rounded-full px-3 py-1 text-xs border focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 disabled:opacity-50';
const toggleCls = (on: boolean) => `${toggle} ${on ? 'border-sky-500 bg-sky-900/40 text-sky-200' : 'border-slate-700 bg-slate-800 text-slate-300 hover:bg-slate-700'}`;

export function ValueChart({ history, range, onRangeChange, currency }: Props) {
    const [hideSma, setHideSma] = useState(false);
    const [hideValue, setHideValue] = useState(false);
    const [showLevels, setShowLevels] = useState(false);
    // The window belongs to the loaded history: a new load (range change) starts from the full range again.
    const [win, setWin] = useState<{ src: ValueHistory | null; s: number; e: number } | null>(null);

    const points = history?.points ?? [];
    const cur = history?.current;
    const n = points.length;
    const w = win && win.src === history && win.e < n ? win : null;
    const s = w?.s ?? 0, e = w?.e ?? Math.max(0, n - 1);
    const view = points.slice(s, e + 1);
    const atEnd = e === n - 1;

    const hasValue = points.some((p) => p.fair_value != null);
    const hasSma = points.some((p) => p.sma200 != null);
    const lastView = view[view.length - 1];
    const price = atEnd ? cur?.price ?? lastView?.price ?? null : lastView?.price ?? null;
    const sma = atEnd ? cur?.sma200 ?? null : lastView?.sma200 ?? null;
    const fair = atEnd ? cur?.fair_value ?? null : lastView?.fair_value ?? null;
    const reading = valueReading(cur);
    const ctx = { company: history?.ticker ?? '', currency, price, fairValue: cur?.fair_value ?? null, upside: null };
    const pick = (r: ValueHistoryRange) => { setWin(null); onRangeChange(r); };

    return (
        <section aria-label="Precio vs valor" className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h3 className="text-lg font-semibold text-slate-100">Precio vs valor</h3>
                <div className="flex flex-wrap items-center justify-end gap-x-4 gap-y-2 text-xs">
                    {hasSma && (
                        <>
                            <span className="text-emerald-400"><span aria-hidden="true">···</span> Infravalorada</span>
                            <span className="text-red-400"><span aria-hidden="true">···</span> Sobrevalorada</span>
                            <HelpTip term="sma200" ctx={{ ...ctx, value: cur?.sma200 ?? null }} />
                        </>
                    )}
                    {hasValue && !hideValue && <span className="text-amber-400"><span aria-hidden="true">╍</span> Valor justo</span>}
                    <button type="button" aria-pressed={hideSma} disabled={!hasSma} onClick={() => setHideSma((h) => !h)} className={toggleCls(hideSma)}>Ocultar media</button>
                    <button type="button" aria-pressed={hideValue} disabled={!hasValue} onClick={() => setHideValue((h) => !h)} className={toggleCls(hideValue)}>Ocultar valoración</button>
                    <span className="inline-flex items-center gap-1">
                        <button type="button" aria-pressed={showLevels} disabled={!hasSma} onClick={() => setShowLevels((l) => !l)} className={toggleCls(showLevels)}>Niveles</button>
                        <HelpTip term="levels" ctx={{ ...ctx, value: cur?.confirmation?.price ?? null }} />
                    </span>
                </div>
            </div>

            {reading && <p data-testid="value-reading" className="mb-2 text-sm text-slate-200">{reading}</p>}

            {n === 0 ? (
                <p className="text-slate-400 text-sm text-center py-10">Sin historial de precios</p>
            ) : (
                <PriceChart points={view} price={price} sma200={sma} fairValue={fair} showSma={!hideSma} showValue={hasValue && !hideValue}
                    showLevels={showLevels && hasSma} levels={history?.levels} ticker={history?.ticker ?? ''} currency={currency}
                    rangeLabel={RANGES.find(([r]) => r === range)?.[1] ?? range} />
            )}

            <div role="group" aria-label="Rango" className="mt-3 flex items-center justify-center gap-1">
                {RANGES.map(([r, label]) => (
                    <button key={r} type="button" aria-pressed={range === r} onClick={() => pick(r)}
                        className={`rounded-full px-3 py-1 text-sm font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400 ${range === r ? 'bg-sky-700 text-white' : 'text-slate-400 hover:text-slate-200'}`}>
                        {label}
                    </button>
                ))}
            </div>

            {n > 1 && <Navigator overview={history?.overview ?? []} dates={points.map((p) => p.date)} start={s} end={e} onChange={(a, b) => setWin({ src: history, s: a, e: b })} />}

            {n > 0 && !hasValue && <p className="text-xs text-slate-400 mt-2">Sin historial de valoración</p>}
        </section>
    );
}
