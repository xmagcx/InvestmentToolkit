/**
 * @vitest-environment jsdom
 * Purpose: with the broker disabled (spec S6) the Buy/Sell trade buttons must not be
 * offered at all — not greyed out, not a dead click: nothing renders, and no trading
 * request is made. With BROKER_INTEGRATION=on the buttons come back unchanged.
 * Layer: Frontend component. Usage: vitest run src/components/TradeButtons.test.tsx.
 * Key Functions: hidden while disabled, rendered while enabled.
 * Key Input Dependencies: global fetch is mocked (/api/portfolio/features, /api/tv-status).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { TradeButtons } from './TradeButtons';

function mockApi(brokerIntegration: boolean) {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url === '/api/portfolio/features') {
            return { ok: true, json: async () => ({ broker_integration: brokerIntegration }) };
        }
        if (url === '/api/tv-status') {
            return { ok: true, json: async () => ({ price_source: 'tradingview' }) };
        }
        throw new Error(`unexpected request: ${url}`);
    }));
}

afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
});

describe('TradeButtons with the broker disabled', () => {
    it('renders nothing — no Buy, no Sell, no TV Offline hint', async () => {
        mockApi(false);
        const { container } = render(<TradeButtons ticker="NVDA" />);
        await waitFor(() => expect(fetch).toHaveBeenCalledWith('/api/portfolio/features'));
        expect(screen.queryByText('Buy')).to.equal(null);
        expect(screen.queryByText('Sell')).to.equal(null);
        expect(container.textContent).to.equal('');
    });

    it('renders the buttons again when the owner opted in', async () => {
        mockApi(true);
        render(<TradeButtons ticker="NVDA" />);
        await waitFor(() => expect(screen.queryByText('Buy')).to.not.equal(null));
        expect(screen.queryByText('Sell')).to.not.equal(null);
    });
});
