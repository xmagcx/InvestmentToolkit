/**
 * Purpose: the Portafolio page maths: bar scale, Alto/Medio/Bajo verdicts, plain-Spanish basis, gain, insight.
 * Layer: Frontend unit. Usage: vitest run tests/portfolio/portfolioMath.test.ts.
 * Key Functions: barWidthPct, volatilityVerdict, drawdownVerdict, contributionVerdict, riskCards, holdingGain, insightSentence.
 * Key Input Dependencies: components/portfolio/portfolioMath; RiskRow shaped like GET /api/portfolio/risk.
 */
import { describe, expect, it } from 'vitest';
import {
    barWidthPct, contributionVerdict, drawdownVerdict, esNum, holdingGain, insightSentence, liveWeights, nameLine, portfolioGain, riskCards,
    volatilityVerdict,
} from '../../src/components/portfolio/portfolioMath';
import type { RiskRow } from '../../src/services/api';

const app: RiskRow = {
    ticker: 'APP', market_value: 811.29, weight_pct: 20.76, volatility_ann: 0.7677, max_drawdown_3y: -0.6885,
    sharpe_3y: 1.023, sortino_3y: 1.597, downside_beta_3y: 2.197, risk_contribution_pct: 36.5, estimated: false,
};
const medians = { volatility_ann: 0.352, max_drawdown_3y: -0.492 };

describe('bar scale', () => {
    it('puts weight and risk on one 0-40 % scale', () => {
        expect(barWidthPct(20.76)).toBeCloseTo(51.9, 1);
        expect(barWidthPct(36.5)).toBeCloseTo(91.25, 2);
        expect(barWidthPct(0)).toBe(0);
    });
    it('clamps above the scale and below zero, and treats unknown as empty', () => {
        expect(barWidthPct(55)).toBe(100);
        expect(barWidthPct(-3)).toBe(0);
        expect(barWidthPct(null)).toBe(0);
    });
});

describe('verdicts', () => {
    it('volatility: multiple of the portfolio median', () => {
        expect(volatilityVerdict(0.7677, 0.352)).toEqual({ level: 'Alto', multiple: expect.closeTo(2.18, 2) });
        expect(volatilityVerdict(0.352, 0.352)).toMatchObject({ level: 'Medio', multiple: 1 });
        expect(volatilityVerdict(0.2, 0.352)).toMatchObject({ level: 'Bajo' });
    });
    it('volatility thresholds: 1.5x is Alto, 0.8x is Medio', () => {
        expect(volatilityVerdict(0.15, 0.1)?.level).toBe('Alto');
        expect(volatilityVerdict(0.149, 0.1)?.level).toBe('Medio');
        expect(volatilityVerdict(0.08, 0.1)?.level).toBe('Medio');
        expect(volatilityVerdict(0.079, 0.1)?.level).toBe('Bajo');
    });
    it('drawdown: compared with the median fall, both negative', () => {
        expect(drawdownVerdict(-0.6885, -0.492)).toMatchObject({ level: 'Alto', multiple: expect.closeTo(1.4, 2) });
        expect(drawdownVerdict(-0.49, -0.492)).toMatchObject({ level: 'Medio' });
        expect(drawdownVerdict(-0.2, -0.492)).toMatchObject({ level: 'Bajo' });
    });
    it('contribution: multiple of the weight', () => {
        expect(contributionVerdict(36.5, 20.76)).toMatchObject({ level: 'Alto', multiple: expect.closeTo(1.76, 2) });
        expect(contributionVerdict(8.0, 10.6)).toMatchObject({ level: 'Medio' });
        expect(contributionVerdict(2.8, 6.5)).toMatchObject({ level: 'Bajo' });
    });
    it('returns null instead of guessing when a side is missing or zero', () => {
        expect(volatilityVerdict(null, 0.35)).toBeNull();
        expect(volatilityVerdict(0.5, 0)).toBeNull();
        expect(drawdownVerdict(-0.5, null)).toBeNull();
        expect(contributionVerdict(10, 0)).toBeNull();
    });
});

describe('risk cards', () => {
    it('builds the three figures with value, verdict and Spanish basis', () => {
        const [vol, dd, contrib] = riskCards(app, medians);
        expect(vol).toMatchObject({ title: 'Cuánto se mueve al año', value: '76,8 %', level: 'Alto' });
        expect(vol.basis).toBe('2,2× la mediana de tu cartera (35,2 %)');
        expect(dd).toMatchObject({ title: 'Peor caída en 3 años', value: '−68,9 %', level: 'Alto' });
        expect(dd.basis).toBe('Tu mediana cayó −49,2 % en el mismo periodo');
        expect(contrib).toMatchObject({ title: 'Cuánto riesgo aporta', value: '36,5 %', level: 'Alto' });
        expect(contrib.basis).toBe('1,8× su peso (20,8 %): aporta más riesgo que dinero');
    });
    it('shows dashes and no verdict for a holding without history', () => {
        const [vol] = riskCards({ ...app, volatility_ann: null, max_drawdown_3y: null }, medians);
        expect(vol.value).toBe('—');
        expect(vol.level).toBeNull();
    });
});

describe('gain', () => {
    const row = { shares: 3.4015, averageCost: 283.51, livePrice: 238.51, currentPrice: 240 } as never;
    it('is price minus average cost, times shares', () => {
        const g = holdingGain(row)!;
        expect(g.amount).toBeCloseTo(-153.07, 2);
        expect(g.pct).toBeCloseTo(-15.87, 2);
    });
    it('falls back to the stored price, and is null when cost or shares are unknown', () => {
        expect(holdingGain({ shares: 2, averageCost: 10, livePrice: null, currentPrice: 15 } as never)!.amount).toBe(10);
        expect(holdingGain({ shares: 0, averageCost: 10, currentPrice: 15 } as never)).toBeNull();
        expect(holdingGain({ shares: 2, averageCost: null, currentPrice: 15 } as never)).toBeNull();
    });
    it('totals over held rows only', () => {
        const total = portfolioGain([row, { shares: 0, averageCost: null, currentPrice: 5 } as never])!;
        expect(total.amount).toBeCloseTo(-153.07, 2);
    });
});

describe('insight and formatting', () => {
    it('compares the largest holding money share with its risk share', () => {
        const small = { ...app, ticker: 'VICI', weight_pct: 6.5, risk_contribution_pct: 2.8 };
        expect(insightSentence([small, app])).toBe('APP es 20,8 % de tu dinero y 36,5 % del riesgo.');
    });
    it('is null with no rows', () => expect(insightSentence([])).toBeNull());
    it('formats Spanish numbers', () => {
        expect(esNum(3908.6, 2)).toBe('3.908,60');
        expect(esNum(-0.5, 1)).toBe('−0,5');
    });
});

const held = (ticker: string, shares: number, livePrice: number | null, marketValue: number | null) => ({
    ticker, held: true, shares, livePrice, currentPrice: null, marketValue, averageCost: null, actualPct: 99 as number | null,
});

describe('liveWeights: one price source, one denominator (holdings plus cash)', () => {
    it('values every held row at shares x live price and weighs it against holdings plus cash', () => {
        const out = liveWeights([held('APP', 2, 100, 811.29), held('SFD', 1, 50, 10)], 50);
        expect(out.holdingsUsd).toBe(250);
        expect(out.totalUsd).toBe(300);
        expect(out.rows[0]).toMatchObject({ marketValue: 200, actualPct: expect.closeTo(66.667, 2) });
        expect(out.rows[1]).toMatchObject({ marketValue: 50, actualPct: expect.closeTo(16.667, 2) });
    });
    it('weights plus the cash share add up to 100 %', () => {
        const out = liveWeights([held('A', 1, 70, null), held('B', 1, 30, null)], 100);
        const sum = out.rows.reduce((s, r) => s + (r.actualPct ?? 0), 0);
        expect(sum + (100 / out.totalUsd) * 100).toBeCloseTo(100, 6);
    });
    it('falls back to the stored value when there is no live price, and leaves unheld rows alone', () => {
        const watch = { ...held('W', 0, null, null), held: false, actualPct: 0 };
        const out = liveWeights([held('A', 1, null, 40), watch], 60);
        expect(out.rows[0]).toMatchObject({ marketValue: 40, actualPct: 40 });
        expect(out.rows[1]).toBe(watch);
        expect(out.totalUsd).toBe(100);
    });
    it('does not divide by zero', () => {
        expect(liveWeights([], 0).totalUsd).toBe(0);
    });
    it('the insight sentence built from live weights quotes the same weight as the row', () => {
        const live = { ...app, weight_pct: 21.4 };
        expect(insightSentence([live])).toBe('APP es 21,4 % de tu dinero y 36,5 % del riesgo.');
    });
});

describe('nameLine', () => {
    it('is empty when the name is missing, blank or just the ticker', () => {
        expect(nameLine({ ticker: 'APP', name: null })).toBe('');
        expect(nameLine({ ticker: 'APP', name: '  ' })).toBe('');
        expect(nameLine({ ticker: 'APP', name: 'app' })).toBe('');
    });
    it('is the name when it differs', () => expect(nameLine({ ticker: 'APP', name: 'AppLovin' })).toBe('AppLovin'));
});
