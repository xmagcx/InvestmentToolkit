/**
 * columns.ts - The one column registry for every ticker table in the web app.
 *
 * Purpose:
 *     Each column is defined once here: label, help text, width, how it sorts, which cell
 *     renders it and how its cell is shaded. Screens never declare their own columns; they pick
 *     ids from this registry through a preset (presets.ts). Weight, stance and valuation values
 *     all come from the same shared sources: the position row (database read model), the extras
 *     (live heatmap price, sector, % changes, earnings; saved projection), the shared
 *     recommendation (stanceOf, risk_reward) and the privacy setting. Add or change a column
 *     here and every table that uses it changes.
 *
 * Layer: Frontend / Components / Positions
 *
 * Usage Examples:
 *     const col = COLUMNS_BY_ID['actualPct'];  col.cell(row, { rec, hidden: false });
 *
 * Key Functions (Index):
 *     - COLUMNS / COLUMNS_BY_ID: the registry
 *     - TableRow: a position row plus the optional extras
 *
 * Key Input Dependencies:
 *     - cells.tsx, RiskRewardCell, extras.ts, utils/riskReward, utils/priceChangePeriods,
 *       utils/formatters (colour ladders, formats), positionMath
 *
 * Key Output Dependencies:
 *     - PositionsTable, presets.ts
 */
import { createElement, type ReactNode } from 'react';
import type { RecommendationRecord } from '../../services/api';
import { changeBgDaily, changeBgUpside, fmtDollar, fmtPct, fmtPrice, safeNum } from '../../utils/formatters';
import { PORTFOLIO_PERIODS } from '../../utils/priceChangePeriods';
import { getActionPriority } from '../../utils/actionColors';
import { RISK_REWARD_COLUMNS, actedOn, fairValueGap, riskRewardRowFields, stanceOf } from '../../utils/riskReward';
import { RiskRewardCell } from '../RiskRewardCell';
import { GainCell, ValueCell, WeightRiskCell } from '../portfolio/cells';
import { esNum, esPct, holdingGain } from '../portfolio/portfolioMath';
import { ActionCell, EarningsCell, MonoCell, NameCell, TextCell, TickerCell } from './cells';
import type { PositionExtras } from './extras';
import { formatGap, formatWeight, moneyText, weightHeat, type PositionRow, type PositionTotals } from './positionMath';

/** Per-holding risk from GET /api/portfolio/risk and the optimizer's suggested weight (Portafolio page only). */
export interface RiskFields {
    /** Share of the portfolio's risk this holding contributes, in %. */
    riskContributionPct: number | null;
    /** True when the holding has too little history and its risk is an estimate. */
    riskEstimated: boolean;
    /** Target weight in % suggested by the last optimize call; never executed. */
    optimizedTargetPct: number | null;
}

/** A position row with the optional extras and risk fields merged in (thesis tables carry none). */
export type TableRow = PositionRow & Partial<PositionExtras> & Partial<RiskFields>;

export interface CellContext {
    rec?: RecommendationRecord | null;
    /** Privacy mode: dollar values are masked. */
    hidden: boolean;
}

export interface PositionColumn {
    id: string;
    label: string;
    title?: string;
    align: 'left' | 'right';
    width: number;
    /** Cannot be hidden in the column picker. */
    always?: boolean;
    /** This column holds the ticker: PositionsTable puts the ticker addon (watch star) before its cell. */
    isTicker?: boolean;
    sort?: (row: TableRow, rec?: RecommendationRecord | null) => number | string | null;
    cell: (row: TableRow, ctx: CellContext) => ReactNode;
    /** Cell shading, for the change and weight columns. */
    background?: (row: TableRow, rec?: RecommendationRecord | null) => string | undefined;
    /** The totals-row cell; money totals are masked in privacy mode. */
    total?: (totals: PositionTotals, ctx: { hidden: boolean }) => ReactNode;
}

const mono = (text: string): ReactNode => createElement(MonoCell, null, text);

const riskRewardColumns: PositionColumn[] = RISK_REWARD_COLUMNS.map(c => ({
    id: c.id, label: c.label, title: c.title, align: c.align, width: c.width,
    sort: (_row, rec) => riskRewardRowFields(rec)[c.id],
    cell: (_row, ctx) => createElement(RiskRewardCell, { columnId: c.id, rec: ctx.rec, hideValues: ctx.hidden }),
}));

/** Live heatmap price, then the stored price, then the recommendation's price. */
const priceOf = (row: TableRow, rec?: RecommendationRecord | null): number | null =>
    row.livePrice ?? row.currentPrice ?? safeNum(rec?.price);
/** The recommendation's fair value: the one the action and the range bar use. */
const fairValueOf = (rec?: RecommendationRecord | null): number | null => safeNum(rec?.fair_value);
const gapOf = (row: TableRow, rec?: RecommendationRecord | null) => fairValueGap(fairValueOf(rec), priceOf(row, rec));

/**
 * Action sort value: open actions by priority (exit, initiate, accumulate, trim, review,
 * maintain, hold, watchlist), actions already acted on after all of them, and within a priority
 * the larger upside first. Lower sorts first.
 */
function actionSortValue(row: TableRow, rec?: RecommendationRecord | null): number {
    const upside = gapOf(row, rec).upside ?? -999;
    return (actedOn(rec) ? 100 : 0) + getActionPriority(stanceOf(rec) ?? row.action) - upside / 100000;
}

const periodColumns: PositionColumn[] = PORTFOLIO_PERIODS.map(p => {
    const field = p.field as keyof PositionExtras;
    const value = (row: TableRow): number | null => (row[field] as number | null | undefined) ?? null;
    return {
        id: p.field, label: `${p.label} %`, align: 'right', width: 72,
        title: `Price change over ${p.label}.`,
        sort: row => value(row),
        cell: row => mono(fmtPct(value(row))),
        background: row => changeBgDaily(value(row), p.scale),
    };
});

const dollar = (value: number | null | undefined, ctx: CellContext) => mono(moneyText(value, ctx.hidden, fmtDollar));

export const COLUMNS: PositionColumn[] = [
    { id: 'symbol', label: 'Ticker', align: 'left', width: 80, always: true, isTicker: true,
      sort: row => row.ticker,
      cell: row => createElement(TickerCell, { row }) },
    { id: 'name', label: 'Name', align: 'left', width: 170,
      sort: row => row.name,
      cell: row => createElement(NameCell, { row }) },
    { id: 'action', label: 'Action', align: 'left', width: 190,
      title: 'The one action every page shows: the valuation action, reconciled with your standing decision.',
      sort: (row, rec) => actionSortValue(row, rec),
      cell: (row, ctx) => createElement(ActionCell, { row, rec: ctx.rec }) },
    ...riskRewardColumns,
    { id: 'shares', label: 'Shares', align: 'right', width: 70,
      title: 'Shares held across all accounts.',
      sort: row => row.shares,
      cell: row => mono(row.held ? row.shares.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '—') },
    { id: 'actualPct', label: 'Actual %', align: 'right', width: 90,
      title: 'Current weight in the portfolio, from the one weight calculation (live prices, cash included in the total).',
      sort: row => row.actualPct,
      cell: row => mono(formatWeight(row.actualPct)),
      background: row => weightHeat(row.actualPct, 'actual'),
      total: t => mono(formatWeight(t.actualPct)) },
    { id: 'targetPct', label: 'Target %', align: 'right', width: 90,
      title: 'Target weight from the thesis. Context only: targets never drive the action.',
      sort: row => row.targetPct,
      cell: row => mono(formatWeight(row.targetPct)),
      background: row => weightHeat(row.targetPct, 'target'),
      total: t => mono(formatWeight(t.targetPct)) },
    { id: 'gapPct', label: 'Gap', align: 'right', width: 85,
      title: 'Actual weight minus target weight, in percentage points.',
      sort: row => row.gapPct,
      cell: row => mono(formatGap(row.gapPct)),
      total: t => mono(formatGap(t.gapPct)) },
    { id: 'earnings', label: 'Earnings', align: 'right', width: 120,
      title: 'Next earnings date; highlighted within three weeks.',
      sort: row => row.earningsDate ?? null,
      cell: row => createElement(EarningsCell, { date: row.earningsDate, days: row.daysToEarnings }) },
    { id: 'fairValue', label: 'Fair Value', align: 'right', width: 95,
      title: 'The saved valuation the action is based on.',
      sort: (_row, rec) => fairValueOf(rec),
      cell: (_row, ctx) => dollar(fairValueOf(ctx.rec), ctx) },
    { id: 'price', label: 'Price', align: 'right', width: 90,
      sort: (row, rec) => priceOf(row, rec),
      cell: (row, ctx) => mono(moneyText(priceOf(row, ctx.rec), false, fmtPrice)) },
    { id: 'gain', label: 'Gain ($)', align: 'right', width: 90,
      title: 'Fair value minus the current price, per share.',
      sort: (row, rec) => gapOf(row, rec).gainLoss,
      cell: (row, ctx) => {
          const g = gapOf(row, ctx.rec).gainLoss;
          return mono(g == null ? '—' : ctx.hidden ? '$••••' : `${g >= 0 ? '+$' : '-$'}${Math.abs(Math.round(g)).toLocaleString()}`);
      },
      background: (row, rec) => changeBgUpside(gapOf(row, rec).upside) },
    { id: 'upside', label: 'Upside (%)', align: 'right', width: 90,
      title: 'Fair value above (+) or below (−) the current price.',
      sort: (row, rec) => gapOf(row, rec).upside,
      cell: (row, ctx) => mono(fmtPct(gapOf(row, ctx.rec).upside)),
      background: (row, rec) => changeBgUpside(gapOf(row, rec).upside) },
    { id: 'ruleOf40', label: 'R40', align: 'right', width: 70,
      title: 'Revenue growth plus net margin (base scenario).',
      sort: row => row.ruleOf40 ?? null,
      cell: row => mono(row.ruleOf40 == null ? '—' : row.ruleOf40.toFixed(1)) },
    { id: 'growth', label: 'Growth', align: 'right', width: 80,
      sort: row => row.growth ?? null,
      cell: row => mono(row.growth == null ? '—' : `${row.growth.toFixed(1)}%`) },
    { id: 'model', label: 'Analyst', align: 'left', width: 130,
      title: 'The valuation model behind the saved fair value.',
      sort: row => row.model ?? null,
      cell: row => createElement(TextCell, null, row.model ?? '—') },
    { id: 'bear', label: 'Bear', align: 'right', width: 80,
      sort: row => row.bear ?? null, cell: (row, ctx) => dollar(row.bear, ctx) },
    { id: 'base', label: 'Base', align: 'right', width: 80,
      sort: row => row.base ?? null, cell: (row, ctx) => dollar(row.base, ctx) },
    { id: 'bull', label: 'Bull', align: 'right', width: 80,
      sort: row => row.bull ?? null, cell: (row, ctx) => dollar(row.bull, ctx) },
    ...periodColumns,
    { id: 'change_overall', label: 'Overall %', align: 'right', width: 80,
      title: 'Total price change since you bought, against your average cost.',
      sort: row => row.change_overall ?? null,
      cell: row => mono(fmtPct(row.change_overall)),
      background: row => changeBgUpside(row.change_overall ?? null) },
    { id: 'sector', label: 'Sector', align: 'left', width: 125,
      sort: row => row.sector ?? null,
      cell: row => createElement(TextCell, null, row.sector ?? '—') },
    { id: 'averageCost', label: 'Avg Cost', align: 'right', width: 85,
      sort: row => row.averageCost,
      cell: (row, ctx) => mono(moneyText(row.averageCost, ctx.hidden, fmtPrice)) },
    { id: 'bookValue', label: 'Book Value', align: 'right', width: 95,
      sort: row => row.bookValue, cell: (row, ctx) => dollar(row.bookValue, ctx),
      total: (t, ctx) => mono(moneyText(t.bookValue, ctx.hidden, fmtDollar)) },
    { id: 'marketValue', label: 'Mkt Value', align: 'right', width: 95,
      sort: row => row.marketValue, cell: (row, ctx) => dollar(row.marketValue, ctx),
      total: (t, ctx) => mono(moneyText(t.marketValue, ctx.hidden, fmtDollar)) },
    { id: 'qualityMultiplier', label: 'Quality', align: 'right', width: 80,
      sort: row => row.qualityMultiplier ?? null,
      cell: row => mono(row.qualityMultiplier == null ? '—' : `${row.qualityMultiplier.toFixed(2)}x`) },
    { id: 'subStrategyId', label: 'Strategy', align: 'left', width: 140,
      sort: row => row.subStrategyId,
      cell: row => createElement(TextCell, null, row.subStrategyId) },
    { id: 'lastAnalyzed', label: 'Analyzed', align: 'right', width: 95,
      title: 'When the saved valuation was made.',
      sort: row => row.lastAnalyzed ?? null,
      cell: row => mono(row.lastAnalyzed ? new Date(row.lastAnalyzed).toLocaleDateString() : '—') },
    // Accounting columns of the Portafolio page; the cells live in components/portfolio/cells.tsx.
    { id: 'acc_value', label: 'Valor (USD)', align: 'right', width: 105,
      title: 'Market value of the holding in USD.',
      sort: row => row.marketValue,
      cell: (row, ctx) => createElement(ValueCell, { row, hidden: ctx.hidden }),
      total: (t, ctx) => mono(moneyText(t.marketValue, ctx.hidden, v => esNum(v, 2))) },
    { id: 'acc_riskWeight', label: 'Peso y riesgo', align: 'right', width: 250,
      title: 'Weight of the money (grey) and share of the portfolio risk (amber) on one 0-40 % scale. Risk = weight × volatility, normalised to 100 %.',
      sort: row => row.actualPct,
      cell: row => createElement(WeightRiskCell, { row }),
      total: t => mono(`${esPct(t.actualPct)} del total`) },
    { id: 'acc_gain', label: 'Ganancia', align: 'right', width: 110,
      title: 'Current price minus average cost, times shares. Not the valuation gap (see the Gain ($) column).',
      sort: row => holdingGain(row)?.amount ?? null,
      cell: (row, ctx) => createElement(GainCell, { row, hidden: ctx.hidden }) },
    { id: 'rationale', label: 'Rationale', align: 'left', width: 260,
      sort: row => row.rationale,
      cell: row => createElement(TextCell, null, row.rationale ?? '—') },
];

export const COLUMNS_BY_ID: Record<string, PositionColumn> = Object.fromEntries(COLUMNS.map(c => [c.id, c]));
