/**
 * analysisFormat.ts
 *
 * Purpose: Spanish number formatting (decimal comma) for the Análisis page (null renders "—") and the Sankey
 * arithmetic of the Descripción tab (flow graph + "De cada $100…" reading) from income_quarter.
 * Layer: Frontend / Utils
 */
import type { ChartLevel, StockOverviewIncome, ValueHistory } from '../services/api';

export const fmtNumEs = (v: number, d = 1): string => v.toFixed(d).replace('.', ',');
export const fmtPctEs = (v: number | null | undefined, d = 1): string => (v == null ? '—' : `${fmtNumEs(v, d)}%`);
export const fmtMoneyEs = (v: number | null | undefined, currency = 'USD'): string =>
    v == null ? '—' : `${fmtNumEs(v, 2)} ${currency}`;

/** Compact market cap: M = 10^6, B = 10^9, T = 10^12. */
export function fmtCapEs(v: number | null | undefined, currency = 'USD'): string {
    if (v == null) return '—';
    const a = Math.abs(v);
    if (a >= 1e12) return `${fmtNumEs(v / 1e12, 2)} T ${currency}`;
    if (a >= 1e9) return `${fmtNumEs(v / 1e9, 1)} B ${currency}`;
    return `${fmtNumEs(v / 1e6, 0)} M ${currency}`;
}

/** Thousands with "." and decimals with ",": 1101.77 → "1.101,77". */
export function fmtGroupedEs(v: number, d = 0): string {
    const [int, dec] = Math.abs(v).toFixed(d).split('.');
    return `${v < 0 ? '-' : ''}${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${dec ? `,${dec}` : ''}`;
}
export const fmtMultEs = (v: number | null | undefined): string => (v == null ? '—' : `${fmtNumEs(v, 1)}x`);
export const fmtSignedPctEs = (v: number | null | undefined): string => (v == null ? '—' : `${v > 0 ? '+' : ''}${fmtNumEs(v, 1)}%`);

export type SankeyKind = 'income' | 'profit' | 'expense';
export interface SankeyNode { id: string; label: string; value: number; kind: SankeyKind; col: number }
export interface SankeyLink { from: string; to: string; value: number }
export interface SankeyGraph { nodes: SankeyNode[]; links: SankeyLink[] }

/**
 * Revenue → cost / gross profit → R&D, SG&A / operating income → tax / net income. Segments are null in the payload, so
 * the source is a single "Ingresos" node. Missing lines are skipped; every inner node equals the sum of its outflows
 * (a reported subtotal that the listed lines do not explain becomes an "Otros" expense node).
 */
export function buildSankey(income: StockOverviewIncome | null | undefined): SankeyGraph | null {
    const rev = income?.revenue;
    if (!income || rev == null || rev <= 0) return null;
    const eps = rev * 1e-6;
    const nodes: SankeyNode[] = [{ id: 'rev', label: 'Ingresos', value: rev, kind: 'income', col: 0 }];
    const links: SankeyLink[] = [];
    let cur: { id: string; value: number } | null = { id: 'rev', value: rev };
    let col = 0;
    type Exp = { id: string; label: string; value: number | null };
    const stage = (rem: { id: string; label: string; kind: SankeyKind }, exps: Exp[], reported: number | null, otherId: string) => {
        if (!cur) return;
        const used = exps.filter((e): e is Exp & { value: number } => e.value != null && e.value > 0);
        if (reported != null) {
            const gap = cur.value - reported - used.reduce((a, e) => a + e.value, 0);
            if (gap > eps) used.push({ id: otherId, label: 'Otros gastos', value: gap });
        }
        if (used.length === 0) return;
        const left = cur.value - used.reduce((a, e) => a + e.value, 0);
        col += 1;
        if (left <= eps) { cur = null; return; }
        nodes.push({ ...rem, value: left, col });
        links.push({ from: cur.id, to: rem.id, value: left });
        for (const e of used) {
            nodes.push({ id: e.id, label: e.label, value: e.value, kind: 'expense', col });
            links.push({ from: cur.id, to: e.id, value: e.value });
        }
        cur = { id: rem.id, value: left };
    };
    const cost = income.cost_of_revenue ?? (income.gross_profit != null ? rev - income.gross_profit : null);
    stage({ id: 'gp', label: 'Beneficio bruto', kind: 'profit' }, [{ id: 'cogs', label: 'Coste de ventas', value: cost }], null, 'cogs_other');
    stage({ id: 'op', label: 'Resultado operativo', kind: 'profit' },
        [{ id: 'rd', label: 'I+D', value: income.research_development }, { id: 'sga', label: 'Ventas y administración', value: income.sga }], income.operating_income, 'opex_other');
    stage({ id: 'ni', label: 'Beneficio neto', kind: 'profit' }, [{ id: 'tax', label: 'Impuestos', value: income.tax }], income.net_income, 'nonop_other');
    return nodes.length > 1 ? { nodes, links } : null;
}

/** "De cada $100 que factura, …": whole dollars per $100 of revenue; null when revenue, cost or net income is unknown. */
export function sankeyReading(company: string, income: StockOverviewIncome | null | undefined): string | null {
    const rev = income?.revenue;
    if (!income || rev == null || rev <= 0 || income.net_income == null) return null;
    const cost = income.cost_of_revenue ?? (income.gross_profit != null ? rev - income.gross_profit : null);
    if (cost == null) return null;
    const per100 = (v: number | null) => Math.round(((v ?? 0) / rev) * 100);
    return `De cada $100 que factura, ${company} gasta $${per100(cost)} en producir, $${per100((income.research_development ?? 0) + (income.sga ?? 0))} en I+D, ventas y administración y $${per100(income.tax)} en impuestos: le quedan $${per100(income.net_income)} de beneficio neto.`;
}

/** "$412" from 100 up, "$12,34" below: whole dollars are enough for a level on an expensive stock. */
export const fmtLevelEs = (v: number): string => `$${fmtNumEs(v, v >= 100 ? 0 : 2)}`;

/** Compact volume: 174,24M, 6,98M, 12,3K, 2,50B; under 1.000 the plain integer. */
export function fmtVolumeEs(v: number): string {
    if (v >= 1e9) return `${fmtNumEs(v / 1e9, 2)}B`;
    if (v >= 1e6) return `${fmtNumEs(v / 1e6, 2)}M`;
    if (v >= 1e3) return `${fmtNumEs(v / 1e3, 1)}K`;
    return String(Math.round(v));
}

export interface ZoneRun {
    over: boolean;
    /** Price and SMA200 boundaries as [fractional point index, value]; the ends at a crossing are interpolated. */
    price: Array<[number, number]>;
    sma: Array<[number, number]>;
}

/** Runs of consecutive points on one side of the SMA200; a segment that crosses it is cut at the interpolated crossing. */
export function zoneRuns(points: ValueHistory['points']): ZoneRun[] {
    const runs: ZoneRun[] = [];
    let open: ZoneRun | null = null;
    for (let k = 0; k + 1 < points.length; k++) {
        const a = points[k], b = points[k + 1];
        if (a.sma200 == null || b.sma200 == null) { open = null; continue; }
        const da = a.price - a.sma200, db = b.price - b.sma200;
        const piece = (over: boolean, from: [number, number, number], to: [number, number, number]) => {
            if (!open || open.over !== over) { open = { over, price: [], sma: [] }; runs.push(open); }
            const last = open.price[open.price.length - 1];
            if (!last || last[0] !== from[0]) { open.price.push([from[0], from[1]]); open.sma.push([from[0], from[2]]); }
            open.price.push([to[0], to[1]]); open.sma.push([to[0], to[2]]);
        };
        if (da * db < 0) {
            const t = da / (da - db), c = a.price + t * (b.price - a.price);
            piece(da > 0, [k, a.price, a.sma200], [k + t, c, c]);
            open = null;
            piece(db > 0, [k + t, c, c], [k + 1, b.price, b.sma200]);
        } else if (da + db !== 0) {
            piece(da + db > 0, [k, a.price, a.sma200], [k + 1, b.price, b.sma200]);
        } else { open = null; }
    }
    return runs;
}

const near = 5; // within this many percent a level is "cerca"

/** The one-line state above the price chart (S6): zone against the 200-day mean, confirmed by the nearest level. */
export function valueReading(cur: ValueHistory['current'] | undefined): string {
    if (!cur || cur.price == null) return '';
    if (cur.sma200 == null || cur.distance_pct == null) return 'Menos de 200 sesiones: sin media de 200 días.';
    if (cur.zone == null) return 'Precio en su media de 200 días.';
    const under = cur.zone === 'infravalorada';
    const head = `Precio ${fmtNumEs(Math.abs(cur.distance_pct))}% ${under ? 'bajo' : 'sobre'} su media de 200 días (${cur.zone})`;
    const c = cur.confirmation;
    if (!c) return `${head}, sin ${under ? 'un soporte' : 'una resistencia'} del gráfico ${under ? 'bajo' : 'sobre'} el precio.`;
    const detail = `${fmtLevelEs(c.price)} (${c.basis}, a ${fmtNumEs(Math.abs(c.distance_pct))}%)`;
    if (!under) return `${head}, próxima resistencia ${detail}.`;
    return `${head}, ${Math.abs(c.distance_pct) <= near ? 'cerca del soporte' : 'soporte más próximo'} ${detail}.`;
}

/** Levels that fit the plot: the nearest on each side may stretch the range by up to 10%, the rest are dropped if outside. */
export function levelsInRange(levels: ValueHistory['levels'] | undefined, lo: number, hi: number):
    { lo: number; hi: number; supports: ChartLevel[]; resistances: ChartLevel[] } {
    let [l, h] = [lo, hi];
    for (const side of [levels?.supports ?? [], levels?.resistances ?? []]) {
        const first = side[0];
        if (first && first.price < l && first.price >= l * 0.9) l = first.price;
        if (first && first.price > h && first.price <= h * 1.1) h = first.price;
    }
    const fit = (xs: ChartLevel[] | undefined) => (xs ?? []).filter((x) => x.price >= l && x.price <= h);
    return { lo: l, hi: h, supports: fit(levels?.supports), resistances: fit(levels?.resistances) };
}
