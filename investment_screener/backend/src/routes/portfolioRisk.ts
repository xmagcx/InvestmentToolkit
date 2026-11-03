/**
 * portfolioRisk.ts - GET /api/portfolio/risk and POST /api/portfolio/optimize.
 *
 * Purpose:
 *   Thin bridge to the canonical py_services/portfolio_optimizer.py (read-only): the risk
 *   reading of the current portfolio and the optimizer's proposed weights and orders for
 *   one objective. The Python JSON is returned unchanged; nothing is computed here.
 *
 * Layer:
 *   Backend / Routes
 *
 * Routes & Endpoints Index:
 *   - GET  /api/portfolio/risk     - per-holding risk table (portfolio_optimizer.py --risk)
 *   - POST /api/portfolio/optimize - body {objective}: min_volatility | risk_parity | max_sharpe
 *
 * Key Input Dependencies:
 *   - services/bridge.ts (spawnPythonScript), py_services/portfolio_optimizer.py
 *
 * Key Output Dependencies:
 *   None (never writes)
 */
import express from 'express';
import { spawnPythonScript } from '../services/bridge';
import { DOMAIN_MODEL_DB_FILE } from '../utils/paths';

export const OBJECTIVES = ['min_volatility', 'risk_parity', 'max_sharpe'] as const;

type Spawn = (script: string, args: string[]) => Promise<any>;

/** Build the router over an explicit database path + spawn function (tests inject both). */
export function buildPortfolioRiskRouter(
    dbPath: string = DOMAIN_MODEL_DB_FILE,
    spawn: Spawn = spawnPythonScript
): express.Router {
    const router = express.Router();

    router.get('/risk', async (_req, res) => {
        try {
            res.json(await spawn('portfolio_optimizer.py', ['--db', dbPath, '--risk', '--json']));
        } catch (error: any) {
            console.error('[API] Error reading portfolio risk: ', error);
            res.status(500).json({ error: 'Failed to read portfolio risk', details: error.message });
        }
    });

    router.post('/optimize', async (req, res) => {
        const objective = req.body?.objective;
        if (!(OBJECTIVES as readonly string[]).includes(objective)) {
            return res.status(400).json({ error: `objective must be one of ${OBJECTIVES.join(', ')}` });
        }
        try {
            res.json(await spawn('portfolio_optimizer.py', ['--db', dbPath, '--optimize', objective, '--json']));
        } catch (error: any) {
            console.error('[API] Error optimizing portfolio: ', error);
            res.status(500).json({ error: 'Failed to optimize portfolio', details: error.message });
        }
    });

    return router;
}

export default buildPortfolioRiskRouter();
