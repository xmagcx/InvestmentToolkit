/**
 * headerMetrics.ts
 *
 * Purpose: build the header-card metric list (S3) from the overview; a metric whose value is null is omitted, never invented.
 * Layer: Frontend / Components / Analysis. Key Functions: buildMetrics, marginOfSafety.
 */
import type { StockData } from '../../services/api';
import type { MetricKey } from '../../utils/metricState';
import { fmtNumEs, fmtPctEs } from '../../utils/analysisFormat';

export interface HeaderMetric { key: MetricKey; label: string; value: number; display: string }

/** (valor − precio) ÷ valor, in percent; null without a fair value or a price. */
export function marginOfSafety(fairValue: number | null, price: number | null | undefined): number | null {
    return fairValue && price != null ? ((fairValue - price) / fairValue) * 100 : null;
}

export function buildMetrics(stock: StockData, fairValue: number | null): HeaderMetric[] {
    const o = stock.overview;
    const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
    const rows: Array<[MetricKey, string, number | null, (v: number) => string]> = [
        ['mos', 'Margen de seguridad', marginOfSafety(fairValue, stock.price), (v) => fmtPctEs(v)],
        ['roic', 'ROIC', num(o?.profitability?.roic), (v) => fmtPctEs(v, 2)],
        ['roe', 'ROE', num(o?.profitability?.roe), (v) => fmtPctEs(v, 2)],
        ['roa', 'ROA', num(o?.profitability?.roa), (v) => fmtPctEs(v, 2)],
        ['fcfy', 'FCF Yield', num(o?.yields?.fcf_yield), (v) => fmtPctEs(v, 2)],
        ['divy', 'Rentabilidad por dividendo', num(o?.yields?.dividend_yield), (v) => fmtPctEs(v, 2)],
        ['buyback', 'Recompras', num(o?.yields?.buyback_yield), (v) => fmtPctEs(v, 2)],
        ['augdiv', 'Dividendo aumentado', num(o?.yields?.augmented_yield), (v) => fmtPctEs(v, 2)],
        ['beta', 'Beta', num(o?.cost_of_capital?.beta) ?? num(stock.metrics?.beta), (v) => fmtNumEs(v, 2)],
        ['de', 'Deuda/patrimonio', num(o?.balance?.debt_to_equity), (v) => fmtNumEs(v, 2)],
    ];
    return rows.flatMap(([key, label, value, fmt]) => (value == null ? [] : [{ key, label, value, display: fmt(value) }]));
}
