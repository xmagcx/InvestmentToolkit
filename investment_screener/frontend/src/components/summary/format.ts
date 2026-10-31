/**
 * format.ts — Spanish money/percent formatting for the portfolio summary.
 *
 * Purpose:
 *     One place for the "15.268,14 USD" / "+6,05 %" shapes the summary page uses,
 *     so the hero, the KPIs and every profile card format identically. Zero-decimal
 *     currencies (CLP, JPY, KRW) are never shown with cents.
 *
 * Layer: Frontend / Components / Summary
 *
 * Key Functions:
 *     - fmtAmount() - number only, es-CL grouping
 *     - fmtMoney() - amount + currency code
 *     - fmtSigned() - amount + currency code with an explicit + / −
 *     - fmtPct() - percentage with 2 decimals and an explicit sign
 */
const ZERO_DECIMAL = new Set(['CLP', 'JPY', 'KRW', 'COP', 'PYG', 'ISK']);

const MASK = '••••';

export function fmtAmount(value: number, currency: string, isPrivacy = false): string {
    if (isPrivacy) return MASK;
    const decimals = ZERO_DECIMAL.has(currency.toUpperCase()) ? 0 : 2;
    return value.toLocaleString('es-CL', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtMoney(value: number | null | undefined, currency: string, isPrivacy = false): string {
    if (value == null) return '—';
    return `${fmtAmount(value, currency, isPrivacy)} ${currency.toUpperCase()}`;
}

export function fmtSigned(value: number | null | undefined, currency: string, isPrivacy = false): string {
    if (value == null) return '—';
    const sign = value < 0 ? '−' : '+';
    return `${sign}${fmtAmount(Math.abs(value), currency, isPrivacy)} ${currency.toUpperCase()}`;
}

export function fmtPct(value: number | null | undefined): string {
    if (value == null) return '—';
    const sign = value < 0 ? '−' : '+';
    return `${sign}${Math.abs(value).toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`;
}

/** Shared delta colour: positive emerald, negative red, zero/unknown slate. */
export function deltaClass(value: number | null | undefined): string {
    if (value == null || value === 0) return 'text-slate-400';
    return value > 0 ? 'text-emerald-400' : 'text-red-400';
}

/** "hace 5 min" / "hace 2 h" / fecha — the stamp next to the refresh button. */
export function timeAgo(iso: string | null | undefined, now: Date = new Date()): string {
    if (!iso) return 'sin registro';
    const then = new Date(iso);
    if (Number.isNaN(then.getTime())) return 'sin registro';
    const minutes = Math.round((now.getTime() - then.getTime()) / 60000);
    if (minutes < 1) return 'hace menos de 1 min';
    if (minutes < 60) return `hace ${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `hace ${hours} h`;
    return then.toLocaleDateString('es-CL');
}
