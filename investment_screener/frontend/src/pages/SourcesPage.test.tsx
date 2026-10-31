/**
 * @vitest-environment jsdom
 * Purpose: the Fuentes page lists each source with its last run and next scheduled run, syncs
 * one on click (showing the counts), and reports a 409 conflict or a failed sync as a message
 * instead of looking successful.
 * Layer: Frontend integration. Usage: vitest run src/pages/SourcesPage.test.tsx.
 * Key Functions: renders sources, sync success, 409, failed SyncResult, catalogue row.
 * Key Input Dependencies: services/sources.ts is mocked; no backend call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import SourcesPage from './SourcesPage';
import { SyncConflictError, type SourceSummary, type SyncResult } from '../services/sources';

vi.mock('../services/sources', async () => {
    const actual = await vi.importActual<typeof import('../services/sources')>('../services/sources');
    return {
        ...actual,
        fetchSources: vi.fn(),
        fetchStocksOrigin: vi.fn(),
        syncSource: vi.fn(),
    };
});

const { fetchSources, fetchStocksOrigin, syncSource } = await import('../services/sources');

const run = (overrides: Partial<SourceSummary['last_run']> = {}) => ({
    id: 3, source_code: 'racional_gsheet', trigger: 'manual', started_at: '2026-10-30T10:00:00Z',
    finished_at: '2026-10-30T10:00:05Z', status: 'success' as const, fetched: 2577, inserted: 4, updated: 9,
    reactivated: 0, deactivated: 1, rejected: 2, duration_ms: 5000, error_message: null, ...overrides,
});

const source: SourceSummary = {
    source_code: 'racional_gsheet',
    display_name: 'Racional – Stocks disponibles',
    running: false,
    last_run: run(),
    last_success: run(),
    interval_ms: 86_400_000,
    next_due_at: '2026-10-31T10:00:05Z',
};

const syncResult: SyncResult = {
    source_code: 'racional_gsheet', status: 'success', fetched: 2577, inserted: 4, updated: 9,
    reactivated: 1, deactivated: 2, rejected: 0, duration_ms: 4200, error: null, run_id: 11,
};

describe('SourcesPage', () => {
    beforeEach(() => {
        vi.mocked(fetchSources).mockResolvedValue({ sources: [source], scheduler: { enabled: true } });
        vi.mocked(fetchStocksOrigin).mockResolvedValue({
            rows: [{
                id: 1, source_code: 'racional_gsheet', ticker: 'AAPL', company_name: 'Apple, Inc.', asset_type: 'EQUITY',
                sector: 'Technology', industry: 'Consumer Electronics', currency: 'USD', country: 'US', is_active: true,
                platform_url: 'https://app.racional.cl/app/ikEJ?assetId=AAPL', first_seen_at: '2026-01-01', last_seen_at: '2026-10-30T10:00:00Z',
            }],
            total: 1, limit: 50, offset: 0,
        });
        vi.mocked(syncSource).mockResolvedValue(syncResult);
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it('renders every source with its run counts and next scheduled run', async () => {
        render(<SourcesPage />);
        const card = await screen.findByTestId('source-card-racional_gsheet');
        expect(card.textContent).toContain('Racional – Stocks disponibles');
        expect(screen.getByText('Éxito')).toBeTruthy();
        expect(screen.getByText(/2577 leídos/)).toBeTruthy();
        expect(screen.getByText('Próxima programada')).toBeTruthy();
    });

    it('links a catalogue ticker to the public TradingView page and to the platform URL', async () => {
        render(<SourcesPage />);
        const ticker = await screen.findByText('AAPL');
        expect(ticker.getAttribute('href')).toBe('https://www.tradingview.com/symbols/AAPL/');
        expect(ticker.getAttribute('target')).toBe('_blank');
        expect(screen.getByText('Abrir').getAttribute('href')).toContain('app.racional.cl');
    });

    it('clicking Sincronizar posts the sync and shows the resulting counts', async () => {
        render(<SourcesPage />);
        fireEvent.click(await screen.findByText('Sincronizar'));
        await waitFor(() => expect(vi.mocked(syncSource)).toHaveBeenCalledWith('racional_gsheet'));
        expect(await screen.findByText(/4 nuevos · 9 actualizados · 1 reactivados · 2 desactivados/)).toBeTruthy();
        expect(vi.mocked(fetchSources).mock.calls.length).toBeGreaterThan(1);
    });

    it('shows the 409 message when the same source is already syncing', async () => {
        vi.mocked(syncSource).mockRejectedValue(new SyncConflictError("A sync of 'racional_gsheet' is already running"));
        render(<SourcesPage />);
        fireEvent.click(await screen.findByText('Sincronizar'));
        expect((await screen.findByRole('alert')).textContent).toContain('already running');
    });

    it('shows the error of a sync that ran and failed', async () => {
        vi.mocked(syncSource).mockResolvedValue({ ...syncResult, status: 'failed', inserted: 0, updated: 0, error: 'sheet is missing required column(s): URL' });
        render(<SourcesPage />);
        fireEvent.click(await screen.findByText('Sincronizar'));
        expect((await screen.findByRole('alert')).textContent).toContain('missing required column');
    });
});
