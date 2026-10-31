/**
 * @vitest-environment jsdom
 * Purpose: the redesigned portfolio summary (specs S1/S2) leads with the consolidated
 * USD total and the FX rate used, shows each profile in ITS base currency, excludes
 * unpriced tickers from value while listing them, degrades to a partial total when FX
 * is unavailable, keeps positions and the allocation chart collapsed (the chart is only
 * fetched when opened), refreshes prices with feedback, and reports load errors.
 * Layer: Frontend integration. Usage: npx vitest run src/pages/PortfolioSummaryPage.test.tsx.
 * Key Input Dependencies: services/api.ts is mocked; StrategyAllocationChart is stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import PortfolioSummaryPage from './PortfolioSummaryPage';
import type { ProfilesSummary } from '../services/api';

vi.mock('../services/api', async () => {
    const actual = await vi.importActual<typeof import('../services/api')>('../services/api');
    return {
        ...actual,
        fetchProfilesSummary: vi.fn(),
        fetchPortfolioPerformance: vi.fn(),
        fetchStrategyAllocation: vi.fn(),
        refreshPrices: vi.fn(),
    };
});

vi.mock('../components/StrategyAllocationChart', () => ({
    default: () => <div data-testid="allocation-chart" />,
}));

const api = await import('../services/api');

const summary: ProfilesSummary = {
    profiles: [
        {
            accountId: 'racional', name: 'Racional', currency: 'USD',
            cash: 1700, invested: 6418.2, marketValue: 7416.8,
            unrealizedPnl: 998.6, unrealizedPnlPct: 15.56,
            pricedCount: 1, unpricedCount: 0, unpricedTickers: [],
            positions: [{ ticker: 'AAPL', qty: 10, avgCost: 182.4, price: 229.35, priceAsOf: '2026-10-30T20:00:00Z', priceCurrency: 'USD', value: 2293.5, pnl: 469.5 }],
            usdRate: 1, valueUsd: 9116.8,
        },
        {
            accountId: 'ahorro', name: 'Ahorro Chile', currency: 'CLP',
            cash: 850000, invested: 5244000, marketValue: 4982700,
            unrealizedPnl: -261300, unrealizedPnlPct: -4.98,
            pricedCount: 1, unpricedCount: 1, unpricedTickers: ['CENCOSUD'],
            positions: [
                { ticker: 'CHILE', qty: 3000, avgCost: 98, price: 104.5, priceAsOf: '2026-10-30T20:00:00Z', priceCurrency: 'CLP', value: 313500, pnl: 19500 },
                { ticker: 'CENCOSUD', qty: 400, avgCost: 1780, price: null, priceAsOf: null, priceCurrency: null, value: null, pnl: null },
            ],
            usdRate: 948.2, valueUsd: 6151.34,
        },
    ],
    totals: {
        valueUsd: 15268.14, marketValueUsd: 12671.7, investedUsd: 11948.68,
        cashUsd: 2596.44, unrealizedPnlUsd: 723.02, unrealizedPnlPct: 6.05, partial: false,
    },
    fx: [{ currency: 'CLP', usdTo: 948.2, source: 'tradingview', asOf: '2026-10-30T17:32:00Z' }],
    fxUnavailable: [],
    lastPriceAt: '2026-10-30T20:00:00Z',
};

const performance = {
    '1d': { change: 63.8, changePct: 0.42, historicalValue: 15204.34, currentValue: 15268.14 },
    '1w': { change: -169.8, changePct: -1.1, historicalValue: 15437.94, currentValue: 15268.14 },
    '1m': null,
    '3m': null,
};

const allocation = {
    allocation: [{ id: 'cash', name: 'Caja', valueUSD: 2596.44, pct: 17, holdings: [] }],
    totalUSD: 15268.14,
};

describe('PortfolioSummaryPage', () => {
    beforeEach(() => {
        vi.mocked(api.fetchProfilesSummary).mockResolvedValue(summary);
        vi.mocked(api.fetchPortfolioPerformance).mockResolvedValue(performance);
        vi.mocked(api.fetchStrategyAllocation).mockResolvedValue(allocation);
        vi.mocked(api.refreshPrices).mockResolvedValue({ success: true, updated: 4, missingPrices: [] });
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it('leads with the consolidated USD total and the FX rate used', async () => {
        render(<PortfolioSummaryPage />);
        expect(await screen.findByText('15.268,14')).toBeTruthy();
        expect(screen.getByText(/1 USD = 948,20 CLP/)).toBeTruthy();
        expect(screen.getByText(/tradingview/i)).toBeTruthy();
        expect(screen.getByText('11.948,68 USD')).toBeTruthy();   // invertido
        expect(screen.getByText('+723,02 USD')).toBeTruthy();     // P/L no realizado
        expect(screen.getByText('2.596,44 USD')).toBeTruthy();    // caja disponible
    });

    it('shows a CLP profile in CLP with its USD equivalent and no CAD anywhere', async () => {
        const { container } = render(<PortfolioSummaryPage />);
        expect(await screen.findByText('5.832.700')).toBeTruthy();     // 4.982.700 + 850.000 CLP
        expect(screen.getByText(/6\.151,34 USD/)).toBeTruthy();
        expect(screen.getByText('−261.300 CLP (−4,98 %)')).toBeTruthy();
        expect(container.textContent).not.toMatch(/CAD|CA\$/);
    });

    it('keeps positions collapsed and expands them on click', async () => {
        render(<PortfolioSummaryPage />);
        await screen.findByText('15.268,14');
        expect(screen.queryByText('AAPL')).toBe(null);
        fireEvent.click(screen.getByRole('button', { name: /Ver 1 posición/ }));
        expect(screen.getByText('AAPL')).toBeTruthy();
    });

    it('lists an unpriced ticker as "Sin precio" and excludes it from the value', async () => {
        render(<PortfolioSummaryPage />);
        await screen.findByText('15.268,14');
        expect(screen.getByText(/CENCOSUD sin precio/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Ver 2 posiciones/ }));
        expect(screen.getByText('Sin precio')).toBeTruthy();
        // The unpriced position contributes no value: the card still shows the priced total.
        expect(screen.getByText('5.832.700')).toBeTruthy();
    });

    it('marks the total as partial when a profile has no FX rate', async () => {
        vi.mocked(api.fetchProfilesSummary).mockResolvedValue({
            ...summary,
            profiles: [summary.profiles[0], { ...summary.profiles[1], usdRate: null, valueUsd: null }],
            totals: { ...summary.totals, valueUsd: 9116.8, partial: true },
            fx: [],
            fxUnavailable: ['CLP'],
        });
        render(<PortfolioSummaryPage />);
        // Without the CLP profile the total equals the USD profile's own total, so the
        // hero is queried inside its own region instead of by a page-wide unique string.
        const hero = await screen.findByRole('region', { name: 'Valor total consolidado' });
        expect(within(hero).getByText('9.116,80')).toBeTruthy();
        expect(screen.getByText(/Total parcial/)).toBeTruthy();
        expect(screen.getByText('Sin tasa de cambio')).toBeTruthy();
    });

    it('fetches the strategy allocation only when the section is opened', async () => {
        render(<PortfolioSummaryPage />);
        await screen.findByText('15.268,14');
        expect(api.fetchStrategyAllocation).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /Asignación por estrategia/ }));
        await waitFor(() => expect(screen.getByTestId('allocation-chart')).toBeTruthy());
        expect(vi.mocked(api.fetchStrategyAllocation).mock.calls.length).toBe(1);
    });

    it('refreshes prices with a loading state, feedback and a reload of the summary', async () => {
        render(<PortfolioSummaryPage />);
        await screen.findByText('15.268,14');
        fireEvent.click(screen.getByRole('button', { name: /Actualizar precios/ }));
        expect(screen.getByRole('button', { name: /Actualizando/ }).hasAttribute('disabled')).toBe(true);
        await waitFor(() => expect(screen.getByText(/4 precios actualizados/)).toBeTruthy());
        expect(vi.mocked(api.fetchProfilesSummary).mock.calls.length).toBe(2);
    });

    it('reports a load error instead of looking empty', async () => {
        vi.mocked(api.fetchProfilesSummary).mockRejectedValue(new Error('backend caído'));
        render(<PortfolioSummaryPage />);
        expect(await screen.findByText(/backend caído/)).toBeTruthy();
    });

    it('shows an empty state when there are no profiles', async () => {
        vi.mocked(api.fetchProfilesSummary).mockResolvedValue({
            profiles: [],
            totals: { valueUsd: 0, marketValueUsd: 0, investedUsd: 0, cashUsd: 0, unrealizedPnlUsd: 0, unrealizedPnlPct: null, partial: false },
            fx: [], fxUnavailable: [], lastPriceAt: null,
        });
        render(<PortfolioSummaryPage />);
        expect(await screen.findByText(/Aún no hay perfiles/)).toBeTruthy();
    });
});
