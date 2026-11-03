import { describe, expect, it } from 'vitest';
import { COLUMNS, COLUMNS_BY_ID } from './columns';
import { ACCOUNTING_PRESET, PORTFOLIO_PRESET, THESIS_PRESET } from './presets';
import type { TableRow } from './columns';
import type { PositionRow } from './positionMath';

describe('column registry', () => {
    it('has unique ids', () => {
        expect(new Set(COLUMNS.map(c => c.id)).size).toBe(COLUMNS.length);
    });
    it('every preset column exists in the registry', () => {
        for (const id of THESIS_PRESET.columns) expect(COLUMNS_BY_ID[id], id).toBeDefined();
        expect(COLUMNS_BY_ID[THESIS_PRESET.sort.id]).toBeDefined();
    });
    it('every column has a label, a width and a cell', () => {
        for (const c of COLUMNS) {
            expect(c.label.length, c.id).toBeGreaterThan(0);
            expect(c.width, c.id).toBeGreaterThan(0);
            expect(typeof c.cell, c.id).toBe('function');
        }
    });
    it('the weight columns that the totals row needs define a total', () => {
        for (const id of ['actualPct', 'targetPct', 'gapPct']) expect(typeof COLUMNS_BY_ID[id].total, id).toBe('function');
    });
});

const base: PositionRow = {
    ticker: 'AAA', name: 'AAA Inc', assetClass: 'EQUITY', pillarId: 'p', subStrategyId: 's', role: 'core', held: true,
    shares: 2, averageCost: 10, bookValue: 20, marketValue: 30, currentPrice: 15, actualPct: 3, targetPct: 2,
    gapPct: 1, action: 'MAINTAIN', rationale: 'why', hasValuation: true, isWatched: false, documents: [],
};

describe('portfolio preset and the columns both old tables had', () => {
    it('every portfolio preset column exists in the registry', () => {
        for (const id of PORTFOLIO_PRESET.columns) expect(COLUMNS_BY_ID[id], id).toBeDefined();
        expect(COLUMNS_BY_ID[PORTFOLIO_PRESET.sort.id]).toBeDefined();
    });
    it('covers the columns of the old Portfolio Table and Advisor', () => {
        for (const id of ['symbol', 'name', 'action', 'rr_range', 'actualPct', 'targetPct', 'earnings', 'fairValue', 'price',
            'gain', 'upside', 'ruleOf40', 'growth', 'model', 'bear', 'base', 'bull', 'change_1d', 'change_1w', 'change_1m',
            'change_3m', 'change_ytd', 'change_1y', 'change_overall', 'sector', 'shares', 'averageCost', 'bookValue',
            'marketValue', 'qualityMultiplier', 'subStrategyId', 'lastAnalyzed', 'rationale']) {
            expect(COLUMNS_BY_ID[id], id).toBeDefined();
        }
    });
    it('sorts by the extras the heatmap and projection supply', () => {
        const row: TableRow = { ...base, sector: 'Tech', growth: 20, change_1d: 1.5, earningsDate: '2026-11-01' };
        expect(COLUMNS_BY_ID.sector.sort!(row)).toBe('Tech');
        expect(COLUMNS_BY_ID.growth.sort!(row)).toBe(20);
        expect(COLUMNS_BY_ID.change_1d.sort!(row)).toBe(1.5);
        expect(COLUMNS_BY_ID.earnings.sort!(row)).toBe('2026-11-01');
    });
    it('prefers the live price, then the stored price, then the recommendation price', () => {
        const price = COLUMNS_BY_ID.price.sort!;
        expect(price({ ...base, livePrice: 99 }, undefined)).toBe(99);
        expect(price({ ...base }, undefined)).toBe(15);
        expect(price({ ...base, currentPrice: null }, { price: 7 } as never)).toBe(7);
    });
    it('upside and gain come from the recommendation fair value against that price', () => {
        const rec = { fair_value: 30 } as never;
        expect(COLUMNS_BY_ID.upside.sort!({ ...base, livePrice: 20 }, rec)).toBeCloseTo(50);
        expect(COLUMNS_BY_ID.gain.sort!({ ...base, livePrice: 20 }, rec)).toBe(10);
        expect(COLUMNS_BY_ID.upside.sort!({ ...base, currentPrice: null }, undefined)).toBeNull();
    });
    it('colours change and weight cells, and nothing else by default', () => {
        const row: TableRow = { ...base, change_1d: 6 };
        expect(COLUMNS_BY_ID.change_1d.background!(row, undefined)).not.toBe('transparent');
        expect(COLUMNS_BY_ID.actualPct.background!(row, undefined)).toBeTruthy();
        expect(COLUMNS_BY_ID.sector.background).toBeUndefined();
    });
});

describe('action sort', () => {
    const sort = COLUMNS_BY_ID.action.sort!;
    const rec = (action: string, over: Record<string, unknown> = {}) => ({ action, fair_value: 100, price: 50, ...over }) as never;
    it('orders by action priority (open actions first), not alphabetically', () => {
        const order = ['INITIATE', 'ACCUMULATE', 'MAINTAIN', 'TRIM', 'EXIT', 'WATCHLIST']
            .map(a => ({ a, v: sort(base, rec(a)) as number }))
            .sort((x, y) => x.v - y.v).map(x => x.a);
        expect(order.indexOf('INITIATE')).toBeLessThan(order.indexOf('MAINTAIN'));
        expect(order.indexOf('ACCUMULATE')).toBeLessThan(order.indexOf('WATCHLIST'));
    });
    it('puts an action that was already acted on after every open one', () => {
        const acted = sort(base, rec('INITIATE', { recent_trades: { context: { status: 'ACTED' } } })) as number;
        const open = sort(base, rec('WATCHLIST')) as number;
        expect(acted).toBeGreaterThan(open);
    });
    it('breaks ties with the larger upside first', () => {
        const big = sort({ ...base, livePrice: 50 }, rec('ACCUMULATE', { fair_value: 200 })) as number;
        const small = sort({ ...base, livePrice: 50 }, rec('ACCUMULATE', { fair_value: 60 })) as number;
        expect(big).toBeLessThan(small);
    });
});

describe('PRESERVE: existing registry behaviour the accounting columns must not change', () => {
    it('the gain column is still fair value minus price, whatever the average cost is', () => {
        const rec = { fair_value: 30 } as never;
        const row: TableRow = { ...base, averageCost: 5, livePrice: 20 };
        expect(COLUMNS_BY_ID.gain.sort!(row, rec)).toBe(10);
        expect(COLUMNS_BY_ID.gain.label).toBe('Gain ($)');
    });
    it('the portfolio preset still resolves every column and keeps its default sort', () => {
        expect(PORTFOLIO_PRESET.columns).toEqual(expect.arrayContaining(['symbol', 'action', 'rr_range', 'gain', 'upside', 'actualPct']));
        expect(PORTFOLIO_PRESET.sort).toEqual({ id: 'action', dir: 'asc' });
        expect(COLUMNS_BY_ID.symbol.isTicker).toBe(true);
    });
});

describe('accounting columns', () => {
    it('the accounting preset resolves its registry columns, sorted by weight descending, with no action column', () => {
        expect(ACCOUNTING_PRESET.columns).toEqual(['symbol', 'acc_value', 'acc_riskWeight', 'acc_gain']);
        for (const id of ACCOUNTING_PRESET.columns) expect(COLUMNS_BY_ID[id], id).toBeDefined();
        expect(ACCOUNTING_PRESET.sort).toEqual({ id: 'acc_riskWeight', dir: 'desc' });
        // Exactly one ticker column: `symbol` is always forced in, so a second one would render twice.
        expect(ACCOUNTING_PRESET.columns.filter(id => COLUMNS_BY_ID[id].isTicker)).toEqual(['symbol']);
        expect(COLUMNS_BY_ID.acc_symbol).toBeUndefined();
    });
    it('acc_gain is price minus average cost (not the valuation gap) and sorts by it', () => {
        const row: TableRow = { ...base, shares: 2, averageCost: 10, livePrice: 12 };
        expect(COLUMNS_BY_ID.acc_gain.sort!(row, { fair_value: 99 } as never)).toBe(4);
        expect(COLUMNS_BY_ID.acc_gain.sort!({ ...base, averageCost: null }, undefined)).toBeNull();
    });
    it('acc_value sorts by market value and acc_riskWeight by weight', () => {
        expect(COLUMNS_BY_ID.acc_value.sort!(base)).toBe(30);
        expect(COLUMNS_BY_ID.acc_riskWeight.sort!(base)).toBe(3);
    });
});
