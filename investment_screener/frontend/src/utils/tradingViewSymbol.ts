/**
 * tradingViewSymbol.ts (Frontend Utility)
 * =====================================
 *
 * Purpose:
 *     Maps a portfolio ticker to the symbol string the public TradingView embed widgets expect
 *     (anonymous widgets, no login, no CDP, no account linkage).
 *
 * Layer: Frontend / Utils
 *
 * Key Input Dependencies: none (pure string mapping).
 *
 * Usage Examples:
 *     toTradingViewSymbol('AAPL')            // 'AAPL'
 *     toTradingViewSymbol('AAPL', 'NASDAQ')  // 'NASDAQ:AAPL'
 *     toTradingViewSymbol('RY.TO')           // 'TSX:RY'
 *     toTradingViewSymbol('PSU.U.TO')        // 'TSX:PSU.U'
 *
 * Key Functions:
 *     - toTradingViewSymbol() - normalizes a ticker and prefixes the TradingView exchange when known.
 */

/** Exchange names TradingView itself uses; anything else is dropped rather than guessed. */
const TRADINGVIEW_EXCHANGES = ['NASDAQ', 'NYSE', 'AMEX', 'TSX', 'TSXV', 'CBOE'];

/** yfinance-style ticker suffixes and the TradingView exchange they belong to. */
const SUFFIX_EXCHANGES: Array<[string, string]> = [
    ['.TO', 'TSX'],
    ['.V', 'TSXV'],
];

// Converts a stored ticker into a TradingView embed symbol.
export function toTradingViewSymbol(ticker: string, exchange?: string | null): string {
    /**
     * Uppercases and trims the ticker, keeps class-share dots (BRK.B), turns a Canadian
     * suffix into its exchange prefix (RY.TO -> TSX:RY) and otherwise prefixes the given
     * exchange when TradingView knows that name. Returns the bare ticker when it does not.
     * Throws on an empty ticker so a caller never injects a widget without a symbol.
     */
    const normalized = ticker.trim().toUpperCase();
    if (!normalized) {
        throw new Error('toTradingViewSymbol requires a non-empty ticker');
    }
    if (normalized.includes(':')) return normalized;

    for (const [suffix, suffixExchange] of SUFFIX_EXCHANGES) {
        if (normalized.endsWith(suffix) && normalized.length > suffix.length) {
            return `${suffixExchange}:${normalized.slice(0, -suffix.length)}`;
        }
    }

    const wanted = (exchange ?? '').trim().toUpperCase();
    return TRADINGVIEW_EXCHANGES.includes(wanted) ? `${wanted}:${normalized}` : normalized;
}
