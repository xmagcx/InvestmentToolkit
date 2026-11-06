/**
 * @vitest-environment jsdom
 * Purpose: the Análisis page (S1–S7, S16): header identity and price, fair value from our projection (null → no
 * placeholder and no margin of safety), metric state words, signal mapping, value-chart ranges and hide toggle.
 * Layer: Frontend integration. Usage: npx vitest run src/pages/AnalysisPage.test.tsx
 * Key Input Dependencies: services/api.ts is mocked; RecommendationsContext is provided by the test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/api', () => ({
    fetchStockData: vi.fn(), fetchValueHistory: vi.fn(), fetchMonteCarlo: vi.fn(), fetchNewsSentiment: vi.fn(), fetchFilings: vi.fn(),
    fetchSuperinvestors: vi.fn(), fetchTechnicalAnalysis: vi.fn(),
}));

import AnalysisPage from './AnalysisPage';
import { RecommendationsContext } from '../contexts/useRecommendations';
import { fetchFilings, fetchMonteCarlo, fetchNewsSentiment, fetchStockData, fetchSuperinvestors, fetchTechnicalAnalysis, fetchValueHistory, type RecommendationRecord, type StockData, type ValueHistory } from '../services/api';

const stock = {
    symbol: 'MSFT', price: 535.93, currency: 'USD',
    profile: { sector: 'Tecnología', industry: 'Software', description: '' },
    metrics: { beta: 0.94, market_cap: 3.98e12 },
    overview: {
        profile: { name: 'Microsoft Corporation', sector: 'Technology', industry: 'Software—Infrastructure', country: 'United States',
            currency: 'USD', market_cap: 3.98e12 },
        profitability: { roic: 23.81, roe: 31.25, roa: 18.55, rona: null },
        yields: { fcf_yield: 4.75, dividend_yield: 0.65, buyback_yield: 0.01, augmented_yield: null },
        balance: { debt_to_equity: null },
        cost_of_capital: { beta: 0.94, wacc: 9.65, discount_rate: null },
    },
} as unknown as StockData;

const history = (fairValue: number | null): ValueHistory => ({
    ticker: 'MSFT', currency: 'USD',
    points: [
        { date: '2025-01-01', price: 400, fair_value: fairValue === null ? null : 420, sma200: 380 },
        { date: '2026-01-01', price: 535.93, fair_value: fairValue, sma200: 450 },
    ],
    current: { price: 535.93, fair_value: fairValue, date: '2026-01-01', sma200: 450, zone: 'sobrevalorada', distance_pct: 19.09,
        confirmation: { price: 560, basis: 'Fibonacci 0.382', distance_pct: 4.49 } },
    levels: { supports: [], resistances: [{ price: 560, basis: 'Fibonacci 0.382' }] },
});

const rec = (over: Partial<RecommendationRecord> = {}): RecommendationRecord => ({
    ticker: 'MSFT', action: 'MAINTAIN', reason: 'Dentro del margen', valuation: 'HOLD', upside_pct: -12.5,
    current_weight_pct: 0, held: true, fair_value: 468.9, price: 535.93, standing_decision: null, ...over,
});

function renderPage(recs: Record<string, RecommendationRecord> = {}) {
    return render(
        <RecommendationsContext.Provider value={recs}>
            <MemoryRouter initialEntries={['/analysis?ticker=MSFT']}><AnalysisPage /></MemoryRouter>
        </RecommendationsContext.Provider>,
    );
}

beforeEach(() => {
    localStorage.clear();
    vi.mocked(fetchStockData).mockResolvedValue(stock);
    vi.mocked(fetchValueHistory).mockResolvedValue(history(468.9));
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('header card (Nivel 1 · Escanear)', () => {
    it('shows identity from overview.profile, price with date and the level labels', async () => {
        renderPage({ MSFT: rec() });
        expect(await screen.findByText('Microsoft Corporation')).toBeTruthy();
        expect(screen.getByText('MSFT')).toBeTruthy();
        const header = within(screen.getByRole('region', { name: 'Nivel 1 · Escanear' }));
        expect(header.getByText(/Technology · Software—Infrastructure/)).toBeTruthy();
        expect(header.getByText(/United States · USD · 3,98 T USD/)).toBeTruthy();
        expect(screen.getByText('535,93 USD')).toBeTruthy();
        expect(screen.getByTestId('price-date').textContent).toContain('2026-01-01');
        expect(screen.getByText('Nivel 1 · Escanear')).toBeTruthy();
        expect(screen.getByText('Nivel 2 · Entender')).toBeTruthy();
        expect(screen.getByText('Nivel 3 · Investigar')).toBeTruthy();
        expect(fetchStockData).toHaveBeenCalledWith('MSFT');
    });

    it('shows our fair value and the margin of safety when a projection exists', async () => {
        renderPage({ MSFT: rec() });
        await screen.findByText('Microsoft Corporation');
        expect(screen.getByTestId('fair-value').textContent).toContain('468,90 USD');
        expect(screen.getByTestId('metric-mos').textContent).toContain('-14,3%');
    });

    it('without a projection shows "Sin valoración guardada", no margin of safety and no placeholder number', async () => {
        vi.mocked(fetchValueHistory).mockResolvedValue(history(null));
        renderPage({});
        await screen.findByText('Microsoft Corporation');
        expect(screen.getByTestId('fair-value').textContent).toBe('Sin valoración guardada');
        expect(screen.queryByTestId('metric-mos')).toBeNull();
    });

    it('lists metrics with a state word and omits null metrics', async () => {
        renderPage({ MSFT: rec() });
        await screen.findByText('Microsoft Corporation');
        expect(within(screen.getByTestId('metric-roic')).getByText(/Fuerte/)).toBeTruthy();
        expect(within(screen.getByTestId('metric-mos')).getByText(/Débil/)).toBeTruthy();
        expect(within(screen.getByTestId('metric-divy')).getByText(/Neutral/)).toBeTruthy();
        expect(within(screen.getByTestId('metric-buyback')).getByText(/Débil/)).toBeTruthy();
        expect(screen.queryByTestId('metric-augdiv')).toBeNull();
        expect(screen.queryByTestId('metric-de')).toBeNull();
        expect(screen.getByRole('button', { name: '¿Qué es ROIC?' })).toBeTruthy();
    });
});

describe('signal (Nivel 2 · Entender)', () => {
    it.each([
        ['INITIATE', 'Comprar'], ['ACCUMULATE', 'Comprar más'], ['MAINTAIN', 'Mantener'],
        ['TRIM', 'Vender (reducir)'], ['EXIT', 'Vender (todo)'], ['WATCHLIST', 'En vigilancia'],
    ] as const)('%s renders %s', async (action, label) => {
        renderPage({ MSFT: rec({ action }) });
        await screen.findByText('Microsoft Corporation');
        expect(within(screen.getByTestId('signal-chip')).getByText(label)).toBeTruthy();
    });

    it('with no recommendation entry shows "Sin señal" and the reason', async () => {
        renderPage({});
        await screen.findByText('Microsoft Corporation');
        expect(within(screen.getByTestId('signal-chip')).getByText('Sin señal')).toBeTruthy();
        expect(screen.getByText(/no hay valoración guardada/i)).toBeTruthy();
    });

    it('shows the scale, the rules and the suspension note', async () => {
        renderPage({ MSFT: rec() });
        await screen.findByText('Microsoft Corporation');
        for (const t of ['Vender', 'Mantener', 'Comprar']) expect(within(screen.getByTestId('signal-scale')).getByText(t)).toBeTruthy();
        expect(screen.getByTestId('signal-marker').textContent).toContain('-12,5%');
        expect(screen.getByText(/más de 30 días/)).toBeTruthy();
    });
});

describe('value chart', () => {
    it('range buttons call fetchValueHistory with the range and set aria-pressed', async () => {
        renderPage({ MSFT: rec() });
        await screen.findByText('Microsoft Corporation');
        expect(fetchValueHistory).toHaveBeenCalledWith('MSFT', '1y');
        expect(screen.getByRole('button', { name: '1A' }).getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: '5A' }));
        await waitFor(() => expect(fetchValueHistory).toHaveBeenCalledWith('MSFT', '5y'));
        expect(screen.getByRole('button', { name: '5A' }).getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: '3A' }));
        await waitFor(() => expect(fetchValueHistory).toHaveBeenCalledWith('MSFT', '3y'));
        fireEvent.click(screen.getByRole('button', { name: 'MÁX' }));
        await waitFor(() => expect(fetchValueHistory).toHaveBeenCalledWith('MSFT', 'max'));
    });

    it('"Ocultar valoración" hides the fair-value line', async () => {
        renderPage({ MSFT: rec() });
        await screen.findByText('Microsoft Corporation');
        await screen.findByTestId('value-line');
        const toggle = screen.getByRole('button', { name: 'Ocultar valoración' });
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(toggle);
        expect(screen.queryByTestId('value-line')).toBeNull();
        expect(screen.getByRole('button', { name: 'Ocultar valoración' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('shows the price only with a note when the fair value series is all null', async () => {
        vi.mocked(fetchValueHistory).mockResolvedValue(history(null));
        renderPage({});
        await screen.findByText('Microsoft Corporation');
        expect(await screen.findByTestId('price-line')).toBeTruthy();
        expect(screen.queryByTestId('value-line')).toBeNull();
        expect(screen.getByText('Sin historial de valoración')).toBeTruthy();
    });
});

describe('tabs (Nivel 3)', () => {
    it('renders the 8 tab buttons and opens on Descripción with the organization facts', async () => {
        renderPage({});
        await screen.findByText('Microsoft Corporation');
        const tabs = within(screen.getByRole('tablist')).getAllByRole('tab').map(t => t.textContent);
        expect(tabs).toEqual(['Descripción', 'Financieros', 'Valoración', 'Inversores', 'Filings', 'Monte Carlo', 'Técnico', 'Noticias']);
        expect(screen.getByRole('tab', { name: 'Descripción' }).getAttribute('aria-selected')).toBe('true');
        expect(screen.getByRole('table', { name: 'Datos generales de la organización' })).toBeTruthy();
    });

    it('Valoración uses the same fair value as the header', async () => {
        renderPage({ MSFT: rec() });
        await screen.findByText('Microsoft Corporation');
        fireEvent.click(screen.getByRole('tab', { name: 'Valoración' }));
        const row = within(screen.getByRole('table', { name: 'Métodos de valoración' })).getByText('Proyección propia').closest('tr')!;
        expect(row.textContent).toContain('468,90 USD');
        expect(row.textContent).toContain('Escenarios DCF');
    });

    it('fetches tab data only after the tab opens, once per ticker (reopening reuses it)', async () => {
        vi.mocked(fetchMonteCarlo).mockResolvedValue(null);
        vi.mocked(fetchNewsSentiment).mockResolvedValue(null);
        renderPage({});
        await screen.findByText('Microsoft Corporation');
        for (const f of [fetchMonteCarlo, fetchNewsSentiment, fetchFilings, fetchSuperinvestors, fetchTechnicalAnalysis]) expect(f).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('tab', { name: 'Monte Carlo' }));
        expect(await screen.findByText(/Sin proyección guardada/)).toBeTruthy();
        expect(fetchMonteCarlo).toHaveBeenCalledTimes(1);
        expect(fetchMonteCarlo).toHaveBeenCalledWith('MSFT');
        expect(fetchNewsSentiment).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('tab', { name: 'Noticias' }));
        expect(await screen.findByText('No se pudieron cargar las noticias.')).toBeTruthy();
        fireEvent.click(screen.getByRole('tab', { name: 'Monte Carlo' }));
        expect(await screen.findByText(/Sin proyección guardada/)).toBeTruthy();
        expect(fetchMonteCarlo).toHaveBeenCalledTimes(1);
        expect(fetchSuperinvestors).not.toHaveBeenCalled();
    });
});
