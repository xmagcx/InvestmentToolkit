/**
 * api.universe.test.ts (Universe API client)
 *
 * Purpose:
 *     Covers the universe service-layer client functions: uploadUniverseCsv(),
 *     fetchUniverse(), and deleteUniverseTicker(). Uses the same mocked-`fetch`
 *     harness as api.test.ts. The UniversePage component renders these through
 *     React; component-level render testing is out of scope here because the
 *     project's vitest harness is node-env with no jsdom/@testing-library (the
 *     SDD change forbids new npm dependencies), so the reducible, testable unit
 *     is the API client exactly as api.test.ts does for syncAndRefreshPortfolio.
 *
 * Layer: Frontend / Services (vitest)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { uploadUniverseCsv, fetchUniverse, deleteUniverseTicker } from './api';

describe('universe API client', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('uploadUniverseCsv POSTs the csv text and returns the summary', async () => {
        const fetchMock = vi.fn(async () =>
            ({ ok: true, json: async () => ({ inserted: 3, skipped: 1, errors: [] }) }) as Response
        );
        vi.stubGlobal('fetch', fetchMock);

        const result = await uploadUniverseCsv('ticker,name,source\nAAPL,Apple,RACIONAL');

        expect(fetchMock).toHaveBeenCalledWith('/api/universe/upload', expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ csv: 'ticker,name,source\nAAPL,Apple,RACIONAL' }),
        }));
        expect(result).toEqual({ inserted: 3, skipped: 1, errors: [] });
    });

    it('uploadUniverseCsv throws on a non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            ({ ok: false, json: async () => ({ error: 'Header mismatch' }) }) as Response
        ));
        await expect(uploadUniverseCsv('bad,csv\nx,y\n')).rejects.toThrow('Header mismatch');
    });

    it('fetchUniverse GETs /api/universe and returns the candidate array', async () => {
        const candidate = { ticker: 'AAPL', name: 'Apple', source: 'RACIONAL', asset_class: null, added_at: '2026-01-01' };
        vi.stubGlobal('fetch', vi.fn(async () =>
            ({ ok: true, json: async () => [candidate] }) as Response
        ));

        const result = await fetchUniverse();

        expect(result).toEqual([candidate]);
    });

    it('deleteUniverseTicker sends DELETE for the encoded ticker', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            ({ ok: true, json: async () => ({ deleted: 'AAPL' }) }) as Response
        ));

        const result = await deleteUniverseTicker('AAPL');

        expect(fetch).toHaveBeenCalledWith('/api/universe/AAPL', expect.objectContaining({ method: 'DELETE' }));
        expect(result).toEqual({ deleted: 'AAPL' });
    });

    it('deleteUniverseTicker throws on 404', async () => {
        vi.stubGlobal('fetch', vi.fn(async () =>
            ({ ok: false, json: async () => ({ error: 'Ticker not found: ZZZZ' }) }) as Response
        ));
        await expect(deleteUniverseTicker('ZZZZ')).rejects.toThrow('Ticker not found');
    });
});
