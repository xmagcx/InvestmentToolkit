/**
 * brokerIntegration.ts - the broker integration kill switch.
 *
 * Purpose:
 *   This platform is a screener and recommendation tool (spec S6): live broker order
 *   execution and broker portfolio sync are off unless the owner explicitly opts in with
 *   BROKER_INTEGRATION=on. The broker code is disabled, never deleted, so a single env
 *   variable brings it back. Everything that does not talk to a broker — stored-data
 *   reads, recommendations and the one price refresh (AGENTS rule 25) — stays available.
 *
 * Layer:
 *   Backend / Utils
 *
 * Usage Examples:
 *   router.use(requireBrokerIntegration);                  // whole router (trading)
 *   router.post('/sync', requireBrokerIntegration, handler) // one route (portfolio)
 *   if (isBrokerIntegrationEnabled()) { ... }
 *
 * Key Functions (Index):
 *   - isBrokerIntegrationEnabled() - true only when BROKER_INTEGRATION is 'on'
 *   - requireBrokerIntegration(req, res, next) - 410 BROKER_DISABLED while off
 *
 * Key Input Dependencies:
 *   - process.env.BROKER_INTEGRATION (read per call, so no restart is needed to flip it)
 *
 * Key Output Dependencies:
 *   None (never reaches the broker, never writes).
 */
import type { NextFunction, Request, Response } from 'express';

/** The one message every disabled broker route returns, so the UI can show it verbatim. */
export const BROKER_DISABLED_MESSAGE =
    'Broker integration is disabled: this platform is a screener and recommendation tool. ' +
    'Set BROKER_INTEGRATION=on to re-enable.';

/** The machine-readable marker the frontend keys on. */
export const BROKER_DISABLED_CODE = 'BROKER_DISABLED';

/**
 * Whether broker reads/writes are allowed. Opt-in only: 'on' (any case, surrounding
 * spaces ignored) enables it; every other value — including unset, 'true' and '1' —
 * leaves it off, so a typo fails closed rather than contacting a live broker.
 */
export function isBrokerIntegrationEnabled(): boolean {
    return (process.env.BROKER_INTEGRATION ?? '').trim().toLowerCase() === 'on';
}

/**
 * Express guard for broker-backed routes. 410 Gone (the capability is intentionally
 * withdrawn, not missing or failing) with the shared message and code.
 */
export function requireBrokerIntegration(_req: Request, res: Response, next: NextFunction): void {
    if (isBrokerIntegrationEnabled()) {
        next();
        return;
    }
    res.status(410).json({ error: BROKER_DISABLED_MESSAGE, code: BROKER_DISABLED_CODE });
}
