/**
 * @vitest-environment jsdom
 * Purpose: the UI must hide broker-backed trading and sync unless the backend says the
 * integration is on (spec S6). The hook therefore fails closed: it starts disabled, and
 * stays disabled when the request fails, errors or answers something unexpected.
 * Layer: Frontend hooks. Usage: vitest run src/hooks/useFeatureFlags.test.ts.
 * Key Functions: default off, enables on true, stays off on error / non-ok / bad payload.
 * Key Input Dependencies: global fetch is mocked; no backend call.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { useFeatureFlags } from './useFeatureFlags';

function mockFeatures(impl: () => Promise<unknown>) {
    vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('useFeatureFlags', () => {
    it('starts disabled, so nothing broker-backed flashes before the answer arrives', () => {
        mockFeatures(() => new Promise(() => {}));
        const { result } = renderHook(() => useFeatureFlags());
        expect(result.current.broker_integration).to.equal(false);
    });

    it('enables broker_integration when the backend reports it on', async () => {
        mockFeatures(async () => ({ ok: true, json: async () => ({ broker_integration: true }) }));
        const { result } = renderHook(() => useFeatureFlags());
        await waitFor(() => expect(result.current.broker_integration).to.equal(true));
        expect(fetch).toHaveBeenCalledWith('/api/portfolio/features');
    });

    it('stays disabled when the backend reports it off', async () => {
        mockFeatures(async () => ({ ok: true, json: async () => ({ broker_integration: false }) }));
        const { result } = renderHook(() => useFeatureFlags());
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(result.current.broker_integration).to.equal(false);
    });

    it('stays disabled when the request fails', async () => {
        mockFeatures(async () => { throw new Error('network down'); });
        const { result } = renderHook(() => useFeatureFlags());
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(result.current.broker_integration).to.equal(false);
    });

    it('stays disabled on a non-ok response or an unexpected payload', async () => {
        mockFeatures(async () => ({ ok: false, json: async () => ({ broker_integration: true }) }));
        const { result } = renderHook(() => useFeatureFlags());
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(result.current.broker_integration).to.equal(false);

        vi.unstubAllGlobals();
        mockFeatures(async () => ({ ok: true, json: async () => ({ broker_integration: 'yes' }) }));
        const second = renderHook(() => useFeatureFlags());
        await waitFor(() => expect(fetch).toHaveBeenCalled());
        expect(second.result.current.broker_integration).to.equal(false);
    });
});
