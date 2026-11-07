/**
 * ValueChart.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Nivel 2 · Entender (S6, S16): the price as an area against its 200-day mean (SMA200, inline SVG; recharts is not a
 *     dependency). The area between them is Infravalorada (emerald, price under the mean) or Sobrevalorada (red, over it),
 *     cut at the interpolated crossing; supports (emerald dashed) and resistances (red dashed) from chart_levels.py are
 *     labelled horizontal lines; a reading line states the zone and its confirming level. Our projection fair value stays
 *     an optional amber line ("Ocultar valoración"). Range buttons 1A / 3A / 5A / MÁX. Under 200 sessions: price only plus a note.
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <ValueChart history={h} range="1y" onRangeChange={setRange} currency="USD" />
 */
import { useState } from 'react';
import type { ValueHistory, ValueHistoryRange } from '../../services/api';
import { fmtLevelEs, fmtNumEs, levelsInRange, valueReading, zoneRuns } from '../../utils/analysisFormat';
import { HelpTip } from './HelpTip';

const RANGES: Array<[ValueHistoryRange, string]> = [['1y', '1A'], ['3y', '3A'], ['5y', '5A'], ['max', 'MÁX']];
const W = 680, H = 270, L = 36, R = 136, T = 14, B = 26;

interface Props { history: ValueHistory | null; range: ValueHistoryRange; onRangeChange: (r: ValueHistoryRange) => void; currency: string }

/** Push right-edge labels apart so they stay readable: each at least 13px below the one before it. */
function spreadLabels(ys: number[]): number[] {
    const order = ys.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const out = [...ys];
    order.forEach(([, i], k) => { if (k && out[i] < out[order[k - 1][1]] + 13) out[i] = out[order[k - 1][1]] + 13; });
    return out;
}

export function ValueChart({ history, range, onRangeChange, currency }: Props) {
    const [hideValue, setHideValue] = useState(false);
    const points = history?.points ?? [];
    const cur = history?.current;
    const hasValue = points.some((p) => p.fair_value != null);
    const showValue = hasValue && !hideValue;
    const hasSma = points.some((p) => p.sma200 != null);

    const values = points.flatMap((p) => [p.price, ...(hasSma && p.sma200 != null ? [p.sma200] : []), ...(showValue && p.fair_value != null ? [p.fair_value] : [])]);
    const lv = levelsInRange(hasSma ? history?.levels : undefined, Math.min(...values) * 0.97, Math.max(...values) * 1.03);
    const { lo: min, hi: max } = lv;
    const x = (i: number) => L + (points.length < 2 ? 0 : (i * (W - L - R)) / (points.length - 1));
    const y = (v: number) => T + ((max - v) / (max - min || 1)) * (H - T - B);
    const xy = ([i, v]: [number, number]) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;

    const pricePath = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.price).toFixed(1)}`).join(' ');
    const linePath = (get: (p: ValueHistory['points'][number]) => number | null) => {
        let d = '';
        points.forEach((p, i) => { const v = get(p); if (v != null) d += `${d && get(points[i - 1]) != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; });
        return d;
    };
    const smaPath = hasSma ? linePath((p) => p.sma200) : '';
    const valuePath = linePath((p) => p.fair_value);
    const areas = hasSma ? zoneRuns(points).map((r, key) => ({
        key, over: r.over, d: `M${r.price.map(xy).join(' L')} L${[...r.sma].reverse().map(xy).join(' L')} Z`,
    })) : [];

    const last = points[points.length - 1];
    const priceNow = cur?.price ?? last?.price ?? null;
    const valueNow = cur?.fair_value ?? null;
    const smaNow = cur?.sma200 ?? null;
    const labelX = x(points.length - 1) + 6;
    const [priceY, smaY, valueY] = spreadLabels([
        last ? y(last.price) : 0, smaNow != null ? y(smaNow) : 1e6, valueNow != null ? y(valueNow) : 1e6,
    ]);
    const levelLines = [
        ...lv.supports.map((l) => ({ ...l, kind: 'Soporte', test: 'support-line', cls: 'stroke-emerald-400 fill-emerald-300' })),
        ...lv.resistances.map((l) => ({ ...l, kind: 'Resistencia', test: 'resistance-line', cls: 'stroke-red-400 fill-red-300' })),
    ];
    const tagYs = spreadLabels(levelLines.map((l) => Math.round(y(l.price) - 3)));
    const reading = valueReading(cur);
    const ctx = {
        company: history?.ticker ?? '', currency, price: priceNow, fairValue: valueNow, upside: null,
    };

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

            {reading && <p data-testid="value-reading" className="mb-2 text-sm text-slate-200">{reading}</p>}

            {points.length === 0 ? (
                <p className="text-slate-600 text-sm text-center py-10">Sin historial de precios</p>
            ) : (
                <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Gráfico de precio contra su media de 200 días" className="w-full h-auto">
                    {areas.map((a) => <path key={a.key} data-zone={a.over ? 'sobrevalorada' : 'infravalorada'} d={a.d} className={a.over ? 'fill-red-500/25' : 'fill-emerald-500/25'} />)}
                    {levelLines.map((l) => (
                        <g key={`${l.kind}-${l.price}-${l.basis}`}>
                            <line data-testid={l.test} x1={L} x2={W - R} y1={y(l.price)} y2={y(l.price)} className={l.cls.split(' ')[0]} strokeWidth={1} strokeDasharray="4 3" />
                            <text data-testid="level-tag" x={L + 4} y={tagYs[levelLines.indexOf(l)]} className={l.cls.split(' ')[1]} fontSize={10}>{`${l.kind} ${fmtLevelEs(l.price)}`}</text>
                        </g>
                    ))}
                    {hasSma && <path data-testid="sma-line" d={smaPath} fill="none" className="stroke-sky-300" strokeWidth={1.5} strokeDasharray="6 4" />}
                    <path data-testid="price-line" d={pricePath} fill="none" className="stroke-slate-100" strokeWidth={2} />
                    {showValue && <path data-testid="value-line" d={valuePath} fill="none" className="stroke-amber-400" strokeWidth={2} strokeDasharray="5 3" />}
                    <text x={L} y={H - 8} className="fill-slate-400" fontSize={11}>{points[0].date}</text>
                    <text x={W - R} y={H - 8} textAnchor="end" className="fill-slate-400" fontSize={11}>{last.date}</text>
                    {priceNow != null && last && <text x={labelX} y={priceY + 4} className="fill-slate-100" fontSize={12}>{`Precio ${fmtNumEs(priceNow, 2)}`}</text>}
                    {hasSma && smaNow != null && <text x={labelX} y={smaY + 4} className="fill-sky-300" fontSize={12}>{`Media 200 días ${fmtNumEs(smaNow, 2)}`}</text>}
                    {showValue && valueNow != null && <text x={labelX} y={valueY + 4} className="fill-amber-400" fontSize={12}>{`Valor ${fmtNumEs(valueNow, 2)}`}</text>}
                </svg>
            )}

            {levelLines.length > 0 && (
                <ul aria-label="Soportes y resistencias" className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                    {levelLines.map((l) => (
                        <li key={`li-${l.kind}-${l.price}-${l.basis}`} className={l.cls.split(' ')[1].replace('fill-', 'text-')}>{`${l.kind} ${fmtLevelEs(l.price)} · ${l.basis}`}</li>
                    ))}
                </ul>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-1 text-xs text-slate-300">
                <span><span aria-hidden="true" className="text-slate-100">━</span> Precio ({currency})</span>
                {hasSma && <span><span aria-hidden="true" className="text-sky-300">╍</span> Media 200 días<HelpTip term="sma200" ctx={{ ...ctx, value: smaNow }} /></span>}
                {hasSma && <span><span aria-hidden="true" className="text-red-400">■</span> Sobrevalorada (precio sobre su media)</span>}
                {hasSma && <span><span aria-hidden="true" className="text-emerald-400">■</span> Infravalorada (precio bajo su media)</span>}
                {hasSma && <span><span aria-hidden="true" className="text-emerald-400">╍</span> Soportes <span aria-hidden="true" className="text-red-400">╍</span> Resistencias<HelpTip term="levels" ctx={{ ...ctx, value: cur?.confirmation?.price ?? null }} /></span>}
                {showValue && <span><span aria-hidden="true" className="text-amber-400">╍</span> Valor justo</span>}
            </div>
            {points.length > 0 && !hasValue && <p className="text-xs text-slate-400 mt-2">Sin historial de valoración</p>}
        </section>
    );
}
