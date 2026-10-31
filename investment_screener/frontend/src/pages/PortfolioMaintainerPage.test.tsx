/**
 * @vitest-environment jsdom
 * Purpose: the Portafolio page maintains portfolio profiles by hand — it creates a profile,
 * deposits into the wallet, adds (buys) a stock, sells, deletes a position behind a
 * confirmation, renders the transaction history and surfaces an API error instead of
 * looking successful.
 * Layer: Frontend integration. Usage: vitest run src/pages/PortfolioMaintainerPage.test.tsx.
 * Key Input Dependencies: services/api.ts is mocked; no backend call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import PortfolioMaintainerPage from './PortfolioMaintainerPage';

vi.mock('../services/api', async () => {
    const actual = await vi.importActual<typeof import('../services/api')>('../services/api');
    return {
        ...actual,
        fetchMaintainerAccounts: vi.fn(),
        fetchMaintainerPositions: vi.fn(),
        fetchMaintainerTransactions: vi.fn(),
        createMaintainerAccount: vi.fn(),
        updateMaintainerAccount: vi.fn(),
        deleteMaintainerAccount: vi.fn(),
        moveMaintainerCash: vi.fn(),
        submitMaintainerTransaction: vi.fn(),
        deleteMaintainerPosition: vi.fn(),
    };
});

const api = await import('../services/api');

const account = { accountId: 'racional', name: 'racional', type: 'PROFILE', currency: 'USD', cash: 1700 };
const position = { accountId: 'racional', ticker: 'AAPL', qty: 10, avgCost: 150, currency: 'USD', price: 200, priceAsOf: '2026-10-30T20:00:00Z' };
const transaction = {
    entryId: 'e1', ticker: 'AAPL', action: 'BUY', shares: 10, price: 150, totalCost: 1500,
    notes: 'opened', loggedAt: '2026-01-02T10:00:00Z',
};

/** Fill one labelled input. */
function type(label: RegExp | string, value: string) {
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
}

describe('PortfolioMaintainerPage', () => {
    beforeEach(() => {
        vi.mocked(api.fetchMaintainerAccounts).mockResolvedValue([account]);
        vi.mocked(api.fetchMaintainerPositions).mockResolvedValue([position]);
        vi.mocked(api.fetchMaintainerTransactions).mockResolvedValue([transaction]);
        vi.mocked(api.createMaintainerAccount).mockResolvedValue({ ...account, accountId: 'Nuevo', name: 'Nuevo', cash: 0 });
        vi.mocked(api.deleteMaintainerAccount).mockResolvedValue({ deleted: 'racional' });
        vi.mocked(api.moveMaintainerCash).mockResolvedValue({ accountId: 'racional', cash: 1800, currency: 'USD' });
        vi.mocked(api.submitMaintainerTransaction).mockResolvedValue({
            position: { ticker: 'AAPL', qty: 11, avgCost: 155 }, cash: 1500, currency: 'USD',
        });
        vi.mocked(api.deleteMaintainerPosition).mockResolvedValue({ deleted: 'AAPL' });
    });

    afterEach(() => {
        cleanup();
        vi.clearAllMocks();
    });

    it('shows no price and no P/L for an unpriced position instead of echoing its cost', async () => {
        vi.mocked(api.fetchMaintainerPositions).mockResolvedValue([{ ...position, price: null, priceAsOf: null }]);
        render(<PortfolioMaintainerPage />);
        const row = (await screen.findAllByText('AAPL'))[0].closest('tr') as HTMLElement;
        const cells = Array.from(row.querySelectorAll('td')).map(td => td.textContent?.trim());
        expect(cells[4]).toBe('—'); // Precio actual
        expect(cells[5]).toBe('—'); // P/L
    });

    it('renders the wallet, the positions and the transaction history of the profile', async () => {
        render(<PortfolioMaintainerPage />);
        expect((await screen.findAllByText('AAPL')).length).toBe(2); // position row + history row
        expect(screen.getByText(/1700\.00/)).toBeTruthy();
        expect(screen.getByText('BUY')).toBeTruthy();
        // current price 200 vs avg cost 150 on 10 shares → P/L 500
        expect(screen.getByText(/\+500\.00/)).toBeTruthy();
    });

    it('creates a profile', async () => {
        render(<PortfolioMaintainerPage />);
        fireEvent.click(await screen.findByRole('button', { name: /nuevo perfil/i }));
        type(/nombre del perfil/i, 'Nuevo');
        fireEvent.click(screen.getByRole('button', { name: /^crear$/i }));
        await waitFor(() => expect(api.createMaintainerAccount).toHaveBeenCalledWith('Nuevo', 'PROFILE', 'USD'));
    });

    it('deposits into the wallet', async () => {
        render(<PortfolioMaintainerPage />);
        await screen.findAllByText('AAPL');
        type(/monto/i, '100');
        fireEvent.click(screen.getByRole('button', { name: /depositar/i }));
        await waitFor(() => expect(api.moveMaintainerCash).toHaveBeenCalledWith('racional', 'deposit', 100, undefined));
    });

    it('adds a stock as a buy transaction', async () => {
        render(<PortfolioMaintainerPage />);
        await screen.findAllByText('AAPL');
        type(/ticker/i, 'msft');
        type(/cantidad/i, '3');
        type(/precio/i, '400');
        fireEvent.click(screen.getByRole('button', { name: /agregar acción/i }));
        await waitFor(() => expect(api.submitMaintainerTransaction).toHaveBeenCalledWith({
            accountId: 'racional', ticker: 'MSFT', side: 'BUY', qty: 3, price: 400, commission: 0,
        }));
    });

    it('sells from a position', async () => {
        render(<PortfolioMaintainerPage />);
        fireEvent.click(await screen.findByRole('button', { name: /vender/i }));
        type(/cantidad a operar/i, '2');
        type(/precio de la operación/i, '210');
        fireEvent.click(screen.getByRole('button', { name: /confirmar venta/i }));
        await waitFor(() => expect(api.submitMaintainerTransaction).toHaveBeenCalledWith({
            accountId: 'racional', ticker: 'AAPL', side: 'SELL', qty: 2, price: 210, commission: 0,
        }));
    });

    it('deletes a position only after confirmation', async () => {
        render(<PortfolioMaintainerPage />);
        fireEvent.click(await screen.findByRole('button', { name: /^eliminar$/i }));
        expect(api.deleteMaintainerPosition).not.toHaveBeenCalled();
        fireEvent.click(screen.getByRole('button', { name: /confirmar eliminación/i }));
        await waitFor(() => expect(api.deleteMaintainerPosition).toHaveBeenCalledWith('racional', 'AAPL'));
    });

    it('shows the API error instead of looking successful', async () => {
        vi.mocked(api.moveMaintainerCash).mockRejectedValue(new Error('Insufficient USD cash'));
        render(<PortfolioMaintainerPage />);
        await screen.findAllByText('AAPL');
        type(/monto/i, '5000');
        fireEvent.click(screen.getByRole('button', { name: /retirar/i }));
        expect(await screen.findByText(/Insufficient USD cash/)).toBeTruthy();
    });
});
