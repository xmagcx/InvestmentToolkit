/**
 * @vitest-environment jsdom
 * Purpose: the "Brief diario" page is the prioritized review list of artboard
 *     design/daily-brief/02-lista-del-dia.html — Spanish header with the date and how many
 *     things to review, slim market bar, the day's tasks ordered by urgency with their link,
 *     the TA-stale notice, the collapsed table of holdings without tasks, and the regenerate
 *     flow (202 → polling → reload, 409 → already running). Covers the empty states too.
 * Layer: Frontend integration. Usage: npx vitest run src/pages/DailyBriefPage.test.tsx
 * Key Functions: header, task list, "Abrir análisis", "Agregar a seguimiento", TA notice,
 *     untasked details, regenerate polling, 409, NO_BRIEF empty state, zero tasks.
 * Key Input Dependencies: services/dailyBrief.ts and services/api.ts are mocked; no backend call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

vi.mock('../services/dailyBrief', async () => {
    const actual = await vi.importActual<typeof import('../services/dailyBrief')>('../services/dailyBrief');
    return {
        ...actual,
        fetchTodayBrief: vi.fn(),
        startBriefRegeneration: vi.fn(),
        fetchRegenerationStatus: vi.fn(),
    };
});
vi.mock('../services/api', () => ({ addToWatchlist: vi.fn().mockResolvedValue({ success: true, message: 'ok' }) }));

import DailyBriefPage from './DailyBriefPage';
import {
    BriefBusyError,
    NoBriefError,
    fetchRegenerationStatus,
    fetchTodayBrief,
    startBriefRegeneration,
    type DailyBriefToday,
} from '../services/dailyBrief';
import { addToWatchlist } from '../services/api';

const brief = (overrides: Partial<DailyBriefToday> = {}): DailyBriefToday => ({
    date: '2026-10-30',
    generatedAt: '2026-10-30T23:28:00-03:00',
    market: {
        regime: 'NEUTRAL',
        label: 'Mercado neutral', // as brief_tasks.py sends it
        sentence: 'No hay una tendencia clara: el índice sube, pero solo 7 % de tus acciones lo acompaña.',
        indicators: [
            { key: 'vix', label: 'VIX', value: 19.4, display: '19,4' },
            { key: 'spy_vs_200d', label: 'S&P vs. 200d', value: 4.1, display: '+4,1 %' },
            { key: 'amplitud', label: 'Amplitud', value: 7, display: '7 %' },
            { key: 'credito', label: 'Crédito', value: null, display: 'sano' },
        ],
    },
    tasks: [
        {
            urgency: 'media', ticker: 'TMUS',
            summary: 'Saltó +4,85 % anoche (149,20 → 156,44 USD) sin noticia registrada en el sistema.',
            action: 'Buscar la causa', tag: 'Subida sin explicación', link: 'analysis',
        },
        {
            urgency: 'baja', ticker: 'NVDA',
            summary: 'Cayó −2,62 % (210,15 → 204,64 USD), pero sigue en tendencia al alza.',
            action: 'Sin acción', tag: 'Está en seguimiento', link: 'watchlist',
        },
        {
            urgency: 'alta', ticker: 'APP',
            summary: 'Se desplomó −9,62 % anoche (252,83 → 228,50 USD) y publica resultados el 4 de noviembre.',
            action: 'Revisar la tesis', tag: 'Sobreventa: RSI 24,9', link: 'analysis',
        },
    ],
    untasked: [
        { ticker: 'MCD', status: 'Mantener', rsi: 68.2, note: 'Tendencia fuerte' },
        { ticker: 'PEP', status: 'Mantener', rsi: 61.4, note: 'Sin cambios' },
        { ticker: 'TSMC', status: 'En seguimiento', rsi: null, note: 'Sin historial suficiente' },
    ],
    taFresh: true,
    taNote: null,
    counts: { tasks: 3, untasked: 3 },
    ...overrides,
});

const renderPage = () => render(
    <MemoryRouter initialEntries={['/daily-brief']}>
        <Routes>
            <Route path="/daily-brief" element={<DailyBriefPage />} />
            <Route path="/analysis" element={<p>Página de análisis</p>} />
        </Routes>
    </MemoryRouter>,
);

/** Lets the mocked promises settle. */
const settle = async () => { await act(async () => { await Promise.resolve(); }); };

describe('DailyBriefPage', () => {
    beforeEach(() => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-10-30T23:40:00-03:00'));
        vi.mocked(fetchTodayBrief).mockResolvedValue(brief());
        vi.mocked(startBriefRegeneration).mockResolvedValue(undefined);
        vi.mocked(fetchRegenerationStatus).mockResolvedValue({
            running: false, startedAt: null, finishedAt: null, exitCode: 0,
        });
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
        vi.useRealTimers();
    });

    it('heads the page with the Spanish date, how many things to review and when it was generated', async () => {
        renderPage();
        await settle();

        expect(screen.getByRole('heading', { name: 'Brief diario' })).toBeTruthy();
        expect(screen.getByText(/Viernes 30 de octubre de 2026/)).toBeTruthy();
        expect(screen.getByText(/3 cosas para revisar, de más a menos urgente/)).toBeTruthy();
        expect(screen.getByText('Generado hoy a las 23:28')).toBeTruthy();
        expect(screen.getByText(
            (_, el) => el?.tagName === 'P' && el.textContent === 'Mercado neutral',
        )).toBeTruthy();
        expect(screen.getByText(/No hay una tendencia clara/)).toBeTruthy();
        expect(screen.getByText('+4,1 %')).toBeTruthy();
        expect(screen.getByText(
            'Ninguna de estas tareas es una orden de compra o venta: son revisiones sugeridas.',
        )).toBeTruthy();
    });

    it('lists the tasks from most to least urgent with their urgency badge in words', async () => {
        renderPage();
        await settle();

        const tasks = screen.getAllByRole('listitem');
        expect(tasks).toHaveLength(3);
        expect(within(tasks[0]).getByText('APP')).toBeTruthy();
        expect(within(tasks[0]).getByText('Alta')).toBeTruthy();
        expect(within(tasks[0]).getByText(/Se desplomó −9,62 %/)).toBeTruthy();
        expect(within(tasks[0]).getByText('Revisar la tesis')).toBeTruthy();
        expect(within(tasks[0]).getByText('Sobreventa: RSI 24,9')).toBeTruthy();
        expect(within(tasks[1]).getByText('TMUS')).toBeTruthy();
        expect(within(tasks[1]).getByText('Media')).toBeTruthy();
        expect(within(tasks[2]).getByText('NVDA')).toBeTruthy();
        expect(within(tasks[2]).getByText('Baja')).toBeTruthy();
    });

    it('navigates to the ticker analysis from "Abrir análisis"', async () => {
        renderPage();
        await settle();

        const link = screen.getAllByRole('link', { name: 'Abrir análisis' })[0];
        expect(link.getAttribute('href')).toBe('/analysis?ticker=APP');
        fireEvent.click(link);
        expect(screen.getByText('Página de análisis')).toBeTruthy();
    });

    it('adds the ticker to the watchlist from "Agregar a seguimiento"', async () => {
        renderPage();
        await settle();

        fireEvent.click(screen.getByRole('button', { name: 'Agregar a seguimiento' }));
        expect(vi.mocked(addToWatchlist)).toHaveBeenCalledWith('NVDA');
        await settle();
        expect(screen.getByText('Agregada a seguimiento')).toBeTruthy();
    });

    it('warns when the technical analysis was not refreshed today', async () => {
        vi.mocked(fetchTodayBrief).mockResolvedValue(brief({
            taFresh: false,
            taNote: 'RSI y tendencia vienen del cierre anterior.',
        }));
        renderPage();
        await settle();

        expect(screen.getByText(/Análisis técnico no actualizado hoy/)).toBeTruthy();
        expect(screen.getByText(/RSI y tendencia vienen del cierre anterior\./)).toBeTruthy();
    });

    it('hides the holdings without tasks behind a collapsed table', async () => {
        renderPage();
        await settle();

        const details = screen.getByText('Ver las otras 3 acciones sin tareas para hoy');
        fireEvent.click(details);

        const rows = screen.getAllByRole('row');
        // 1 header + 3 holdings
        expect(rows).toHaveLength(4);
        expect(within(rows[1]).getByText('MCD')).toBeTruthy();
        expect(within(rows[1]).getByText('Mantener')).toBeTruthy();
        expect(within(rows[1]).getByText('68,2')).toBeTruthy();
        expect(within(rows[3]).getByText('—')).toBeTruthy();
    });

    it('regenerates the brief: starts it, polls the status and reloads when it finishes', async () => {
        vi.mocked(fetchRegenerationStatus)
            .mockResolvedValueOnce({ running: true, startedAt: '2026-10-30T23:41:00-03:00', finishedAt: null, exitCode: null })
            .mockResolvedValueOnce({ running: false, startedAt: '2026-10-30T23:41:00-03:00', finishedAt: '2026-10-30T23:42:00-03:00', exitCode: 0 });
        renderPage();
        await settle();

        fireEvent.click(screen.getByRole('button', { name: '↻ Regenerar brief' }));
        await settle();
        expect(vi.mocked(startBriefRegeneration)).toHaveBeenCalledTimes(1);
        expect(screen.getByRole('status').textContent).toContain('Generando el brief…');

        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(vi.mocked(fetchRegenerationStatus)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetchTodayBrief)).toHaveBeenCalledTimes(1);

        await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
        expect(vi.mocked(fetchRegenerationStatus)).toHaveBeenCalledTimes(2);
        expect(vi.mocked(fetchTodayBrief)).toHaveBeenCalledTimes(2);
        expect(screen.getByRole('status').textContent).not.toContain('Generando el brief…');
    });

    it('says the brief is already being generated when the backend answers 409', async () => {
        vi.mocked(startBriefRegeneration).mockRejectedValue(new BriefBusyError('busy'));
        renderPage();
        await settle();

        fireEvent.click(screen.getByRole('button', { name: '↻ Regenerar brief' }));
        await settle();

        expect(screen.getByRole('status').textContent).toContain('Ya se está generando');
    });

    it('offers to generate the brief when there is none for today', async () => {
        vi.mocked(fetchTodayBrief).mockRejectedValue(new NoBriefError('no brief'));
        renderPage();
        await settle();

        expect(screen.getByText('Todavía no hay brief de hoy')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: '↻ Regenerar brief' }));
        await settle();
        expect(vi.mocked(startBriefRegeneration)).toHaveBeenCalledTimes(1);
    });

    it('says the day is calm when the brief has no tasks', async () => {
        vi.mocked(fetchTodayBrief).mockResolvedValue(brief({ tasks: [], counts: { tasks: 0, untasked: 3 } }));
        renderPage();
        await settle();

        expect(screen.getByText('Hoy no hay nada urgente que revisar')).toBeTruthy();
    });

    it('shows the error when the brief cannot be loaded', async () => {
        vi.mocked(fetchTodayBrief).mockRejectedValue(new Error('Se cayó la red'));
        renderPage();
        await settle();

        expect(screen.getByText(/Se cayó la red/)).toBeTruthy();
    });
});
