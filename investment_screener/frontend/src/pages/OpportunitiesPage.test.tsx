/**
 * @vitest-environment jsdom
 * Purpose: the Oportunidades page walks the 6 guided questions over the Racional universe —
 * each step shows how many stocks remain, "Exigir" refetches with that step required, "Ajustar"
 * changes its thresholds, and the table explains every row in plain Spanish (chips, help "?",
 * detail with the Graham formula, watchlist add). Covers step 5 "¿Es una caída sana?" (Sortino,
 * beta bajista, revisiones), the Dataroma holding facts, the lazily fetched sentiment block and
 * the empty/error states.
 * Layer: Frontend integration. Usage: npx vitest run src/pages/OpportunitiesPage.test.tsx
 * Key Functions: stepper counts, Exigir refetch, Ajustar threshold, row chips, help on focus,
 *     detail panel, sentiment on first expand, watchlist add, SCREEN_DATA_MISSING, zero results.
 * Key Input Dependencies: services/opportunities.ts and services/api.ts are mocked; no backend call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../services/opportunities', async () => {
    const actual = await vi.importActual<typeof import('../services/opportunities')>('../services/opportunities');
    return { ...actual, fetchOpportunities: vi.fn(), fetchSentiment: vi.fn() };
});
vi.mock('../services/api', () => ({ addToWatchlist: vi.fn().mockResolvedValue({ success: true, message: 'ok' }) }));

import OpportunitiesPage from './OpportunitiesPage';
import { resetSentimentCache } from '../components/opportunities/sentimentCache';
import {
    ScreenDataMissingError,
    fetchOpportunities,
    fetchSentiment,
    type OpportunitiesResponse,
    type OpportunityRow,
    type SentimentResponse,
} from '../services/opportunities';
import { addToWatchlist } from '../services/api';

const item = (key: string, label: string, value: number | null, display: string, threshold: string, ok: boolean | null) =>
    ({ key, label, value, display, threshold, ok });

const tmo: OpportunityRow = {
    ticker: 'TMO', name: 'Thermo Fisher Scientific', sector: 'Salud', stars: 5,
    groups: {
        calidad: {
            ok: true, notApplicable: false, items: [
                item('roic', 'Gana por cada $1 invertido (ROIC)', 16.2, '16,2 %', '≥ 15 %', true),
                item('roe', 'Gana sobre el dinero de los dueños (ROE)', 17.4, '17,4 %', '≥ 15 %', true),
            ],
        },
        precio: {
            ok: true, notApplicable: false, items: [
                item('mos', 'Colchón bajo su valor (margen Graham)', 30.2, '30,2 %', '≥ 25 %', true),
            ],
        },
        caida: {
            ok: true, notApplicable: false, items: [
                item('drop', 'Bajó desde su máximo del año', -28.4, '-28,4 %', '≥ 20 %', true),
            ],
        },
        sana: {
            ok: true, notApplicable: false, items: [
                item('sortino', 'Rinde por cada unidad de caída (Sortino 3 años)', 0.8, '0,80', '≥ 0,5', true),
                item('dbeta', 'Cuánto cae cuando cae el S&P (beta bajista)', 0.9, '0,90', '≤ 1,2', true),
                item('rev', 'Revisiones netas de ganancia (30 días)', 2, '+2', '≥ 0', true),
            ],
        },
        expertos: {
            ok: true, notApplicable: false, items: [
                item('sup', 'Grandes inversores compraron', 3, '3 compras', '≥ 1', true),
            ],
        },
    },
    price: 521.83, high52: 729, dropPct: -28.4, eps: 28.6, growthPct: 13,
    graham: { value: 745.3, mos: 30.2, formula: { eps: 28.6, g: 13, y: 6.03 } },
    roic: 16.2, pe: 18.2, sectorPe: 26.4, fcfYield: 5.4, rsi: 31.4, macd: 1.2, macdSignal: 0.8,
    sma50: 505, sma200: 610, aboveSma50: true, belowSma200: true,
    analysts: { buy: 21, hold: 5, sell: 0, total: 26, targetPct: 23 },
    risk: {
        sortino: 0.8, sharpe: 0.42, downsideBeta: 0.9, maxDrawdown: -0.38, recoveryDays: 214,
        volatility: 0.27, asOf: '2026-10-30',
    },
    revisions: { up30: 3, down30: 1, net: 2, up7: 1, down7: 0 },
    dataroma: {
        superinvestors: 3, holdPrice: 694.28, insiders: 1, insiderCluster: false,
        holders: 12, holdersPrev: 10, maxPortfolioPct: 8.4, avgHoldPrice: 694.28,
        belowExpertsPrice: true, netActivity: 2,
        topHolders: [
            { manager: 'Seth Klarman', pct: 8.4, activity: 'Compró 12 %' },
            { manager: 'Chris Davis', pct: 3.1, activity: 'Sin cambios' },
        ],
    },
};

const crbg: OpportunityRow = {
    ticker: 'CRBG', name: 'Corebridge Financial', sector: 'Financiero', stars: 3,
    groups: {
        calidad: {
            ok: false, notApplicable: true, items: [
                item('roic', 'Gana por cada $1 invertido (ROIC)', null, 'No aplica', '≥ 15 %', null),
            ],
        },
        precio: { ok: true, notApplicable: false, items: [item('peg', 'Precio justo para su crecimiento (PEG)', 0.9, '0,90', '≤ 1,0', true)] },
        caida: { ok: true, notApplicable: false, items: [item('drop', 'Bajó desde su máximo del año', -22.3, '-22,3 %', '≥ 20 %', true)] },
        sana: {
            ok: false, notApplicable: false, items: [
                item('sortino', 'Rinde por cada unidad de caída (Sortino 3 años)', null, 'Datos insuficientes', '≥ 0,5', null),
                item('rev', 'Revisiones netas de ganancia (30 días)', -2, '-2', '≥ 0', false),
            ],
        },
        expertos: { ok: false, notApplicable: false, items: [item('sup', 'Grandes inversores compraron', 0, '0 compras', '≥ 1', false)] },
    },
    price: 29.85, high52: 38.4, dropPct: -22.3, eps: 4.95, growthPct: 7,
    graham: { value: 46.2, mos: 35.4, formula: { eps: 4.95, g: 7, y: 6.03 } },
    roic: null, pe: 6, sectorPe: 11.4, fcfYield: null, rsi: 34.1, macd: 0.2, macdSignal: 0.1,
    sma50: 28.4, sma200: 33.1, aboveSma50: true, belowSma200: true,
    analysts: { buy: 9, hold: 5, sell: 0, total: 14, targetPct: 24 },
    risk: null,
    revisions: { up30: 0, down30: 2, net: -2, up7: 0, down7: 1 },
    dataroma: {
        superinvestors: 0, holdPrice: null, insiders: 5, insiderCluster: true,
        holders: 0, holdersPrev: null, maxPortfolioPct: null, avgHoldPrice: null,
        belowExpertsPrice: false, netActivity: null, topHolders: [],
    },
};

const response = (overrides: Partial<OpportunitiesResponse> = {}): OpportunitiesResponse => ({
    asOf: '2026-10-31T14:05:00Z',
    scannerUpdateMode: 'delayed_streaming_900',
    aaaYield: { value: 6.03, asOf: '2026-09-01' },
    universe: 1645,
    steps: [
        { n: 1, id: 'gana', required: true, remaining: 1212 },
        { n: 2, id: 'calidad', required: false, remaining: 486 },
        { n: 3, id: 'precio', required: false, remaining: 131 },
        { n: 4, id: 'caida', required: true, remaining: 38 },
        { n: 5, id: 'sana', required: false, remaining: 21 },
        { n: 6, id: 'expertos', required: false, remaining: 12 },
    ],
    resultCount: 2,
    starHistogram: { '5': 1, '4': 0, '3': 1, '2': 0, '1': 0, '0': 0 },
    rows: [tmo, crbg],
    ...overrides,
});

const sentiment = (overrides: Partial<SentimentResponse> = {}): SentimentResponse => ({
    market: { score: 28, rating: 'Miedo', label: 'El mercado está con miedo', asOf: '2026-10-31T13:00:00Z' },
    ticker: {
        score: 0.42,
        label: 'Positivo',
        headlines: [
            { title: 'Thermo Fisher sube tras sus resultados', publisher: 'Reuters', url: 'https://ejemplo.com/1', publishedAt: '2026-10-31T12:00:00Z', score: 0.6 },
            { title: 'Nuevo contrato en diagnóstico', publisher: 'Bloomberg', url: 'https://ejemplo.com/2', publishedAt: '2026-10-30T12:00:00Z', score: 0.3 },
        ],
        asOf: '2026-10-31T13:00:00Z',
    },
    ...overrides,
});

const renderPage = () => render(<MemoryRouter><OpportunitiesPage /></MemoryRouter>);

/** The page debounces every fetch by 300 ms. */
const settle = async () => {
    await act(async () => {
        vi.advanceTimersByTime(300);
    });
};

/** Lets the lazy sentiment promise resolve inside the expanded row. */
const flush = async () => {
    await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
    });
};

describe('OpportunitiesPage', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.mocked(fetchOpportunities).mockResolvedValue(response());
        vi.mocked(fetchSentiment).mockResolvedValue(sentiment());
        resetSentimentCache();
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('renders the six guided questions with how many stocks remain', async () => {
        renderPage();
        await settle();

        expect(screen.getByRole('heading', { name: 'Oportunidades' })).toBeTruthy();
        expect(screen.getByText('Universo Racional, 1.645 acciones')).toBeTruthy();
        expect(screen.getByRole('heading', { name: 'Encuentra buenas empresas a precio de oferta en 6 preguntas' })).toBeTruthy();

        const steps = screen.getAllByRole('listitem');
        expect(steps).toHaveLength(6);
        expect(within(steps[0]).getByText('¿Gana dinero?')).toBeTruthy();
        expect(within(steps[0]).getByText(/quedan/)).toBeTruthy();
        expect(within(steps[0]).getByText('1.212')).toBeTruthy();
        expect(within(steps[1]).getByText('¿Es un buen negocio?')).toBeTruthy();
        expect(within(steps[1]).getByText('486')).toBeTruthy();
        expect(within(steps[5]).getByText('¿Lo compran los expertos?')).toBeTruthy();
        expect(within(steps[5]).getByText('12')).toBeTruthy();

        // Default required steps are 1 and 4; the rest only add a star.
        expect(within(steps[0]).getByText('Exige')).toBeTruthy();
        expect(within(steps[3]).getByText('Exige')).toBeTruthy();
        expect(within(steps[1]).getByText('Suma ★')).toBeTruthy();
        expect(screen.getByRole('status').textContent).toContain('«sí» a las preguntas 1 y 4');
    });

    it('asks "¿Es una caída sana?" in step 5 and sends its three thresholds', async () => {
        renderPage();
        await settle();

        const steps = screen.getAllByRole('listitem');
        expect(within(steps[4]).getByText('¿Es una caída sana?')).toBeTruthy();
        expect(
            within(steps[4]).getByText(
                'La acción resistió mejor que el mercado en las caídas y los analistas no están bajando sus estimaciones de ganancia.',
            ),
        ).toBeTruthy();
        expect(within(steps[4]).getByText('Sortino 3 años ≥')).toBeTruthy();
        expect(within(steps[4]).getByText('Beta bajista ≤')).toBeTruthy();
        expect(within(steps[4]).getByText('Revisiones netas 30 días ≥')).toBeTruthy();
        expect(
            within(steps[4]).getByText(
                'Sortino: cuánto rinde por cada unidad de caída. Beta bajista: cuánto cae cuando cae el S&P.',
            ),
        ).toBeTruthy();

        const first = vi.mocked(fetchOpportunities).mock.calls[0][0];
        expect(first.sortino).toBe(0.5);
        expect(first.dbeta).toBe(1.2);
        expect(first.rev).toBe(0);
        expect('rsi' in first).toBe(false);

        fireEvent.change(screen.getByLabelText('Umbral Sortino'), { target: { value: '1' } });
        await settle();
        fireEvent.change(screen.getByLabelText('Umbral beta bajista'), { target: { value: '0.8' } });
        await settle();

        const last = vi.mocked(fetchOpportunities).mock.calls.at(-1)![0];
        expect(last.sortino).toBe(1);
        expect(last.dbeta).toBe(0.8);
    });

    it('refetches with the step required and flips its badge when "Exigir" is switched on', async () => {
        renderPage();
        await settle();
        expect(vi.mocked(fetchOpportunities).mock.calls[0][0].require).toEqual([1, 4]);

        const toggle = screen.getByRole('switch', { name: 'Exigir el paso 2: ¿Es un buen negocio?' });
        expect(toggle.getAttribute('aria-checked')).toBe('false');
        fireEvent.click(toggle);
        await settle();

        expect(toggle.getAttribute('aria-checked')).toBe('true');
        const steps = screen.getAllByRole('listitem');
        expect(within(steps[1]).getByText('Exige')).toBeTruthy();
        const last = vi.mocked(fetchOpportunities).mock.calls.at(-1)![0];
        expect(last.require).toEqual([1, 2, 4]);
    });

    it('refetches with the new threshold when an "Ajustar" input changes', async () => {
        renderPage();
        await settle();

        fireEvent.change(screen.getByLabelText('Umbral ROIC'), { target: { value: '20' } });
        await settle();

        const last = vi.mocked(fetchOpportunities).mock.calls.at(-1)![0];
        expect(last.roic).toBe(20);
    });

    it('renders each row with its plain-language verdicts and "No aplica" where ROIC does not apply', async () => {
        renderPage();
        await settle();

        const rowTmo = screen.getByTestId('row-TMO');
        expect(within(rowTmo).getByText('Excelente')).toBeTruthy();
        expect(within(rowTmo).getByText('30 % más barata')).toBeTruthy();
        expect(within(rowTmo).getByText('Compra fuerte')).toBeTruthy();
        expect(within(rowTmo).getByText(/21 de 26 dicen comprar · esperan \+23 %/)).toBeTruthy();

        const rowCrbg = screen.getByTestId('row-CRBG');
        expect(within(rowCrbg).getByText('No aplica')).toBeTruthy();
    });

    it('judges the fall as "Sana" or "Riesgosa" with its Sortino, beta and revisions hint', async () => {
        renderPage();
        await settle();

        const rowTmo = screen.getByTestId('row-TMO');
        expect(within(rowTmo).getByText('Sana')).toBeTruthy();
        expect(within(rowTmo).getByText('Sortino 0,8 · beta 0,9 · revisiones +2')).toBeTruthy();

        // CRBG has no risk history and negative net revisions.
        const rowCrbg = screen.getByTestId('row-CRBG');
        expect(within(rowCrbg).getByText('Riesgosa')).toBeTruthy();
        expect(within(rowCrbg).getByText('Sortino — · beta — · revisiones -2')).toBeTruthy();

        fireEvent.focus(screen.getByRole('button', { name: 'Qué significa: ¿Es una caída sana?' }));
        expect(screen.getByRole('tooltip').textContent).toContain('Sortino');
    });

    it('shows how many superinvestors hold the stock and flags a price below theirs', async () => {
        renderPage();
        await settle();

        const rowTmo = screen.getByTestId('row-TMO');
        expect(within(rowTmo).getByText('3 grandes inversores')).toBeTruthy();
        expect(within(rowTmo).getByText(/12 la tienen/)).toBeTruthy();
        expect(within(rowTmo).getByText('Bajo su precio de compra')).toBeTruthy();

        const rowCrbg = screen.getByTestId('row-CRBG');
        expect(within(rowCrbg).queryByText('Bajo su precio de compra')).toBeNull();
    });

    it('shows a column help text when its "?" button takes keyboard focus', async () => {
        renderPage();
        await settle();

        expect(screen.queryByRole('tooltip')).toBeNull();
        fireEvent.focus(screen.getByRole('button', { name: 'Qué significa: ¿Es buen negocio?' }));

        const tip = screen.getByRole('tooltip');
        expect(tip.textContent).toContain('Favorable ≥ 15 ¢');
    });

    it('opens the detail with the Graham formula filled in and adds the company to the watchlist', async () => {
        renderPage();
        await settle();

        fireEvent.click(screen.getByRole('button', { name: /TMO/ }));

        const detail = screen.getByTestId('detail-TMO');
        expect(within(detail).getByText('¿Por qué tiene 5 de 5 estrellas?')).toBeTruthy();
        expect(within(detail).getByText('¿Cuánto vale realmente?')).toBeTruthy();
        expect(within(detail).getByText('¿Por qué bajó?')).toBeTruthy();
        expect(within(detail).getByText('¿Quién está comprando?')).toBeTruthy();
        expect(within(detail).getByText(/V = 28,60 × \(8,5 \+ 2×13\) × 4,4 \/ 6,03/)).toBeTruthy();
        expect(within(detail).getByText(/V = 745,30 USD/)).toBeTruthy();

        fireEvent.click(within(detail).getByRole('button', { name: 'Agregar a seguimiento' }));
        expect(vi.mocked(addToWatchlist)).toHaveBeenCalledWith('TMO');
        await act(async () => { await Promise.resolve(); });
        expect(within(detail).getByText('Agregada a seguimiento')).toBeTruthy();
    });

    it('explains in the detail whether the fall is healthy, keeping RSI and MACD as information', async () => {
        renderPage();
        await settle();

        fireEvent.click(screen.getByRole('button', { name: /TMO/ }));
        const detail = screen.getByTestId('detail-TMO');
        expect(within(detail).getAllByText('¿Es una caída sana?').length).toBeGreaterThan(0);
        expect(within(detail).getByText(/su peor caída fue −38 % y se recuperó en 214 días/)).toBeTruthy();
        expect(within(detail).getByText(/cae 0,9 veces lo que cae el S&P/)).toBeTruthy();
        expect(within(detail).getByText(/subieron 3 estimaciones y bajaron 1 en el último mes/)).toBeTruthy();
        expect(within(detail).getByText(/Indicadores de corto plazo \(informativos\): RSI 31, MACD al alza/)).toBeTruthy();
    });

    it('says the risk history is missing instead of inventing it', async () => {
        renderPage();
        await settle();

        fireEvent.click(screen.getByRole('button', { name: /CRBG/ }));
        const detail = screen.getByTestId('detail-CRBG');
        expect(within(detail).getByText(/No tenemos suficiente historial/)).toBeTruthy();
        expect(within(detail).getByText(/subieron 0 estimaciones y bajaron 2 en el último mes/)).toBeTruthy();
    });

    it('tells who holds the stock, with what conviction and at what price', async () => {
        renderPage();
        await settle();

        fireEvent.click(screen.getByRole('button', { name: /TMO/ }));
        const detail = screen.getByTestId('detail-TMO');
        expect(detail.textContent).toContain('12 grandes inversores la tienen (+2 vs. el trimestre anterior)');
        expect(detail.textContent).toContain('Para Seth Klarman pesa 8,4 % de su cartera');
        expect(detail.textContent).toContain('Compraron en promedio a 694,28 USD y hoy cuesta 521,83 USD: bajo su precio de compra');
        expect(within(detail).getByText('Chris Davis')).toBeTruthy();
    });

    it('fetches the sentiment only when a row is expanded, and once per ticker', async () => {
        renderPage();
        await settle();
        expect(vi.mocked(fetchSentiment)).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /TMO/ }));
        await flush();

        expect(vi.mocked(fetchSentiment)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetchSentiment)).toHaveBeenCalledWith('TMO');

        const detail = screen.getByTestId('detail-TMO');
        expect(within(detail).getByText('Sentimiento')).toBeTruthy();
        expect(within(detail).getByText(/Miedo/)).toBeTruthy();
        expect(within(detail).getByText('28')).toBeTruthy();
        expect(within(detail).getByText('Positivo')).toBeTruthy();
        const link = within(detail).getByRole('link', { name: /Thermo Fisher sube tras sus resultados/ });
        expect(link.getAttribute('href')).toBe('https://ejemplo.com/1');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
        expect(within(detail).getByText(/Reuters/)).toBeTruthy();
        expect(within(detail).getByText(/no suma estrellas ni filtra/)).toBeTruthy();

        // Collapsing and expanding again reuses the cached answer.
        fireEvent.click(screen.getByRole('button', { name: /TMO/ }));
        fireEvent.click(screen.getByRole('button', { name: /TMO/ }));
        await flush();
        expect(vi.mocked(fetchSentiment)).toHaveBeenCalledTimes(1);
    });

    it('says "No disponible ahora" for the part of the sentiment that failed', async () => {
        vi.mocked(fetchSentiment).mockResolvedValue(sentiment({ market: null }));
        renderPage();
        await settle();

        fireEvent.click(screen.getByRole('button', { name: /TMO/ }));
        await flush();

        const detail = screen.getByTestId('detail-TMO');
        expect(within(detail).getByText('No disponible ahora')).toBeTruthy();
        expect(within(detail).getByText('Positivo')).toBeTruthy();
    });

    it('explains how to load the screener data when the backend has no snapshot yet', async () => {
        vi.mocked(fetchOpportunities).mockRejectedValue(new ScreenDataMissingError('No hay datos del screener'));
        renderPage();
        await settle();

        expect(screen.getByText(/TradingView – métricas del screener/)).toBeTruthy();
        expect(screen.getByRole('link', { name: /Fuentes/ }).getAttribute('href')).toBe('/sources');
    });

    it('tells the user to relax a question when nothing passes', async () => {
        vi.mocked(fetchOpportunities).mockResolvedValue(response({ rows: [], resultCount: 0 }));
        renderPage();
        await settle();

        expect(screen.getByText('Ninguna acción cumple todas las preguntas exigidas: desactiva alguna')).toBeTruthy();
    });
});
