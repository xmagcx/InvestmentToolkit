/**
 * portfolioMath.ts - The pure maths and Spanish wording of the two-panel Portafolio page.
 *
 * Purpose:
 *     Bar scaling (weight and risk share one 0-40 % scale), the Alto/Medio/Bajo verdicts and the
 *     plain-Spanish basis for each risk figure, the holding gain (price minus average cost), the
 *     one-sentence insight, and Spanish number formatting. No React, no fetching. The risk numbers
 *     themselves come from the backend (GET /api/portfolio/risk); this file only compares and words them.
 *     Verdicts compare a holding against the owner's other holdings with history, never the market.
 *
 * Layer: Frontend / Components / Portfolio
 *
 * Usage Examples:
 *     barWidthPct(36.5);  riskCards(row, risk.medians);  holdingGain(tableRow);  insightSentence(risk.rows);
 *
 * Key Functions (Index):
 *     - esNum(), esNumMax(), esPct(), esUsd(): Spanish number text (1.234,50; unicode minus)
 *     - barWidthPct(): 0-40 % scale to a 0-100 bar width
 *     - volatilityVerdict(), drawdownVerdict(), contributionVerdict(): level plus the multiple reported
 *     - riskCards(): the three Riesgo figures with value, level and basis
 *     - holdingGain(), portfolioGain(): price minus average cost, in USD and %
 *     - liveWeights(): value held rows at the live price, weigh against holdings plus cash (the one weight)
 *     - nameLine(): the company name only when it exists and differs from the ticker
 *     - insightSentence(): largest holding's share of the money versus its share of the risk
 *
 * Key Input Dependencies:
 *     - services/api (RiskRow type), positions/columns (TableRow type only)
 *
 * Key Output Dependencies:
 *     - portfolio/cells.tsx, RiskPanel.tsx, ImprovePanel.tsx, pages/PortfolioPage.tsx, positions/columns.ts
 */
import type { RiskRow } from '../../services/api';
import type { TableRow } from '../positions/columns';

/** Weight and risk bars share this scale: a 40 % bar is full width. */
export const BAR_SCALE_MAX = 40;

export type Level = 'Alto' | 'Medio' | 'Bajo';
export interface Verdict { level: Level; multiple: number }

/** Alto at or above `high` times the reference, Bajo below `low` times it, Medio between. */
const THRESHOLDS = {
    volatility: { high: 1.5, low: 0.8 },
    drawdown: { high: 1.25, low: 0.75 },
    contribution: { high: 1.25, low: 0.75 },
} as const;

const MINUS = '\u2212';

/** A number as Spanish text: "." thousands, "," decimals, a real minus sign. */
export function esNum(value: number, digits: number): string {
    // The epsilon rounds 68.85 (stored as 68.8499…) up to 68.9, as a person would.
    const fixed = (Math.round(Math.abs(value) * 10 ** digits + 1e-9) / 10 ** digits).toFixed(digits);
    const [int, dec] = fixed.split('.');
    const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    const text = dec ? `${grouped},${dec}` : grouped;
    return value < 0 && Number(fixed) !== 0 ? `${MINUS}${text}` : text;
}

/** Like esNum but drops trailing zeros (share counts: 1,2 not 1,2000). */
export function esNumMax(value: number, maxDigits: number): string {
    const text = esNum(value, maxDigits);
    return text.includes(',') ? text.replace(/0+$/, '').replace(/,$/, '') : text;
}

export const esPct = (value: number, digits = 1): string => `${esNum(value, digits)} %`;

/** Dollar text, masked in privacy mode. */
export const esUsd = (value: number, hidden: boolean, digits = 0): string => (hidden ? '••••' : esNum(value, digits));

/** Width (0-100) of a bar for a percentage on the shared 0-40 % scale; unknown is empty. */
export function barWidthPct(pct: number | null | undefined): number {
    if (pct == null || !Number.isFinite(pct)) return 0;
    return Math.min(100, Math.max(0, (pct / BAR_SCALE_MAX) * 100));
}

function verdict(multiple: number, t: { high: number; low: number }): Verdict {
    const m = Math.round(multiple * 1e6) / 1e6;
    return { level: m >= t.high ? 'Alto' : m < t.low ? 'Bajo' : 'Medio', multiple };
}

const usable = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** Yearly movement as a multiple of the portfolio median. */
export function volatilityVerdict(vol: number | null | undefined, median: number | null | undefined): Verdict | null {
    if (!usable(vol) || !usable(median) || median <= 0) return null;
    return verdict(vol / median, THRESHOLDS.volatility);
}

/** Worst 3-year fall as a multiple of the median fall (both negative). */
export function drawdownVerdict(dd: number | null | undefined, median: number | null | undefined): Verdict | null {
    if (!usable(dd) || !usable(median) || median >= 0) return null;
    return verdict(dd / median, THRESHOLDS.drawdown);
}

/** Risk contribution as a multiple of the holding's weight (both in %). */
export function contributionVerdict(contribution: number | null | undefined, weight: number | null | undefined): Verdict | null {
    if (!usable(contribution) || !usable(weight) || weight <= 0) return null;
    return verdict(contribution / weight, THRESHOLDS.contribution);
}

export interface RiskCard { title: string; value: string; level: Level | null; basis: string }

const NO_MEDIAN = 'Sin otras posiciones con historia para comparar';

/** The three Riesgo figures of one holding, each with its verdict and the basis in plain Spanish. */
export function riskCards(
    row: RiskRow, medians: { volatility_ann: number | null; max_drawdown_3y: number | null },
): [RiskCard, RiskCard, RiskCard] {
    const vol = volatilityVerdict(row.volatility_ann, medians.volatility_ann);
    const dd = drawdownVerdict(row.max_drawdown_3y, medians.max_drawdown_3y);
    const contribution = contributionVerdict(row.risk_contribution_pct, row.weight_pct);
    const contributionTail = contribution?.level === 'Alto' ? ': aporta más riesgo que dinero'
        : contribution?.level === 'Bajo' ? ': aporta menos riesgo que dinero' : ': riesgo en línea con su dinero';
    return [
        { title: 'Cuánto se mueve al año', level: vol?.level ?? null,
          value: usable(row.volatility_ann) ? esPct(row.volatility_ann * 100) : '—',
          basis: vol ? `${esNum(vol.multiple, 1)}× la mediana de tu cartera (${esPct(medians.volatility_ann! * 100)})` : NO_MEDIAN },
        { title: 'Peor caída en 3 años', level: dd?.level ?? null,
          value: usable(row.max_drawdown_3y) ? esPct(row.max_drawdown_3y * 100) : '—',
          basis: dd ? `Tu mediana cayó ${esPct(medians.max_drawdown_3y! * 100)} en el mismo periodo` : NO_MEDIAN },
        { title: 'Cuánto riesgo aporta', level: contribution?.level ?? null,
          value: usable(row.risk_contribution_pct) ? esPct(row.risk_contribution_pct) : '—',
          basis: contribution ? `${esNum(contribution.multiple, 1)}× su peso (${esPct(row.weight_pct)})${contributionTail}` : NO_MEDIAN },
    ];
}

export interface Gain { amount: number; pct: number; cost: number }

type GainRow = Pick<TableRow, 'shares' | 'averageCost' | 'livePrice' | 'currentPrice'>;

/** Price minus average cost, times shares. Not the valuation gap (fair value minus price). */
export function holdingGain(row: GainRow): Gain | null {
    const price = row.livePrice ?? row.currentPrice;
    if (!(row.shares > 0) || row.averageCost == null || row.averageCost <= 0 || price == null) return null;
    const cost = row.averageCost * row.shares;
    const amount = price * row.shares - cost;
    return { amount, pct: (amount / cost) * 100, cost };
}

/** The gain of every held row added together; null when no held row has a cost. */
export function portfolioGain(rows: GainRow[]): Gain | null {
    let amount = 0;
    let cost = 0;
    for (const row of rows) {
        const g = holdingGain(row);
        if (g) { amount += g.amount; cost += g.cost; }
    }
    return cost > 0 ? { amount, cost, pct: (amount / cost) * 100 } : null;
}

/** One sentence: the largest holding's share of the money against its share of the risk. */
export function insightSentence(rows: RiskRow[]): string | null {
    const top = rows.reduce<RiskRow | null>((best, r) => (best == null || r.weight_pct > best.weight_pct ? r : best), null);
    if (!top) return null;
    const money = `${top.ticker} es ${esPct(top.weight_pct)} de tu dinero`;
    return usable(top.risk_contribution_pct) ? `${money} y ${esPct(top.risk_contribution_pct)} del riesgo.` : `${money}.`;
}

type LiveRow = GainRow & { held: boolean; marketValue: number | null; actualPct: number | null };

/**
 * The page's one valuation: each held row is shares x live price (stored value only when no price), and every
 * weight is that value over holdings plus cash. Not held rows are returned untouched.
 */
export function liveWeights<T extends LiveRow>(rows: T[], cashUsd: number): { rows: T[]; holdingsUsd: number; totalUsd: number } {
    const value = (r: T): number | null => {
        const price = r.livePrice ?? r.currentPrice;
        return r.shares > 0 && price != null ? r.shares * price : r.marketValue;
    };
    const holdingsUsd = rows.reduce((s, r) => s + (r.held ? value(r) ?? 0 : 0), 0);
    const totalUsd = holdingsUsd + cashUsd;
    return {
        holdingsUsd, totalUsd,
        rows: rows.map(r => {
            if (!r.held) return r;
            const v = value(r);
            return { ...r, marketValue: v, actualPct: v != null && totalUsd > 0 ? (v / totalUsd) * 100 : r.actualPct };
        }),
    };
}

/** The company name for the second line, or '' when it is missing or only repeats the ticker. */
export function nameLine(row: { ticker: string; name?: string | null }): string {
    const name = row.name?.trim() ?? '';
    return name && name.toLowerCase() !== row.ticker.toLowerCase() ? name : '';
}
