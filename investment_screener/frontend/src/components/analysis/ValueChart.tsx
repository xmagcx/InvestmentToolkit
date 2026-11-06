/**
 * ValueChart.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Nivel 2 · Entender (S6, S16): price line and fair-value line over time (inline SVG; recharts is not a dependency),
 *     shaded Sobrevalorada / Infravalorada areas with a text legend, labels of the current price and value,
 *     range buttons 1A / 3A / 5A / MÁX and an "Ocultar valoración" toggle. No fair-value history: price only plus a note.
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <ValueChart history={h} range="1y" onRangeChange={setRange} currency="USD" />
 */
import { useState } from 'react';
import type { ValueHistory, ValueHistoryRange } from '../../services/api';
import { fmtNumEs } from '../../utils/analysisFormat';

const RANGES: Array<[ValueHistoryRange, string]> = [['1y', '1A'], ['3y', '3A'], ['5y', '5A'], ['max', 'MÁX']];
const W = 640, H = 270, L = 36, R = 96, T = 14, B = 26;

interface Props { history: ValueHistory | null; range: ValueHistoryRange; onRangeChange: (r: ValueHistoryRange) => void; currency: string }

export function ValueChart({ history, range, onRangeChange, currency }: Props) {
    const [hideValue, setHideValue] = useState(false);
    const points = history?.points ?? [];
    const hasValue = points.some((p) => p.fair_value != null);
    const showValue = hasValue && !hideValue;

    const values = points.flatMap((p) => (showValue && p.fair_value != null ? [p.price, p.fair_value] : [p.price]));
    const min = Math.min(...values) * 0.97, max = Math.max(...values) * 1.03;
    const x = (i: number) => L + (points.length < 2 ? 0 : (i * (W - L - R)) / (points.length - 1));
    const y = (v: number) => T + ((max - v) / (max - min || 1)) * (H - T - B);

    const pricePath = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.price).toFixed(1)}`).join(' ');
    let valuePath = '';
    points.forEach((p, i) => {
        if (p.fair_value == null) return;
        valuePath += `${points[i - 1]?.fair_value == null ? 'M' : 'L'}${x(i).toFixed(1)} ${y(p.fair_value).toFixed(1)} `;
    });

    // shortcut: a segment is shaded by the sign of its average gap, so a crossing inside one segment is not split; upgrade if the series gets sparse.
    const areas = showValue ? points.slice(1).flatMap((b, k) => {
        const a = points[k];
        if (a.fair_value == null || b.fair_value == null) return [];
        const over = (a.price - a.fair_value + b.price - b.fair_value) > 0;
        const d = `M${x(k)} ${y(a.price)} L${x(k + 1)} ${y(b.price)} L${x(k + 1)} ${y(b.fair_value)} L${x(k)} ${y(a.fair_value)} Z`;
        return [{ d, over, key: k }];
    }) : [];

    const last = points[points.length - 1];
    const cur = history?.current;
    const priceNow = cur?.price ?? last?.price ?? null;
    const valueNow = cur?.fair_value ?? null;

    return (
        <section aria-label="Precio vs valor" className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
                <h3 className="text-lg font-semibold text-slate-100">Precio vs valor</h3>
                <div className="flex items-center gap-2">
                    {RANGES.map(([r, label]) => (
                        <button key={r} type="button" aria-pressed={range === r} onClick={() => onRangeChange(r)}
                            className={`rounded px-3 py-1.5 text-xs ${range === r ? 'bg-slate-700 text-white' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}>
                            {label}
                        </button>
                    ))}
                    <button type="button" aria-pressed={hideValue} disabled={!hasValue} onClick={() => setHideValue((h) => !h)}
                        className="rounded px-3 py-1.5 text-xs bg-zinc-800 text-zinc-300 hover:bg-zinc-700 disabled:opacity-50">
                        Ocultar valoración
                    </button>
                </div>
            </div>

            {points.length === 0 ? (
                <p className="text-slate-600 text-sm text-center py-10">Sin historial de precios</p>
            ) : (
                <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gráfico de precio y valor justo" className="w-full h-auto">
                    {areas.map((a) => <path key={a.key} d={a.d} className={a.over ? 'fill-red-500/20' : 'fill-emerald-500/20'} />)}
                    <path data-testid="price-line" d={pricePath} fill="none" className="stroke-slate-100" strokeWidth={2} />
                    {showValue && <path data-testid="value-line" d={valuePath} fill="none" className="stroke-amber-400" strokeWidth={2} strokeDasharray="5 3" />}
                    <text x={L} y={H - 8} className="fill-slate-400" fontSize={11}>{points[0].date}</text>
                    <text x={W - R} y={H - 8} textAnchor="end" className="fill-slate-400" fontSize={11}>{last.date}</text>
                    {priceNow != null && last && <text x={x(points.length - 1) + 6} y={y(last.price) + 4} className="fill-slate-100" fontSize={12}>{`Precio ${fmtNumEs(priceNow, 2)}`}</text>}
                    {showValue && valueNow != null && <text x={x(points.length - 1) + 6} y={y(valueNow) + 4} className="fill-amber-400" fontSize={12}>{`Valor ${fmtNumEs(valueNow, 2)}`}</text>}
                </svg>
            )}

            <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs text-slate-300">
                <span><span aria-hidden="true" className="text-slate-100">━</span> Precio ({currency})</span>
                {showValue && <span><span aria-hidden="true" className="text-amber-400">╍</span> Valor justo</span>}
                {showValue && <span><span aria-hidden="true" className="text-red-400">■</span> Sobrevalorada (precio sobre el valor)</span>}
                {showValue && <span><span aria-hidden="true" className="text-emerald-400">■</span> Infravalorada (precio bajo el valor)</span>}
            </div>
            {points.length > 0 && !hasValue && <p className="text-xs text-slate-400 mt-2">Sin historial de valoración</p>}
        </section>
    );
}
