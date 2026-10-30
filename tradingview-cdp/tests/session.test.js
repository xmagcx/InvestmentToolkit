/**
 * session.test.js - Jest tests for anonymous-mode (no TradingView login) support.
 *
 * Purpose:
 *   Verifies that the CDP engine reports the TradingView session state, that
 *   session-only features fail fast with TV_SESSION_REQUIRED when the page is
 *   logged out, and that quotes/charts keep working anonymously.
 *
 * Key Input Dependencies:
 *   - ../core/session.js, ../core/health.js, ../core/broker_data.js,
 *     ../core/trading.js, ../core/watchlist.js, ../core/data.js
 *   - ../connection.js (mocked — no live TradingView instance is contacted)
 *
 * Key Output Dependencies:
 *   None (reports test execution results to Jest runner console)
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

const evaluate = jest.fn();

jest.unstable_mockModule('../connection.js', () => ({
  evaluate,
  evaluateAsync: evaluate,
  getClient: jest.fn(async () => ({ Runtime: { evaluate: jest.fn() } })),
  getTargetInfo: jest.fn(async () => ({ id: 'TARGET-1', url: 'https://www.tradingview.com/chart/', title: 'Chart' })),
  connect: jest.fn(),
  disconnect: jest.fn(),
  safeString: str => JSON.stringify(String(str)),
  requireFinite: value => Number(value),
  getChartApi: jest.fn(),
  getChartCollection: jest.fn(),
  KNOWN_PATHS: { chartApi: 'CHART_API', mainSeriesBars: 'BARS' },
}));

const { getSessionState, requireSession, sessionOnly } = await import('../core/session.js');
const { healthCheck } = await import('../core/health.js');
const { activeAccount } = await import('../core/broker_data.js');
const { getBrokerStatus } = await import('../core/trading.js');
const { getWatchlist } = await import('../core/watchlist.js');
const { getQuote } = await import('../core/data.js');

const CHART_STATE = { url: 'https://www.tradingview.com/chart/', title: 'Chart', symbol: 'AAPL', resolution: '1D', chartType: 1, apiAvailable: true };
const QUOTE = { symbol: 'AAPL', last: 270.5, close: 270.5, open: 268 };

/**
 * Install an evaluate() mock that answers the session probe with `authenticated`
 * and every other page probe with a canned payload.
 */
function mockPage(authenticated) {
  evaluate.mockReset();
  evaluate.mockImplementation(async expression => {
    if (expression.includes('is_authenticated')) return authenticated;
    if (expression.includes('_activeChartWidgetWV')) return CHART_STATE;
    if (expression.includes('accountName')) return JSON.stringify({ accountType: 'TFSA', accountId: '123', displayText: 'TFSA - 123' });
    if (expression.includes('brokerBlock')) return JSON.stringify({ connected: false, broker: null });
    return QUOTE;
  });
}

const SESSION_MESSAGE = feature =>
  `TradingView is not logged in: "${feature}" needs a TradingView session. Quotes, charts and TA sweeps work without one.`;

describe('getSessionState', () => {
  beforeEach(() => evaluate.mockReset());

  it('reports authenticated true when the page says so', async () => {
    mockPage(true);
    expect(await getSessionState()).toEqual({ authenticated: true });
  });

  it('reports authenticated false when the page is logged out', async () => {
    mockPage(false);
    expect(await getSessionState()).toEqual({ authenticated: false });
  });

  it('reports null when window.is_authenticated is not a boolean', async () => {
    mockPage(null);
    expect(await getSessionState()).toEqual({ authenticated: null });
  });

  it('reports null when the page probe fails instead of propagating the error', async () => {
    evaluate.mockRejectedValue(new Error('JS evaluation error'));
    expect(await getSessionState()).toEqual({ authenticated: null });
  });

  it('never reads the username or auth token', async () => {
    mockPage(true);
    await getSessionState();
    const expression = evaluate.mock.calls[0][0];
    expect(expression).not.toMatch(/window\.user|auth_token|username/);
  });
});

describe('requireSession', () => {
  it('throws TV_SESSION_REQUIRED only when the page is logged out', async () => {
    mockPage(false);
    await expect(requireSession('watchlist get')).rejects.toMatchObject({
      code: 'TV_SESSION_REQUIRED',
      message: SESSION_MESSAGE('watchlist get'),
    });
  });

  it('proceeds when authenticated or unknown', async () => {
    mockPage(true);
    await expect(requireSession('watchlist get')).resolves.toEqual({ authenticated: true });
    mockPage(null);
    await expect(requireSession('watchlist get')).resolves.toEqual({ authenticated: null });
  });
});

describe('healthCheck session reporting', () => {
  it('keeps every existing field and adds the anonymous session fields', async () => {
    mockPage(false);
    const result = await healthCheck();
    expect(result).toEqual({
      success: true,
      cdp_connected: true,
      target_id: 'TARGET-1',
      target_url: 'https://www.tradingview.com/chart/',
      target_title: 'Chart',
      chart_symbol: 'AAPL',
      chart_resolution: '1D',
      chart_type: 1,
      api_available: true,
      tv_authenticated: false,
      session_mode: 'anonymous',
    });
  });

  it('reports authenticated and unknown session modes', async () => {
    mockPage(true);
    expect(await healthCheck()).toMatchObject({ tv_authenticated: true, session_mode: 'authenticated' });
    mockPage(null);
    expect(await healthCheck()).toMatchObject({ tv_authenticated: null, session_mode: 'unknown' });
  });
});

describe('guarded features', () => {
  const watchlistClient = {
    Runtime: { evaluate: jest.fn().mockResolvedValue({ result: { value: JSON.stringify({ success: true, watchlist: 'TV-Portfolio', items: [] }) } }) },
  };

  it('rejects a watchlist read when the page is anonymous', async () => {
    mockPage(false);
    const guarded = sessionOnly('watchlist get', () => getWatchlist(watchlistClient));
    await expect(guarded()).rejects.toMatchObject({ code: 'TV_SESSION_REQUIRED', message: SESSION_MESSAGE('watchlist get') });
  });

  it('runs the watchlist read unchanged when authenticated or unknown', async () => {
    mockPage(true);
    const guarded = sessionOnly('watchlist get', () => getWatchlist(watchlistClient));
    await expect(guarded()).resolves.toMatchObject({ success: true, watchlist: 'TV-Portfolio' });
    mockPage(null);
    await expect(guarded()).resolves.toMatchObject({ success: true });
  });

  it('rejects broker reads and trading when the page is anonymous', async () => {
    mockPage(false);
    await expect(activeAccount()).rejects.toMatchObject({ code: 'TV_SESSION_REQUIRED' });
    await expect(getBrokerStatus()).rejects.toMatchObject({ code: 'TV_SESSION_REQUIRED' });
  });

  it('runs broker reads when authenticated', async () => {
    mockPage(true);
    await expect(activeAccount()).resolves.toMatchObject({ accountType: 'TFSA' });
  });
});

describe('unguarded features', () => {
  it('serves a quote while the page is anonymous', async () => {
    mockPage(false);
    await expect(getQuote({ symbol: 'AAPL' })).resolves.toMatchObject({ success: true, price: 270.5 });
  });
});
