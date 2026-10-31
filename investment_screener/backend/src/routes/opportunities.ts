/**
 * opportunities.ts - Express routing for the opportunities screener (S3-S8).
 *
 * Purpose:
 *   HTTP surface of the "Oportunidades" page: one GET that validates the funnel's parameters,
 *   hands them to OpportunitiesService (which spawns the canonical Python engine) and returns
 *   the S8 payload. It is an informational filter over the Racional universe, never a buy or
 *   sell recommendation (rule 23: canonical calls come from recommendation.py).
 *
 * Layer:
 *   Backend / Routes / Opportunities
 *
 * Routes Index (mounted at /api/opportunities):
 *   - GET / - screen the universe (200 payload, 400 invalid parameters, 503 no snapshot, 500 failure)
 *
 * Query parameters (S8 defaults in brackets):
 *   require [1,4] roic [15] roe [15] roa [7] de [0.5] mos [25] fcfy [5] peg [1] target [20]
 *   drop [20] rsi [35] sup [1] ins [2] etf [0]
 *
 * Key Functions (Index):
 *   - opportunitiesQuery - the zod schema (defaults + bounds) of the query string
 *   - createOpportunitiesRouter(deps) - router factory (the service is injectable for tests)
 *   - default export - the router wired to the real singleton service
 *
 * Key Input Dependencies:
 *   - services/OpportunitiesService.ts (which runs py_services/opportunity_screener.py)
 *
 * Key Output Dependencies:
 *   - JSON payloads use `ticker`; SQL keeps `symbol`
 */
import express from 'express';
import { z } from 'zod';
import {
    OpportunitiesService,
    opportunitiesService,
    ScreenDataMissingError,
} from '../services/OpportunitiesService';

export interface OpportunitiesRouterDeps {
    service?: OpportunitiesService;
}

/** A positive-or-zero threshold with an upper bound, so a typo cannot ask for nonsense. */
const threshold = (max: number, fallback: number) =>
    z.coerce.number().min(0).max(max).default(fallback);

export const opportunitiesQuery = z.object({
    require: z.string().regex(/^[1-6](,[1-6])*$/).default('1,4'),
    roic: threshold(100, 15),
    roe: threshold(100, 15),
    roa: threshold(100, 7),
    de: threshold(100, 0.5),
    mos: threshold(100, 25),
    fcfy: threshold(100, 5),
    peg: threshold(100, 1),
    target: threshold(1000, 20),
    drop: threshold(100, 20),
    rsi: threshold(100, 35),
    sup: z.coerce.number().int().min(0).max(100).default(1),
    ins: z.coerce.number().int().min(0).max(100).default(2),
    etf: z.coerce.number().int().min(0).max(1).default(0),
});

export function createOpportunitiesRouter(deps: OpportunitiesRouterDeps = {}): express.Router {
    const router = express.Router();
    const service = deps.service ?? opportunitiesService;

    router.get('/', async (req, res) => {
        const parsed = opportunitiesQuery.safeParse(req.query);
        if (!parsed.success) {
            res.status(400).json({ error: 'Invalid query parameters', details: parsed.error.issues });
            return;
        }
        try {
            res.json(await service.screen(parsed.data));
        } catch (error) {
            if (error instanceof ScreenDataMissingError) {
                res.status(503).json({ error: error.message, code: error.code });
                return;
            }
            console.error('[Opportunities] screening failed:', error);
            res.status(500).json({ error: 'No se pudo calcular el screener de oportunidades' });
        }
    });

    return router;
}

export default createOpportunitiesRouter();
