/**
 * @vitest-environment jsdom
 * Purpose: PRESERVE + new behaviour of the shared PositionsTable: renders without a selected row as before,
 *     highlights the selected row, still hosts the ticker addon on the ticker column, and the accounting cells render.
 * Layer: Frontend integration. Usage: vitest run tests/portfolio/PositionsTable.test.tsx.
 * Key Input Dependencies: components/positions/PositionsTable, presets (ACCOUNTING_PRESET), columns registry.
 */
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { PositionsTable } from '../../src/components/positions/PositionsTable';
import { ACCOUNTING_PRESET, THESIS_PRESET } from '../../src/components/positions/presets';
import type { TableRow } from '../../src/components/positions/columns';

afterEach(cleanup);

const row = (ticker: string, over: Partial<TableRow> = {}): TableRow => ({
    ticker, name: `${ticker} Inc`, assetClass: 'EQUITY', pillarId: 'p', subStrategyId: 's', role: 'core', held: true,
    shares: 2, averageCost: 10, bookValue: 20, marketValue: 30, currentPrice: 15, actualPct: 20.76, targetPct: 2,
    gapPct: 1, action: 'MAINTAIN', rationale: null, hasValuation: false, isWatched: false, documents: [], ...over,
});

it('PRESERVE: renders without a selected row, with no row marked selected', () => {
    render(<PositionsTable rows={[row('AAA'), row('BBB')]} columnIds={THESIS_PRESET.columns} initialSort={THESIS_PRESET.sort} totals />);
    expect(screen.getByText('AAA')).toBeTruthy();
    expect(document.querySelector('[aria-selected="true"]')).toBeNull();
});

it('PRESERVE: the ticker addon still sits in the symbol column', () => {
    render(<PositionsTable rows={[row('AAA')]} columnIds={['symbol']} initialSort={{ id: 'symbol', dir: 'asc' }}
        tickerAddon={r => <i data-testid="addon">{r.ticker}</i>} />);
    expect(screen.getByTestId('addon')).toBeTruthy();
});

it('marks only the selected row', () => {
    render(<PositionsTable rows={[row('AAA'), row('BBB')]} columnIds={['symbol']} initialSort={{ id: 'symbol', dir: 'asc' }}
        selectedTicker="BBB" />);
    const selected = document.querySelectorAll('tr[aria-selected="true"]');
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toContain('BBB');
});

it('accounting columns: weight and risk bars with numbers, est. marker, gain sign colour, target weight', () => {
    const rows = [
        row('APP', { riskContributionPct: 36.5, livePrice: 8, optimizedTargetPct: 9.1 }),
        row('SFD', { actualPct: 13.4, riskContributionPct: 13.9, riskEstimated: true, averageCost: 5, livePrice: 15 }),
    ];
    render(<PositionsTable rows={rows} columnIds={ACCOUNTING_PRESET.columns} initialSort={ACCOUNTING_PRESET.sort}
        tickerAddon={() => null} />);
    // No name column: the backend leaves `name` null for every holding, so the preset drops it.
    expect(screen.queryByText('APP Inc')).toBeNull();
    expect(screen.getByText('36,5 %')).toBeTruthy();
    expect(screen.getByText('20,8 %')).toBeTruthy();
    expect(screen.getByText('est.')).toBeTruthy();
    expect(screen.getByTestId('risk-bar-SFD').getAttribute('data-estimated')).toBe('true');
    expect(screen.getByTestId('risk-bar-APP').getAttribute('data-estimated')).toBe('false');
    expect((screen.getByTestId('risk-bar-APP').firstElementChild as HTMLElement).style.width).toBe('91.25%');
    expect(screen.getByTestId('gain-APP').className).toContain('text-red-400');
    expect(screen.getByTestId('gain-SFD').className).toContain('text-emerald-400');
    expect(screen.getByText('→ 9,1')).toBeTruthy();
});
