/**
 * tradingViewSymbol.test.ts (Vitest unit test)
 * =====================================
 * Purpose: pin the ticker -> TradingView symbol mapping used by the public embed widgets.
 * Layer: Frontend / Utils / Tests
 * Key Input Dependencies: src/utils/tradingViewSymbol.ts
 * Key Functions: toTradingViewSymbol() cases for US, class shares, Canadian suffixes and bad input.
 */
import { describe, expect, it } from 'vitest';
import { toTradingViewSymbol } from './tradingViewSymbol';

describe('toTradingViewSymbol', () => {
    it('returns the bare ticker when no exchange is known', () => {
        expect(toTradingViewSymbol('AAPL')).toBe('AAPL');
    });

    it('prefixes a known TradingView exchange', () => {
        expect(toTradingViewSymbol('AAPL', 'NASDAQ')).toBe('NASDAQ:AAPL');
        expect(toTradingViewSymbol('BA', 'nyse')).toBe('NYSE:BA');
        expect(toTradingViewSymbol('SPY', 'AMEX')).toBe('AMEX:SPY');
        expect(toTradingViewSymbol('VIX', 'CBOE')).toBe('CBOE:VIX');
    });

    it('ignores an exchange TradingView does not name', () => {
        expect(toTradingViewSymbol('AAPL', 'NMS')).toBe('AAPL');
        expect(toTradingViewSymbol('AAPL', null)).toBe('AAPL');
    });

    it('keeps the dot of class shares', () => {
        expect(toTradingViewSymbol('BRK.B')).toBe('BRK.B');
        expect(toTradingViewSymbol('BRK.B', 'NYSE')).toBe('NYSE:BRK.B');
    });

    it('maps Canadian suffixes to their TradingView exchange', () => {
        expect(toTradingViewSymbol('RY.TO')).toBe('TSX:RY');
        expect(toTradingViewSymbol('PSU.U.TO')).toBe('TSX:PSU.U');
        expect(toTradingViewSymbol('ABC.V')).toBe('TSXV:ABC');
    });

    it('lets the ticker suffix win over a contradicting exchange', () => {
        expect(toTradingViewSymbol('RY.TO', 'NASDAQ')).toBe('TSX:RY');
    });

    it('normalizes case and surrounding spaces', () => {
        expect(toTradingViewSymbol('  aapl  ')).toBe('AAPL');
        expect(toTradingViewSymbol(' ry.to ', ' tsx ')).toBe('TSX:RY');
    });

    it('passes through a symbol that already carries an exchange prefix', () => {
        expect(toTradingViewSymbol('nasdaq:aapl')).toBe('NASDAQ:AAPL');
    });

    it('throws on empty input', () => {
        expect(() => toTradingViewSymbol('')).toThrow();
        expect(() => toTradingViewSymbol('   ')).toThrow();
    });
});
