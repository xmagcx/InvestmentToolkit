/**
 * analysisFormat.ts
 *
 * Purpose: Spanish number formatting (decimal comma) for the Análisis page. null renders "—".
 * Layer: Frontend / Utils
 */
export const fmtNumEs = (v: number, d = 1): string => v.toFixed(d).replace('.', ',');
export const fmtPctEs = (v: number | null | undefined, d = 1): string => (v == null ? '—' : `${fmtNumEs(v, d)}%`);
export const fmtMoneyEs = (v: number | null | undefined, currency = 'USD'): string =>
    v == null ? '—' : `${fmtNumEs(v, 2)} ${currency}`;

/** Compact market cap: M = 10^6, B = 10^9, T = 10^12. */
export function fmtCapEs(v: number | null | undefined, currency = 'USD'): string {
    if (v == null) return '—';
    if (v >= 1e12) return `${fmtNumEs(v / 1e12, 2)} T ${currency}`;
    if (v >= 1e9) return `${fmtNumEs(v / 1e9, 1)} B ${currency}`;
    return `${fmtNumEs(v / 1e6, 0)} M ${currency}`;
}
