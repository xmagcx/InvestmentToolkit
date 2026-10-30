/**
 * index.ts - Express backend server bootstrap entry point.
 * 
 * Purpose:
 *   Application bootstrap: middleware setup, route registration, server startup.
 *   Business logic lives in src/routes/ and src/services/.
 * 
 * Layer:
 *   Backend / Core
 * 
 * Usage:
 *   node dist/index.js        (Production)
 *   npm run dev               (Development via ts-node-dev)
 * 
 * Key Input Dependencies:
 *   - ../../../.env
 *   - env SOURCE_SYNC_SCHEDULER / SOURCE_SYNC_INTERVALS (investment-source scheduler, see SourceScheduler.ts)
 *
 * Key Output Dependencies:
 *   None (starts API server listening on localhost port 3001)
 * 
 * Routes & Endpoints Index:
 *   - GET /health - Simple application availability ping
 *   - GET /api/tv-status - Checks whether TradingView CDP client is online
 *   - POST /api/analysis/valuation - Standalone AI Valuation calculation request
 *   - app.use('/api/portfolio', portfolioRouter)
 *   - app.use('/api/projections', projectionsRouter)
 *   - app.use('/api/theses', thesesRouter)
 *   - app.use('/api', docsRouter)
 *   - app.use('/api', stockRouter)
 *   - app.use('/api/screener', screenerRouter)
 *   - app.use('/api/trading', tradingRouter)
 *   - app.use('/api/daily-brief', dailybriefRouter)
 *   - app.use('/api', sourcesRouter) - /api/sources/**, /api/stocks-origin, /api/recent-buys/**
 */
import { getRecommendations } from './utils/helpers';

import express from 'express';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../../.env') });

import cors from 'cors';
import { valuationService } from './services/ValuationService';
import { isTradingViewConnected } from './utils/helpers';
import { localAuthMiddleware, LOCAL_API_TOKEN } from './middleware/localAuth';

import portfolioRouter from './routes/portfolio';
import projectionsRouter from './routes/projections';
import thesesRouter from './routes/theses';
import docsRouter from './routes/docs';
import screenerRouter from './routes/screener';
import stockRouter from './routes/stock';
import tradingRouter from './routes/trading';
import dailybriefRouter from './routes/dailybrief';
import sourcesRouter from './routes/sources';
import { SourceScheduler } from './services/SourceScheduler';

const app = express();
const port = process.env.PORT || 3001;

// Bind to loopback only — prevents other machines on the network from reaching the API.
// All clients (Vite dev proxy, CLI agents) connect via localhost, so this is safe.
const HOST = '127.0.0.1';

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(localAuthMiddleware);
console.log(`[Auth] Local API token active — read from .runtime/api-token or env LOCAL_API_TOKEN`);

// ── Utility routes ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/api/tv-status', async (_req, res) => {
    const connected = await isTradingViewConnected();
    res.json({ price_source: connected ? 'tradingview' : 'yfinance' });
});

// ── AI Valuation (standalone — not grouped with screener routes) ───────────────

app.post('/api/analysis/valuation', async (req, res) => {
    const { ticker, userMessage } = req.body;
    console.log(`[API] AI Valuation Request for ${ticker}...`);
    try {
        if (!ticker) { res.status(400).json({ error: 'Ticker is required' }); return; }
        const result = await valuationService.analyzeStock(ticker, userMessage);
        const recommendation = (await getRecommendations())[ticker.toUpperCase()] ?? null;
        res.json({ ...result, researchAction: result.action, action: recommendation?.action ?? null, recommendation });
    } catch (error: any) {
        console.error(`[API] Valuation Error: `, error);
        res.status(500).json({ error: 'AI Analysis Failed', details: error.message });
    }
});

// ── Route registration ────────────────────────────────────────────────────────

app.use('/api/portfolio', portfolioRouter);   // /api/portfolio/** (CRUD, sync, summary, strategy-allocation)
app.use('/api/projections', projectionsRouter);
app.use('/api/theses', thesesRouter);
app.use('/api', docsRouter);                 // /api/docs/**, /api/research/**
app.use('/api', stockRouter);               // /api/stock/:ticker, /api/portfolio-heatmap
app.use('/api/screener', screenerRouter);   // /api/screener/all-holdings
app.use('/api/trading', tradingRouter);     // /api/trading/** (preflight, execute, submit, audit)
app.use('/api/daily-brief', dailybriefRouter); // /api/daily-brief/latest, /history, /conviction/:ticker
app.use('/api', sourcesRouter);             // /api/sources/**, /api/stocks-origin, /api/recent-buys/**

app.listen(Number(port), HOST, () => {
    console.log(`Backend server running on http://${HOST}:${port}`);
    // Scheduled investment-source syncs (S8). Disabled with SOURCE_SYNC_SCHEDULER=off.
    new SourceScheduler().start();
});
