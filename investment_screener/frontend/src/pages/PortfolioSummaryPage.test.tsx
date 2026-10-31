/**
 * @vitest-environment jsdom
 * Purpose: the portfolio summary as an analyst table (specs S1/S2, artboard
 * "03 Tabla de analista"): a header card with the consolidated USD total, the FX
 * details and the refresh action, ONE table with a row per profile (in its base
 * currency) expandable to its positions plus a "Total consolidado" row in USD,
 * and a right rail with the 1D/1S/1M/3M performance and the strategy donut.
 * Layer: Frontend integration. Usage: npx vitest run src/pages/PortfolioSummaryPage.test.tsx.
 * Key Input Dependencies: services/api.ts is mocked.
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
    allocation: [
        { id: 'dividends', name: 'Dividendos', valueUSD: 5254.9, pct: 34.4, holdings: [] },
        { id: 'cash', name: 'Caja', valueUSD: 2596.44, pct: 17, holdings: [] },
    ],
    totalUSD: 15268.14,
};

function profileRow(name: string | RegExp): HTMLElement {
    return screen.getByRole('button', { name }).closest('tr') as HTMLElement;
}

/** The page is ready when the table closes with its consolidated total row. */
const ready = () => screen.findByText('Total consolidado');

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

    it('leads with the consolidated USD total, the FX details and the compact totals', async () => {
        render(<PortfolioSummaryPage />);
        await ready();
        const header = screen.getByRole('region', { name: 'Resumen de portafolio' });
        expect(within(header).getByText('15.268,14')).toBeTruthy();
        expect(screen.getByText(/1 USD = 948,20 CLP · tradingview/)).toBeTruthy();
        expect(screen.getByText(/Solo los perfiles cuya moneda base no es USD se convierten/)).toBeTruthy();
        expect(screen.getByText('11.948,68 USD')).toBeTruthy();   // invertido
        expect(screen.getByText(/\+723,02 USD \(\+6,05 %\)/)).toBeTruthy();  // P/L no realizado
        expect(screen.getByText(/\+63,80 \(\+0,42 %\) hoy/)).toBeTruthy();
    });

    it('renders one table row per profile with its currency badge and USD value', async () => {
        render(<PortfolioSummaryPage />);
        await ready();
        expect(screen.getByText(/Perfiles y sus posiciones · valores en la moneda base de cada perfil/)).toBeTruthy();

        const racional = profileRow(/Racional/);
        expect(within(racional).getByText('USD')).toBeTruthy();
        expect(within(racional).getAllByText('9.116,80').length).toBe(2); // valor perfil + en USD

        const ahorro = profileRow(/Ahorro Chile/);
        expect(within(ahorro).getByText('CLP')).toBeTruthy();
        expect(within(ahorro).getByText('5.832.700')).toBeTruthy();
        expect(within(ahorro).getByText('−261.300')).toBeTruthy();
        expect(within(ahorro).getByText('6.151,34')).toBeTruthy();
    });

    it('expands the first profile by default, keeps the rest collapsed and toggles', async () => {
        render(<PortfolioSummaryPage />);
        await ready();

        const first = screen.getByRole('button', { name: /Racional/ });
        const second = screen.getByRole('button', { name: /Ahorro Chile/ });
        expect(first.getAttribute('aria-expanded')).toBe('true');
        expect(second.getAttribute('aria-expanded')).toBe('false');
        expect(screen.getByText('AAPL')).toBeTruthy();
        expect(screen.queryByText('CHILE')).toBe(null);

        fireEvent.click(second);
        expect(second.getAttribute('aria-expanded')).toBe('true');
        expect(screen.getByText('CHILE')).toBeTruthy();

        fireEvent.click(first);
        expect(first.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByText('AAPL')).toBe(null);
    });

    it('warns about unpriced positions and shows them as "Sin precio"', async () => {
        render(<PortfolioSummaryPage />);
        await ready();
        expect(screen.getByText(/1 de 2 posiciones sin precio \(CENCOSUD\): queda fuera del valor de mercado y del P\/L\./)).toBeTruthy();

        fireEvent.click(screen.getByRole('button', { name: /Ahorro Chile/ }));
        const unpriced = screen.getByText('CENCOSUD').closest('tr') as HTMLElement;
        expect(within(unpriced).getByText('Sin precio')).toBeTruthy();
    });

    it('closes the table with a consolidated total row in USD', async () => {
        render(<PortfolioSummaryPage />);
        const total = (await ready()).closest('tr') as HTMLElement;
        expect(within(total).getByText('12.671,70')).toBeTruthy();  // acciones
        expect(within(total).getByText('2.596,44')).toBeTruthy();   // caja
        expect(within(total).getByText('11.948,68')).toBeTruthy();  // invertido
        expect(within(total).getByText('+723,02')).toBeTruthy();    // P/L
        expect(within(total).getByText('15.268,14')).toBeTruthy();  // en USD
    });

    it('marks the total as partial and the profile USD value as unknown when FX is missing', async () => {
        vi.mocked(api.fetchProfilesSummary).mockResolvedValue({
            ...summary,
            profiles: [summary.profiles[0], { ...summary.profiles[1], usdRate: null, valueUsd: null }],
            totals: { ...summary.totals, valueUsd: 9116.8, partial: true },
            fx: [],
            fxUnavailable: ['CLP'],
        });
        render(<PortfolioSummaryPage />);
        await screen.findByText(/Total parcial/);
        expect(screen.getByText(/sin tasa de cambio para CLP/)).toBeTruthy();
        const ahorro = profileRow(/Ahorro Chile/);
        expect(within(ahorro).getAllByText('—').length).toBeGreaterThan(0);
    });

    it('shows the USD performance rail with "Sin datos" for missing periods', async () => {
        render(<PortfolioSummaryPage />);
        await ready();
        const rail = screen.getByRole('region', { name: 'Rendimiento (USD)' });
        expect(within(rail).getByText('+0,42 %')).toBeTruthy();
        expect(within(rail).getByText('+63,80')).toBeTruthy();
        expect(within(rail).getByText('−1,10 %')).toBeTruthy();
        expect(within(rail).getAllByText('Sin datos').length).toBe(2);   // 1M y 3M
        expect(within(rail).getByText(/YTD/)).toBeTruthy();
    });

    it('shows the strategy allocation donut legend', async () => {
        render(<PortfolioSummaryPage />);
        await ready();
        const alloc = await screen.findByRole('region', { name: 'Asignación por estrategia' });
        await waitFor(() => expect(within(alloc).getByText('Dividendos')).toBeTruthy());
        expect(within(alloc).getByText('66,9 %')).toBeTruthy(); // share of the slices' sum, not the API pct
        expect(within(alloc).getByText('5.254,90 USD')).toBeTruthy();
        expect(within(alloc).getByText('Caja')).toBeTruthy();
        expect(within(alloc).getByText('2.596,44 USD')).toBeTruthy();
    });

    it('refreshes prices with a loading state, feedback and a reload of the summary', async () => {
        render(<PortfolioSummaryPage />);
        await ready();
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
