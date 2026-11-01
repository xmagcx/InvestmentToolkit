/**
 * sentiment.ts - Express routing for the lazy sentiment reading of one ticker (S13/S15).
 *
 * Purpose:
 *   HTTP surface of the sentiment block inside an expanded Oportunidades row: one GET that
 *   validates the ticker, runs py_services/sentiment.py once and returns {market, ticker}.
 *   It is context, never a recommendation and never a filter (S13): neither half ever
 *   changes a star.
 *
 *   The reading is cached in memory because the page asks for it every time a reader opens
 *   a row: the market mood for 1 h (CNN publishes it a few times an hour) and each ticker's
 *   headlines for 30 min. A half the script could not read comes back null — a null is
 *   data, so it is still a 200; only a crashing script is a 500.
 *
 * Layer:
 *   Backend / Routes / Sentiment
 *
 * Routes Index (mounted at /api/sentiment):
 *   - GET /:ticker - {market, ticker} (200 payload, 400 invalid ticker, 500 script crash)
 *
 * Key Functions (Index):
 *   - MARKET_TTL_MS / TICKER_TTL_MS / SCRIPT_TIMEOUT_MS - the cache and spawn bounds
 *   - validTicker(raw) - the canonical ticker, or null when the path is not a ticker
 *   - createSentimentRouter(deps) - router factory (the Python runner is injectable)
 *   - default export - the router wired to the real Python bridge
 *
 * Key Input Dependencies:
 *   - py_services/sentiment.py (via services/bridge.ts runPythonScriptFresh)
 *   - utils/tickerAliases.ts (the repo's only alias map)
 *
 * Key Output Dependencies:
 *   - JSON payloads use `ticker`; SQL keeps `symbol`
 */
import express from 'express';
import { runPythonScriptFresh } from '../services/bridge';
import { normalizeTicker } from '../utils/tickerAliases';

export const MARKET_TTL_MS = 60 * 60 * 1000;
export const TICKER_TTL_MS = 30 * 60 * 1000;
export const SCRIPT_TIMEOUT_MS = 30_000;

const TICKER_RE = /^[A-Z0-9][A-Z0-9.\-]{0,11}$/;

export type SentimentRunner = (
    script: string,
    args: string[],
    timeoutMs: number
) => Promise<{ exitCode: number; json: any }>;

export interface SentimentRouterDeps {
    runScript?: SentimentRunner;
}

/** Return the canonical ticker of a path segment, or null when it is not a ticker at all. */
export function validTicker(raw: string): string | null {
    const upper = (raw ?? '').trim().toUpperCase();
    return TICKER_RE.test(upper) ? normalizeTicker(upper) : null;
}

interface CacheEntry {
    value: any;
    expiresAt: number;
}

export function createSentimentRouter(deps: SentimentRouterDeps = {}): express.Router {
    const router = express.Router();
    const runScript = deps.runScript ?? runPythonScriptFresh;
    // Per-router caches: one market reading for everyone, one entry per ticker.
    let market: CacheEntry | null = null;
    const tickers = new Map<string, CacheEntry>();

    /** The cached value while it is still fresh, otherwise null. */
    function fresh(entry: CacheEntry | null | undefined): any | null {
        return entry && entry.expiresAt > Date.now() ? entry.value : null;
    }

    router.get('/:ticker', async (req, res) => {
        const ticker = validTicker(req.params.ticker);
        if (ticker === null) {
            res.status(400).json({ error: `Ticker inválido: ${req.params.ticker}` });
            return;
        }
        const cachedMarket = fresh(market);
        const cachedTicker = fresh(tickers.get(ticker));
        if (cachedMarket && cachedTicker) {
            res.json({ market: cachedMarket, ticker: cachedTicker });
            return;
        }
        try {
            const run = await runScript('sentiment.py', ['--ticker', ticker], SCRIPT_TIMEOUT_MS);
            const payload = run.json ?? {};
            if (payload.market) market = { value: payload.market, expiresAt: Date.now() + MARKET_TTL_MS };
            if (payload.ticker) tickers.set(ticker, { value: payload.ticker, expiresAt: Date.now() + TICKER_TTL_MS });
            res.json({
                market: payload.market ?? cachedMarket ?? null,
                ticker: payload.ticker ?? cachedTicker ?? null,
            });
        } catch (error) {
            console.error(`[Sentiment] ${ticker} failed:`, error);
            res.status(500).json({ error: 'No se pudo leer el sentimiento' });
        }
    });

    return router;
}

export default createSentimentRouter();
