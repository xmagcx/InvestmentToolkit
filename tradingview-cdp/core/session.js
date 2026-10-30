/**
 * session.js - TradingView login state and the guard for session-only features.
 *
 * Purpose:
 *   The engine must work against a TradingView page that nobody is logged into
 *   (anonymous mode). Quotes, charts, TA sweeps, Pine and screenshots work that
 *   way; watchlists, alerts, broker reads and trading do not. This module reads
 *   the page's login flag and fails those features fast with a clear message
 *   instead of letting them fail obscurely deep in DOM automation.
 *
 *   Only the boolean window.is_authenticated is read. The username, user id and
 *   auth token in window.user are never read or returned.
 *
 * Key Input Dependencies:
 *   None (reads window.is_authenticated from TradingView Desktop via CDP)
 *
 * Key Output Dependencies:
 *   None (returns the session state or throws TV_SESSION_REQUIRED)
 *
 * Functions:
 *   - getSessionState() — { authenticated: true | false | null }
 *   - requireSession(feature) — throws TV_SESSION_REQUIRED when logged out
 *   - sessionOnly(feature, handler) — wraps a handler with requireSession
 */
import { evaluate } from '../connection.js';

const IS_AUTHENTICATED = `typeof window.is_authenticated === 'boolean' ? window.is_authenticated : null`;

/**
 * Read whether the TradingView page is logged in.
 *
 * @returns {Promise<{authenticated: boolean|null}>} true logged in, false anonymous, null unknown
 */
export async function getSessionState() {
  /**
   * Evaluates the page's boolean login flag. Anything that is not a boolean —
   * an older page, a failed evaluation — is reported as unknown (null) so that
   * callers keep their current behaviour instead of blocking on a bad read.
   */
  let value = null;
  try {
    value = await evaluate(`(${IS_AUTHENTICATED})`);
  } catch {
    value = null;
  }
  return { authenticated: typeof value === 'boolean' ? value : null };
}

/**
 * Fail fast when a feature needs a TradingView session and the page is anonymous.
 *
 * @param {string} feature Command or feature name shown to the caller
 * @returns {Promise<{authenticated: boolean|null}>} The observed session state
 */
export async function requireSession(feature) {
  /**
   * Only a confirmed logged-out page blocks: an unknown state proceeds, so a
   * page that does not expose the flag behaves exactly as it did before.
   */
  const state = await getSessionState();
  if (state.authenticated === false) {
    const error = new Error(
      `TradingView is not logged in: "${feature}" needs a TradingView session. Quotes, charts and TA sweeps work without one.`
    );
    error.code = 'TV_SESSION_REQUIRED';
    throw error;
  }
  return state;
}

/**
 * Wrap a command handler so it runs only with a TradingView session.
 *
 * @param {string} feature Command name shown to the caller
 * @param {Function} handler Handler to run once the session check passes
 * @returns {Function} Guarded handler with the same signature
 */
export function sessionOnly(feature, handler) {
  /**
   * Keeps the CLI registration declarative: the guard is applied where the
   * command is registered instead of inside each automation module.
   */
  return async (...args) => {
    await requireSession(feature);
    return handler(...args);
  };
}
