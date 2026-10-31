/**
 * profilesSummary.ts — GET /api/portfolio/profiles-summary (specs S1/S2).
 *
 * Purpose:
 *   Read-only route for the redesigned portfolio summary page: every profile in its
 *   own base currency plus the consolidated USD total and the FX rates used. It does
 *   not touch the existing /summary, /performance or /strategy-allocation contracts,
 *   which other pages still read.
 *
 * Layer:
 *   Backend / Routes
 *
 * Routes & Endpoints Index:
 *   - GET /api/portfolio/profiles-summary - per-profile + consolidated summary
 *
 * Key Input Dependencies:
 *   - ProfileSummaryService (domain_model.sqlite, fx_rates.py)
 *
 * Key Output Dependencies:
 *   None (never writes)
 */
import express from 'express';
import { ProfileSummaryService, pythonFxProvider, type FxProvider } from '../services/ProfileSummaryService';
import { DOMAIN_MODEL_DB_FILE } from '../utils/paths';

/** Build the router over an explicit database path + FX provider (tests inject both). */
export function buildProfilesSummaryRouter(
    dbPath: string = DOMAIN_MODEL_DB_FILE,
    fx: FxProvider = pythonFxProvider
): express.Router {
    const router = express.Router();

    router.get('/profiles-summary', async (_req, res) => {
        let service: ProfileSummaryService | null = null;
        try {
            service = new ProfileSummaryService(dbPath, fx);
            res.json(await service.load());
        } catch (error: any) {
            console.error('[API] Error building profiles summary: ', error);
            res.status(500).json({ error: 'Failed to build portfolio profiles summary', details: error.message });
        } finally {
            service?.close();
        }
    });

    return router;
}

export default buildProfilesSummaryRouter();
