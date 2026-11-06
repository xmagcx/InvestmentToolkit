/**
 * Purpose: Fuerte / Débil / Neutral thresholds and the action → signal mapping (S3, S5).
 * Layer: Frontend unit. Usage: npx vitest run tests/analysis/metricState.test.ts
 */
import { expect, it } from 'vitest';
import { metricState, type MetricKey } from '../../src/utils/metricState';
import { signalFor } from '../../src/utils/signalLabel';

it.each<[MetricKey, number, string]>([
    ['roic', 23.8, 'Fuerte'], ['roic', 12, 'Neutral'], ['roic', 4, 'Débil'],
    ['mos', 25, 'Fuerte'], ['mos', 5, 'Neutral'], ['mos', -14.3, 'Débil'],
    ['divy', 0.65, 'Neutral'], ['buyback', 0.01, 'Débil'],
    ['beta', 0.9, 'Fuerte'], ['beta', 1.2, 'Neutral'], ['beta', 1.8, 'Débil'],
    ['de', 0.3, 'Fuerte'], ['de', 3, 'Débil'],
])('%s = %s is %s', (key, value, word) => {
    expect(metricState(key, value).word).toBe(word);
});

it('pairs every state with a symbol so colour is never the only signal', () => {
    expect(metricState('roe', 31).symbol).toBe('▲');
    expect(metricState('roe', 1).symbol).toBe('▼');
    expect(metricState('roe', 10).symbol).toBe('●');
});

it.each([
    ['INITIATE', 'Comprar'], ['ACCUMULATE', 'Comprar más'], ['MAINTAIN', 'Mantener'],
    ['TRIM', 'Vender (reducir)'], ['EXIT', 'Vender (todo)'], ['WATCHLIST', 'En vigilancia'],
] as const)('%s maps to %s', (action, label) => {
    expect(signalFor(action).label).toBe(label);
});

it('no entry maps to Sin señal', () => {
    expect(signalFor(null).label).toBe('Sin señal');
    expect(signalFor(undefined).label).toBe('Sin señal');
});
