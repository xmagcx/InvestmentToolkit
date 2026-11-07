/**
 * geometry.ts
 *
 * Purpose: pure helpers of the Precio vs valor chart (S6b): nice-number axis ticks, non-overlapping axis tags,
 * x-axis ticks (months on short spans, years on long ones) and short Spanish dates.
 * Layer: Frontend / Components / Analysis / valueChart
 */

export const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];

const NICE = [1, 2, 2.5, 5];

/** Axis ticks on 1 / 2 / 2.5 / 5 x 10^k steps inside [lo, hi]: the smallest step that gives at most `max` ticks. */
export function niceTicks(lo: number, hi: number, max = 6): number[] {
    if (!(hi > lo)) return [lo];
    const exp0 = Math.floor(Math.log10((hi - lo) / max)) - 1;
    for (let k = 0; ; k++) {
        const step = NICE[k % NICE.length] * Math.pow(10, exp0 + Math.floor(k / NICE.length));
        const first = Math.ceil(lo / step - 1e-9), last = Math.floor(hi / step + 1e-9);
        if (last - first + 1 <= max) return Array.from({ length: last - first + 1 }, (_, i) => +((first + i) * step).toPrecision(12));
    }
}

/** Centres of axis tags pushed apart so neighbours are at least `gap` apart, kept inside [min, max]. Same order as the input. */
export function spreadTags(ys: number[], gap: number, min = -Infinity, max = Infinity): number[] {
    const order = ys.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]).map(([, i]) => i);
    const out = [...ys];
    order.forEach((i, k) => { out[i] = Math.max(out[i], k ? out[order[k - 1]] + gap : min); });
    for (let k = order.length - 1; k >= 0; k--) {
        const limit = k === order.length - 1 ? max : out[order[k + 1]] - gap;
        out[order[k]] = Math.min(out[order[k]], limit);
    }
    return out;
}

export interface TimeTick { i: number; label: string }

/** First point of each month (span up to ~13 months) or of each year (thinned to about 10 labels). */
export function timeTicks(dates: string[]): TimeTick[] {
    if (dates.length < 2) return [];
    const days = (Date.parse(dates[dates.length - 1]) - Date.parse(dates[0])) / 864e5;
    const monthly = days <= 400;
    const key = (d: string) => (monthly ? d.slice(0, 7) : d.slice(0, 4));
    const all: TimeTick[] = [];
    dates.forEach((d, i) => {
        if (i === 0 || key(d) !== key(dates[i - 1])) all.push({ i, label: monthly ? MONTHS_ES[Number(d.slice(5, 7)) - 1] : d.slice(0, 4) });
    });
    const every = monthly ? 1 : Math.max(1, Math.ceil(all.length / 10));
    return all.filter((_, k) => k % every === 0);
}

/** "15 jun 2026" from an ISO date. */
export const fmtDateEs = (iso: string): string => `${Number(iso.slice(8, 10))} ${MONTHS_ES[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
