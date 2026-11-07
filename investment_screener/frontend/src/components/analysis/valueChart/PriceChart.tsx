/**
 * PriceChart.tsx (React Presentation Component)
 *
 * Purpose:
 *     The plot of the Precio vs valor chart (S6b), inline SVG on the dark palette: price as a sky line over a soft area,
 *     SMA200 dotted and coloured per state (emerald under the mean = Infravalorada, red over it = Sobrevalorada) with a
 *     hatched band to the price, right axis with nice ticks and tags (price, mean, optional fair value), volume bars with
 *     the last-volume tag, month/year x ticks, optional support/resistance lines and the fair-value line, and a hover /
 *     keyboard crosshair with a tooltip. No animations (prefers-reduced-motion safe).
 * Layer: Frontend / Components / Analysis / valueChart
 * Usage Examples: <PriceChart points={view} cur={...} showSma showValue={false} showLevels={false} levels={h.levels} ... />
 */
import { useId, useState, type KeyboardEvent, type PointerEvent } from 'react';
import type { ValueHistory } from '../../../services/api';
import { fmtGroupedEs, fmtLevelEs, fmtNumEs, fmtSignedPctEs, fmtVolumeEs, levelsInRange, zoneRuns } from '../../../utils/analysisFormat';
import { fmtDateEs, niceTicks, spreadTags, timeTicks } from './geometry';

const W = 760, H = 380, L = 8, R = 76, T = 12, XAXIS = 22, VOL_SHARE = 0.18, GAP = 8, TAG_H = 16;
const PLOT_R = W - R, BOTTOM = H - XAXIS, VOL_TOP = BOTTOM - (BOTTOM - T) * VOL_SHARE, PRICE_BOTTOM = VOL_TOP - GAP;

type Pt = ValueHistory['points'][number];
export interface PriceChartProps {
    points: Pt[];
    /** Current values shown in the tags and the summary (the latest point's when the window ends earlier). */
    price: number | null; sma200: number | null; fairValue: number | null;
    showSma: boolean; showValue: boolean; showLevels: boolean;
    levels: ValueHistory['levels'] | undefined;
    ticker: string; currency: string; rangeLabel: string;
}

const f2 = (v: number) => fmtNumEs(v, 2);
const zoneOf = (p: Pt) => (p.sma200 == null ? null : p.price < p.sma200 ? 'Infravalorada' : p.price > p.sma200 ? 'Sobrevalorada' : null);

function Tag({ y, text, bg, testid }: { y: number; text: string; bg: string; testid: string }) {
    return (
        <g data-testid={testid} data-y={y.toFixed(1)}>
            <rect data-testid={`${testid}-bg`} x={PLOT_R + 2} y={y - TAG_H / 2} width={R - 6} height={TAG_H} rx={3} className={bg} />
            <text x={PLOT_R + 2 + (R - 6) / 2} y={y + 4} textAnchor="middle" fontSize={11} fontWeight={600} className="fill-white">{text}</text>
        </g>
    );
}

export function PriceChart(p: PriceChartProps) {
    const uid = useId().replace(/:/g, '');
    const [hover, setHover] = useState<number | null>(null);
    const { points } = p;
    const n = points.length;
    const hasSma = p.showSma && points.some((q) => q.sma200 != null);

    const raw = points.flatMap((q) => [q.price, ...(hasSma && q.sma200 != null ? [q.sma200] : []), ...(p.showValue && q.fair_value != null ? [q.fair_value] : [])]);
    const span = Math.max(...raw) - Math.min(...raw) || Math.max(...raw) * 0.02 || 1;
    const base = levelsInRange(p.showLevels ? p.levels : undefined, Math.min(...raw) - span * 0.06, Math.max(...raw) + span * 0.06);
    const { lo, hi } = base;
    const x = (i: number) => L + (n < 2 ? 0 : (i * (PLOT_R - L)) / (n - 1));
    const y = (v: number) => T + ((hi - v) / (hi - lo || 1)) * (PRICE_BOTTOM - T);
    const clampY = (v: number) => Math.min(PRICE_BOTTOM, Math.max(T + TAG_H / 2, v));
    const xy = ([i, v]: [number, number]) => `${x(i).toFixed(1)} ${y(v).toFixed(1)}`;
    const path = (get: (q: Pt) => number | null) => {
        let d = '';
        points.forEach((q, i) => { const v = get(q); if (v != null) d += `${d && get(points[i - 1]) != null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)} `; });
        return d;
    };
    const pricePath = path((q) => q.price);
    const areaPath = n > 1 ? `${pricePath}L${x(n - 1).toFixed(1)} ${PRICE_BOTTOM} L${x(0).toFixed(1)} ${PRICE_BOTTOM} Z` : '';
    const runs = hasSma ? zoneRuns(points) : [];
    const ticks = niceTicks(lo, hi);
    const allTicks = timeTicks(points.map((q) => q.date)).filter((t) => x(t.i) <= PLOT_R - 12);
    const xTicks = allTicks.length > 1 && x(allTicks[1].i) - x(allTicks[0].i) < 44 ? allTicks.slice(1) : allTicks;  // partial first period

    const volMax = Math.max(1, ...points.map((q) => q.volume ?? 0));
    const barW = Math.max(1, Math.min(6, ((PLOT_R - L) / Math.max(n, 1)) * 0.7));
    const lastVol = [...points].reverse().find((q) => q.volume != null)?.volume ?? null;

    const priceNow = p.price ?? points[n - 1]?.price ?? null;
    const under = priceNow != null && p.sma200 != null && priceNow < p.sma200;
    const tagSpec = [
        priceNow != null ? { k: 'price', v: priceNow, text: f2(priceNow), bg: 'fill-sky-700' } : null,
        hasSma && p.sma200 != null ? { k: 'sma', v: p.sma200, text: f2(p.sma200), bg: under ? 'fill-emerald-700' : 'fill-red-700' } : null,
        p.showValue && p.fairValue != null ? { k: 'value', v: p.fairValue, text: f2(p.fairValue), bg: 'fill-amber-700' } : null,
    ].filter((t): t is NonNullable<typeof t> => t != null);
    const tagYs = spreadTags(tagSpec.map((t) => clampY(y(t.v))), TAG_H + 2, T + TAG_H / 2, PRICE_BOTTOM);

    const levelLines = p.showLevels ? [
        ...base.supports.map((l) => ({ ...l, kind: 'Soporte', test: 'support-line', stroke: 'stroke-emerald-400', fill: 'fill-emerald-300' })),
        ...base.resistances.map((l) => ({ ...l, kind: 'Resistencia', test: 'resistance-line', stroke: 'stroke-red-400', fill: 'fill-red-300' })),
    ] : [];
    const levelYs = spreadTags(levelLines.map((l) => Math.round(y(l.price) - 3)), 13);

    const summary = `Gráfico de precio de ${p.ticker}, rango ${p.rangeLabel}: precio ${priceNow != null ? f2(priceNow) : '—'} ${p.currency}`
        + (hasSma && p.sma200 != null ? `, media de 200 días ${f2(p.sma200)}, ${under ? 'infravalorada' : priceNow != null && priceNow > p.sma200 ? 'sobrevalorada' : 'en su media'}` : ', sin media de 200 días');

    const moveTo = (clientX: number, el: HTMLElement) => {
        const r = el.getBoundingClientRect();
        if (!r.width || n < 1) return;
        setHover(Math.min(n - 1, Math.max(0, Math.round((((clientX - r.left) / r.width) * W - L) / (PLOT_R - L) * (n - 1)))));
    };
    const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
        const at = hover ?? n - 1;
        const next = e.key === 'ArrowLeft' ? at - 1 : e.key === 'ArrowRight' ? at + 1 : e.key === 'Home' ? 0 : e.key === 'End' ? n - 1 : null;
        if (e.key === 'Escape') { setHover(null); return; }
        if (next == null) return;
        e.preventDefault();
        setHover(Math.min(n - 1, Math.max(0, next)));
    };

    const hp = hover != null ? points[hover] : null;
    const hz = hp ? zoneOf(hp) : null;
    const diff = hp && hp.sma200 != null ? ((hp.price - hp.sma200) / hp.sma200) * 100 : null;

    return (
        <>
        <div role="group" aria-label="Gráfico de precio: use las flechas izquierda y derecha para ver cada fecha" tabIndex={0}
            className="relative rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
            onPointerMove={(e: PointerEvent<HTMLDivElement>) => moveTo(e.clientX, e.currentTarget)}
            onPointerDown={(e: PointerEvent<HTMLDivElement>) => moveTo(e.clientX, e.currentTarget)}
            onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)} onKeyDown={onKey}>
            <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={summary} className="w-full h-auto md:min-h-[320px] touch-pan-y select-none">
                <defs>
                    <linearGradient id={`${uid}-area`} x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0" stopColor="#38bdf8" stopOpacity={0.22} />
                        <stop offset="1" stopColor="#38bdf8" stopOpacity={0.02} />
                    </linearGradient>
                    {(['under', 'over'] as const).map((k) => (
                        <pattern key={k} id={`${uid}-hatch-${k}`} width={3.5} height={4} patternUnits="userSpaceOnUse">
                            <rect width={3.5} height={4} className={k === 'under' ? 'fill-emerald-400' : 'fill-red-400'} fillOpacity={0.1} />
                            <line x1={1} x2={1} y1={0} y2={4} className={k === 'under' ? 'stroke-emerald-400' : 'stroke-red-400'} strokeWidth={0.8} strokeOpacity={0.4} />
                        </pattern>
                    ))}
                </defs>

                {ticks.map((t) => (
                    <g key={t}>
                        <line x1={L} x2={PLOT_R} y1={y(t)} y2={y(t)} className="stroke-slate-800" strokeWidth={1} />
                        <text data-testid="y-tick" x={PLOT_R + 8} y={y(t) + 4} fontSize={11} className="fill-slate-400">{fmtGroupedEs(t, 2)}</text>
                    </g>
                ))}

                {areaPath && <path data-testid="price-area" d={areaPath} fill={`url(#${uid}-area)`} />}
                {runs.map((r, key) => (
                    <path key={key} data-zone={r.over ? 'sobrevalorada' : 'infravalorada'} fill={`url(#${uid}-hatch-${r.over ? 'over' : 'under'})`}
                        d={`M${r.price.map(xy).join(' L')} L${[...r.sma].reverse().map(xy).join(' L')} Z`} />
                ))}
                {levelLines.map((l, k) => (
                    <g key={`${l.kind}-${l.price}-${l.basis}`}>
                        <line data-testid={l.test} x1={L} x2={PLOT_R} y1={y(l.price)} y2={y(l.price)} className={l.stroke} strokeWidth={1} strokeDasharray="4 3" />
                        <text data-testid="level-tag" x={L + 4} y={levelYs[k]} className={l.fill} fontSize={10} stroke="#020617" strokeWidth={3} paintOrder="stroke">{`${l.kind} ${fmtLevelEs(l.price)}`}</text>
                    </g>
                ))}
                {p.showValue && <path data-testid="value-line" d={path((q) => q.fair_value)} fill="none" className="stroke-amber-400" strokeWidth={2} strokeDasharray="5 3" />}
                {runs.map((r, key) => (
                    <path key={key} data-testid="sma-line" data-state={r.over ? 'sobrevalorada' : 'infravalorada'} d={`M${r.sma.map(xy).join(' L')}`} fill="none"
                        className={r.over ? 'stroke-red-400' : 'stroke-emerald-400'} strokeWidth={2} strokeLinecap="round" strokeDasharray="1.5 4" />
                ))}
                <path data-testid="price-line" d={pricePath} fill="none" className="stroke-sky-400" strokeWidth={2} strokeLinejoin="round" />

                {points.map((q, i) => q.volume != null && (
                    <rect key={q.date} data-testid="volume-bar" x={x(i) - barW / 2} width={barW} y={BOTTOM - (q.volume / volMax) * (BOTTOM - VOL_TOP)}
                        height={(q.volume / volMax) * (BOTTOM - VOL_TOP)} className="fill-slate-600" fillOpacity={0.55} />
                ))}
                <line x1={L} x2={PLOT_R} y1={BOTTOM} y2={BOTTOM} className="stroke-slate-700" strokeWidth={1} />
                {xTicks.map((t) => <text key={t.i} data-testid="x-tick" x={x(t.i) < L + 14 ? L : x(t.i)} y={H - 6} textAnchor={x(t.i) < L + 14 ? 'start' : 'middle'} fontSize={11} className="fill-slate-400">{t.label}</text>)}

                {tagSpec.map((t, k) => <Tag key={t.k} testid={`${t.k}-tag`} y={tagYs[k]} text={t.text} bg={t.bg} />)}
                {lastVol != null && (
                    <g>
                        <rect x={PLOT_R + 2} y={BOTTOM - TAG_H - 2} width={R - 6} height={TAG_H} rx={3} className="fill-slate-950 stroke-slate-600" strokeWidth={1} />
                        <text data-testid="volume-tag" x={PLOT_R + 2 + (R - 6) / 2} y={BOTTOM - 7} textAnchor="middle" fontSize={11} fontWeight={600} className="fill-slate-200">{fmtVolumeEs(lastVol)}</text>
                    </g>
                )}

                {hover != null && hp && (
                    <g pointerEvents="none">
                        <line x1={x(hover)} x2={x(hover)} y1={T} y2={BOTTOM} className="stroke-slate-400" strokeWidth={1} strokeDasharray="3 3" />
                        <circle cx={x(hover)} cy={y(hp.price)} r={4} className="fill-sky-400 stroke-slate-950" strokeWidth={1.5} />
                        {hasSma && hp.sma200 != null && <circle cx={x(hover)} cy={y(hp.sma200)} r={3.5} className={`${hz === 'Infravalorada' ? 'fill-emerald-400' : 'fill-red-400'} stroke-slate-950`} strokeWidth={1.5} />}
                    </g>
                )}
            </svg>

            {hover != null && hp && (
                <div data-testid="crosshair-tooltip" role="status"
                    style={{ left: `${(x(hover) / W) * 100}%`, top: 8, transform: hover > n * 0.6 ? 'translateX(calc(-100% - 12px))' : 'translateX(12px)' }}
                    className="pointer-events-none absolute z-10 w-52 rounded-lg border border-slate-700 bg-slate-950/95 px-3 py-2 text-xs text-slate-200 shadow-xl">
                    <p className="mb-1 font-semibold text-slate-100">{fmtDateEs(hp.date)}</p>
                    <p className="flex justify-between"><span className="text-slate-400">Precio</span><span>{f2(hp.price)}</span></p>
                    <p className="flex justify-between"><span className="text-slate-400">Media 200 días</span><span>{hp.sma200 != null ? f2(hp.sma200) : '—'}</span></p>
                    <p className="flex justify-between"><span className="text-slate-400">Diferencia</span>
                        <span className={hz === 'Infravalorada' ? 'text-emerald-400' : hz === 'Sobrevalorada' ? 'text-red-400' : ''}>
                            {diff == null ? '—' : `${fmtSignedPctEs(diff)}${hz ? ` · ${hz}` : ''}`}
                        </span></p>
                </div>
            )}
        </div>
        {levelLines.length > 0 && (
            <ul aria-label="Soportes y resistencias" className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                {levelLines.map((l) => <li key={`li-${l.kind}-${l.price}-${l.basis}`} className={l.fill.replace('fill-', 'text-')}>{`${l.kind} ${fmtLevelEs(l.price)} · ${l.basis}`}</li>)}
            </ul>
        )}
        </>
    );
}
