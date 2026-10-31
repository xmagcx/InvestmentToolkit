/**
 * health.js - Core health check logic.
 * 
 * Purpose:
 *   Performs diagnostics on the CDP connection, TradingView chart layout API, and
 *   whether the page has a TradingView session (tv_authenticated / session_mode).
 * 
 * Key Input Dependencies:
 *   None (reads live state from TradingView Desktop on port 9222 via CDP)
 * 
 * Key Output Dependencies:
 *   None (returns diagnostic report object)
 */
import { getClient, getTargetInfo, evaluate } from '../connection.js';
import { getSessionState } from './session.js';

/**
 * Check health of the CDP connection and retrieve active chart state metadata.
 * 
 * @returns {Promise<object>} Connection and chart layout diagnostic details
 */
export async function healthCheck() {
  /**
   * Asserts that getClient succeeds, gets target info, and queries chart API
   * in the window to return active symbol, resolution, and chart type.
   */
  await getClient();
  const target = await getTargetInfo();
  const { authenticated } = await getSessionState();

  const state = await evaluate(`
    (function() {
      var result = { url: window.location.href, title: document.title };
      try {
        var chart = window.TradingViewApi._activeChartWidgetWV.value();
        result.symbol = chart.symbol();
        result.resolution = chart.resolution();
        result.chartType = chart.chartType();
        result.apiAvailable = true;
      } catch(e) {
        result.symbol = 'unknown';
        result.resolution = 'unknown';
        result.chartType = null;
        result.apiAvailable = false;
        result.apiError = e.message;
      }
      return result;
    })()
  `);

  return {
    success: true,
    cdp_connected: true,
    target_id: target.id,
    target_url: target.url,
    target_title: target.title,
    chart_symbol: state?.symbol || 'unknown',
    chart_resolution: state?.resolution || 'unknown',
    chart_type: state?.chartType ?? null,
    api_available: state?.apiAvailable ?? false,
    tv_authenticated: authenticated,
    session_mode: authenticated === true ? 'authenticated' : authenticated === false ? 'anonymous' : 'unknown',
  };
}
