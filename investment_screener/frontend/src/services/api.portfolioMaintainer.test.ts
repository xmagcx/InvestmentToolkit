/**
 * api.portfolioMaintainer.test.ts (Portfolio Maintainer API client)
 *
 * Purpose:
 *     Covers the maintainer service-layer client functions: fetchMaintainerAccounts(),
 *     createMaintainerAccount(), setMaintainerInitialCash(), fetchMaintainerPositions(),
 *     submitMaintainerTransaction(), and deleteMaintainerPosition(). Uses the same
 *     mocked-`fetch` harness as api.universe.test.ts / api.test.ts (node env, no
 *     jsdom — component render testing is out of scope).
 *
 * Layer: Frontend / Services (vitest)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    fetchMaintainerAccounts,
    createMaintainerAccount,
    setMaintainerInitialCash,
    fetchMaintainerPositions,
    submitMaintainerTransaction,
    deleteMaintainerPosition,
} from './api';

function okFetch(body: unknown): Response {
    return { ok: true, json: async () => body } as Response;
}

function errFetch(status: number, error: string): Response {
    return { ok: false, status, json: async () => ({ error }) } as Response;
}

describe('portfolio maintainer API client', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('fetchMaintainerAccounts GETs /api/portfolio-maintainer/accounts', async () => {
        const acct = { accountId: 'TFSA One', name: 'TFSA One', type: 'TFSA', currency: 'CAD', cash: 5000 };
        vi.stubGlobal('fetch', vi.fn(async () => okFetch([acct])));
        const result = await fetchMaintainerAccounts();
        expect(fetch).toHaveBeenCalledWith('/api/portfolio-maintainer/accounts');
        expect(result).toEqual([acct]);
    });

    it('fetchMaintainerAccounts throws on error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => errFetch(500, 'boom')));
        await expect(fetchMaintainerAccounts()).rejects.toThrow('boom');
    });

    it('createMaintainerAccount POSTs name/type and returns the account', async () => {
        const acct = { accountId: 'TFSA One', name: 'TFSA One', type: 'TFSA', currency: 'CAD', cash: 0 };
        const fetchMock = vi.fn(async () => okFetch(acct));
        vi.stubGlobal('fetch', fetchMock);
        const result = await createMaintainerAccount('TFSA One', 'TFSA');
        expect(fetchMock).toHaveBeenCalledWith('/api/portfolio-maintainer/accounts', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ name: 'TFSA One', type: 'TFSA', currency: undefined }),
        }));
        expect(result).toEqual(acct);
    });

    it('setMaintainerInitialCash POSTs /:id/cash and returns cash', async () => {
        const fetchMock = vi.fn(async () => okFetch({ accountId: 'TFSA One', cash: 5000 }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await setMaintainerInitialCash('TFSA One', 5000);
        expect(fetchMock).toHaveBeenCalledWith('/api/portfolio-maintainer/accounts/TFSA%20One/cash', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ amount: 5000 }),
        }));
        expect(result.cash).to.equal(5000);
    });

    it('fetchMaintainerPositions GETs /positions', async () => {
        const pos = { accountId: 'TFSA One', ticker: 'AAPL', qty: 2, avgCost: 55, currency: 'CAD' };
        vi.stubGlobal('fetch', vi.fn(async () => okFetch([pos])));
        const result = await fetchMaintainerPositions();
        expect(fetch).toHaveBeenCalledWith('/api/portfolio-maintainer/positions');
        expect(result).toEqual([pos]);
    });

    it('submitMaintainerTransaction POSTs the buy and returns position+cash', async () => {
        const fetchMock = vi.fn(async () => okFetch({ position: { ticker: 'AAPL', qty: 2, avgCost: 55 }, cash: 890, currency: 'CAD' }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await submitMaintainerTransaction({ accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 });
        expect(fetchMock).toHaveBeenCalledWith('/api/portfolio-maintainer/transaction', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50, commission: 10 }),
        }));
        expect(result.cash).to.equal(890);
    });

    it('submitMaintainerTransaction throws on overspend error', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => errFetch(400, 'Insufficient CAD cash')));
        await expect(submitMaintainerTransaction({ accountId: 'TFSA One', ticker: 'AAPL', side: 'BUY', qty: 2, price: 50 }))
            .rejects.toThrow('Insufficient CAD cash');
    });

    it('deleteMaintainerPosition sends DELETE for encoded account+ticker', async () => {
        const fetchMock = vi.fn(async () => okFetch({ deleted: 'AAPL' }));
        vi.stubGlobal('fetch', fetchMock);
        const result = await deleteMaintainerPosition('TFSA One', 'AAPL');
        expect(fetchMock).toHaveBeenCalledWith('/api/portfolio-maintainer/position/TFSA%20One/AAPL', expect.objectContaining({ method: 'DELETE' }));
        expect(result).toEqual({ deleted: 'AAPL' });
    });

    it('deleteMaintainerPosition throws on 404', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => errFetch(404, 'Position not found: ZZZZ')));
        await expect(deleteMaintainerPosition('TFSA One', 'ZZZZ')).rejects.toThrow('Position not found');
    });
});
