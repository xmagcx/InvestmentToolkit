/**
 * presets.ts - Which columns, order and sort each screen shows from the one registry.
 *
 * Purpose:
 *     A preset is only a list of registry column ids plus a default sort. Screens do not define
 *     columns; they pick a preset. Row filtering (held positions, one thesis) lives in
 *     positionMath.ts and the screen that renders the table.
 *
 * Layer: Frontend / Components / Positions
 *
 * Usage Examples:
 *     <PositionsTable rows={rows} preset={THESIS_PRESET} />
 *
 * Key Functions (Index):
 *     - THESIS_PRESET: the compact set used inside a thesis page
 *     - PORTFOLIO_PRESET: the full analyst column set of the portfolio page (reachable from the column picker)
 *     - ACCOUNTING_PRESET: the four accounting columns the two-panel Portafolio page opens with
 *
 * Key Input Dependencies:
 *     - columns.tsx (column ids)
 *
 * Key Output Dependencies:
 *     - PositionsTable, ThesisPositions
 */
export interface PositionPreset {
    columns: string[];
    sort: { id: string; dir: 'asc' | 'desc' };
    totals: boolean;
}

/** A thesis page: stance, valuation range, and how the weight compares with the target. */
export const THESIS_PRESET: PositionPreset = {
    columns: ['symbol', 'action', 'rr_range', 'rr_premium', 'rr_ratio', 'shares', 'actualPct', 'targetPct', 'gapPct'],
    sort: { id: 'actualPct', dir: 'desc' },
    totals: true,
};

/** The portfolio page: what the old Portfolio Table and Advisor showed by default, in one list. */
export const PORTFOLIO_PRESET: PositionPreset = {
    columns: ['symbol', 'action', 'rr_range', 'rr_premium', 'rr_ratio', 'rr_support', 'rr_check', 'actualPct', 'targetPct',
        'earnings', 'fairValue', 'price', 'gain', 'upside', 'ruleOf40', 'growth', 'model', 'change_1d', 'change_overall',
        'subStrategyId', 'lastAnalyzed'],
    sort: { id: 'action', dir: 'asc' },
    totals: true,
};

/** The two-panel Portafolio page: ticker, name, value, weight and risk bars, gain; biggest weight first. */
export const ACCOUNTING_PRESET: PositionPreset = {
    // No `name`: the backend leaves it null for every holding today, so the column renders
    // empty and pushes Ganancia out of view. The column picker can bring it back.
    columns: ['symbol', 'acc_value', 'acc_riskWeight', 'acc_gain'],
    sort: { id: 'acc_riskWeight', dir: 'desc' },
    totals: true,
};
