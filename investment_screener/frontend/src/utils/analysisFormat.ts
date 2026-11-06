/**
 * analysisFormat.ts
 *
 * Purpose: Spanish number formatting (decimal comma) for the Análisis page (null renders "—") and the Sankey
 * arithmetic of the Descripción tab (flow graph + "De cada $100…" reading) from income_quarter.
 * Layer: Frontend / Utils
 */
import type { StockOverviewIncome } from '../services/api';

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
