/**
 * @vitest-environment jsdom
 * Purpose: the Compras recientes page renders the quarterly superinvestor table (with the
 * "Disponible en Racional" badge and the quarter selector) and the insiders tab with its
 * filters, the SEC filing link and the same badge.
 * Layer: Frontend integration. Usage: vitest run src/pages/RecentBuysPage.test.tsx.
 * Key Functions: quarterly rows/badge, quarter switch, insiders rows/filters/SEC link.
 * Key Input Dependencies: services/sources.ts is mocked; no backend call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import RecentBuysPage from './RecentBuysPage';
import type { InsiderBuyRow, QuarterlyBuyRow } from '../services/sources';

vi.mock('../services/sources', async () => {
    const actual = await vi.importActual<typeof import('../services/sources')>('../services/sources');
    return {
        ...actual,
        fetchQuarters: vi.fn(),
        fetchQuarterlyBuys: vi.fn(),
        fetchInsiderBuys: vi.fn(),
    };
});

const { fetchQuarters, fetchQuarterlyBuys, fetchInsiderBuys } = await import('../services/sources');

const quarterlyRows: QuarterlyBuyRow[] = [
    { ticker: 'AAPL', quarter: '2026Q3', company_name: 'Apple Inc.', portfolio_pct: 3.2, buys_count: 4, hold_price: 180.5,
        current_price: 210.1, low_52w: 150, pct_above_low_52w: 40.1, high_52w: 240, source_url: 'https://www.dataroma.com/', in_platform: true },
    { ticker: 'XYZ', quarter: '2026Q3', company_name: 'Xyz Corp', portfolio_pct: 1.1, buys_count: 1, hold_price: 10.5,
        current_price: 12, low_52w: 8, pct_above_low_52w: 50, high_52w: 15, source_url: null, in_platform: false },
];

const insiderRows: InsiderBuyRow[] = [
    { ticker: 'NBIS', filing_at: '2026-10-30T18:06', security_name: 'Nebius Group N.V.', reporting_name: 'GRIMME ARNE',
        relationship: 'Director', transaction_date: '2026-10-29', transaction_type: 'Purchase', shares: 148, price: 169.42,
        amount: 25074, ownership_type: 'D', is_ten_pct_owner: false, is_amendment: false,
        filing_url: 'https://www.sec.gov/Archives/edgar/data/1/000.htm', in_platform: true },
];

describe('RecentBuysPage', () => {
    beforeEach(() => {
        vi.mocked(fetchQuarters).mockResolvedValue(['2026Q3', '2026Q2']);
        vi.mocked(fetchQuarterlyBuys).mockResolvedValue({ quarter: '2026Q3', rows: quarterlyRows });
        vi.mocked(fetchInsiderBuys).mockResolvedValue({ rows: insiderRows, days: 30 });
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it('renders the quarterly buys with the Racional availability badge', async () => {
        render(<RecentBuysPage />);
        expect(await screen.findByText('AAPL')).toBeTruthy();
        expect(screen.getByText('Apple Inc.')).toBeTruthy();
        expect(screen.getByText('XYZ')).toBeTruthy();
        expect(screen.getAllByText('Disponible en Racional')).toHaveLength(1);
        expect(screen.getByText('AAPL').getAttribute('href')).toBe('https://www.tradingview.com/symbols/AAPL/');
    });

    it('reloads the table when another quarter is chosen', async () => {
        render(<RecentBuysPage />);
        await screen.findByText('AAPL');
        fireEvent.change(screen.getByLabelText('Trimestre'), { target: { value: '2026Q2' } });
        await waitFor(() => expect(vi.mocked(fetchQuarterlyBuys)).toHaveBeenCalledWith({ quarter: '2026Q2' }));
    });

    it('renders the insiders tab with the SEC filing link and applies the filters', async () => {
        render(<RecentBuysPage />);
        fireEvent.click(screen.getByText('Insiders'));
        expect(await screen.findByText('NBIS')).toBeTruthy();
        expect(screen.getByText('GRIMME ARNE')).toBeTruthy();
        expect(screen.getByText('Ver').getAttribute('href')).toContain('sec.gov');
        expect(screen.getByText('Disponible en Racional')).toBeTruthy();

        fireEvent.click(screen.getByLabelText(/Solo dueños 10%/));
        await waitFor(() => expect(vi.mocked(fetchInsiderBuys)).toHaveBeenCalledWith(
            expect.objectContaining({ tenPctOnly: true, days: 30 })
        ));
    });
});
