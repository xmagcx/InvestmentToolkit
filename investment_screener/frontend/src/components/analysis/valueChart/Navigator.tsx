/**
 * Navigator.tsx (React Presentation Component)
 *
 * Purpose:
 *     Mini area chart of the full history (`overview`) under the range pills (S6b). The visible window is highlighted and
 *     has two grab handles; dragging the window or an edge (pointer events) or pressing ArrowLeft / ArrowRight on a focused
 *     handle changes the visible window client-side. The window is limited to the loaded range's data (indices of `dates`);
 *     the overview line only gives context. Handles are focusable role="slider" buttons with the date as aria-valuetext.
 * Layer: Frontend / Components / Analysis / valueChart
 * Usage Examples: <Navigator overview={h.overview} dates={dates} start={s} end={e} onChange={(s, e) => ...} />
 */
import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { fmtDateEs } from './geometry';

interface Props {
    overview: Array<{ date: string; price: number }>;
    dates: string[];                       // dates of the loaded points; the window is [start, end] indices into it
    start: number; end: number;
    onChange: (start: number, end: number) => void;
}

const VB_W = 760, VB_H = 56, MIN_POINTS = 5;
type Mode = 'start' | 'end' | 'move';

export function Navigator({ overview, dates, start, end, onChange }: Props) {
    const n = dates.length;
    const minSpan = Math.min(MIN_POINTS - 1, n - 1);
    const t = (d: string) => Date.parse(d);
    const line = overview.length > 1 ? overview : dates.map((d) => ({ date: d, price: 0 }));
    const t0 = Math.min(t(line[0].date), t(dates[0])), t1 = Math.max(t(line[line.length - 1].date), t(dates[n - 1]));
    const frac = (d: string) => (t1 === t0 ? 0 : (t(d) - t0) / (t1 - t0));
    const prices = line.map((p) => p.price);
    const lo = Math.min(...prices), hi = Math.max(...prices);
    const px = (d: string) => frac(d) * VB_W;
    const py = (v: number) => 4 + (hi === lo ? 0.5 : (hi - v) / (hi - lo)) * (VB_H - 8);
    const linePath = line.map((p, i) => `${i ? 'L' : 'M'}${px(p.date).toFixed(1)} ${py(p.price).toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${px(line[line.length - 1].date).toFixed(1)} ${VB_H} L${px(line[0].date).toFixed(1)} ${VB_H} Z`;

    const idxAt = (time: number) => {  // nearest loaded point to a time
        let best = 0;
        for (let i = 1; i < n; i++) if (Math.abs(t(dates[i]) - time) < Math.abs(t(dates[best]) - time)) best = i;
        return best;
    };
    const set = (s: number, e: number) => {
        const ns = Math.max(0, Math.min(s, n - 1 - minSpan)), ne = Math.min(n - 1, Math.max(e, ns + minSpan));
        if (ns !== start || ne !== end) onChange(ns, Math.max(ne, ns + minSpan));
    };
    const step = Math.max(1, Math.round(n / 50));
    const onKey = (mode: 'start' | 'end') => (e: KeyboardEvent) => {
        const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
        if (!dir) return;
        e.preventDefault();
        if (mode === 'start') set(Math.min(start + dir * step, end - minSpan), end);
        else set(start, Math.max(end + dir * step, start + minSpan));
    };

    const box = useRef<HTMLDivElement>(null);
    const drag = useRef<{ mode: Mode; x0: number; s0: number; e0: number } | null>(null);
    const down = (mode: Mode) => (e: PointerEvent) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture?.(e.pointerId);
        drag.current = { mode, x0: e.clientX, s0: start, e0: end };
    };
    const move = (e: PointerEvent) => {
        const d = drag.current, w = box.current?.getBoundingClientRect().width;
        if (!d || !w) return;
        const dt = ((e.clientX - d.x0) / w) * (t1 - t0);
        if (d.mode === 'start') set(Math.min(idxAt(t(dates[d.s0]) + dt), d.e0 - minSpan), d.e0);
        else if (d.mode === 'end') set(d.s0, Math.max(idxAt(t(dates[d.e0]) + dt), d.s0 + minSpan));
        else {
            const s = Math.max(0, Math.min(idxAt(t(dates[d.s0]) + dt), n - 1 - (d.e0 - d.s0)));
            set(s, s + (d.e0 - d.s0));
        }
    };
    const up = () => { drag.current = null; };

    const left = frac(dates[start]) * 100, right = frac(dates[end]) * 100;
    const handle = (mode: 'start' | 'end', at: number, label: string, value: number) => (
        <button type="button" role="slider" aria-label={label} aria-orientation="horizontal" aria-valuemin={0} aria-valuemax={n - 1} aria-valuenow={value}
            aria-valuetext={fmtDateEs(dates[value])} onKeyDown={onKey(mode)} onPointerDown={down(mode)} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
            style={{ left: `${at}%` }}
            className="absolute top-0 z-10 h-full w-3 -translate-x-1/2 cursor-ew-resize touch-none rounded-sm border border-slate-500 bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
            <span aria-hidden="true" className="mx-auto block h-4 w-px bg-slate-700" />
        </button>
    );
    const years = [...new Set(line.map((p) => p.date.slice(0, 4)))];
    const every = Math.max(1, Math.ceil(years.length / 8));

    return (
        <div className="mx-auto mt-3 w-full">
            <div ref={box} className="relative h-14 overflow-hidden rounded-md bg-slate-800/60">
                <svg viewBox={`0 0 ${VB_W} ${VB_H}`} preserveAspectRatio="none" aria-hidden="true" className="absolute inset-0 h-full w-full">
                    <path d={areaPath} className="fill-slate-600" fillOpacity={0.35} />
                    <path data-testid="overview-line" d={linePath} fill="none" className="stroke-slate-300" strokeWidth={1.2} vectorEffect="non-scaling-stroke" />
                </svg>
                <div aria-hidden="true" className="absolute inset-y-0 left-0 bg-slate-950/60" style={{ width: `${left}%` }} />
                <div aria-hidden="true" className="absolute inset-y-0 right-0 bg-slate-950/60" style={{ width: `${100 - right}%` }} />
                <div aria-hidden="true" data-testid="nav-window" onPointerDown={down('move')} onPointerMove={move} onPointerUp={up} onPointerCancel={up}
                    className="absolute inset-y-0 cursor-grab touch-none border-y border-sky-400/70 bg-sky-400/10" style={{ left: `${left}%`, width: `${right - left}%` }} />
                {handle('start', left, 'Inicio de la ventana', start)}
                {handle('end', right, 'Fin de la ventana', end)}
            </div>
            <div aria-hidden="true" className="relative mt-1 h-4 text-[11px] text-slate-400">
                {years.filter((_, k) => k % every === 0).map((y) => (
                    <span key={y} className="absolute -translate-x-1/2" style={{ left: `${Math.min(97, Math.max(3, frac(`${y}-07-01`) * 100))}%` }}>{y}</span>
                ))}
            </div>
        </div>
    );
}
