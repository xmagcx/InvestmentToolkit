/**
 * metricState.ts
 *
 * Purpose:
 *     Single place for the Fuerte / Débil / Neutral thresholds of the Análisis header metrics.
 *     Values arrive in the units of the overview (percent for returns and yields, plain ratio for beta and Deuda/patrimonio).
 *
 * Layer: Frontend / Utils
 * Key Functions: metricState(key, value)
 */
export type MetricKey = 'mos' | 'roic' | 'roe' | 'roa' | 'fcfy' | 'divy' | 'augdiv' | 'buyback' | 'beta' | 'de';
export type MetricStateName = 'strong' | 'weak' | 'neutral';

export interface MetricState {
    state: MetricStateName;
    word: 'Fuerte' | 'Débil' | 'Neutral';
    symbol: '▲' | '▼' | '●';
}

// Higher is better unless lowerIsBetter. Referential thresholds, not advice.
const THRESHOLDS: Record<MetricKey, { strong: number; weak: number; lowerIsBetter?: boolean }> = {
    mos: { strong: 20, weak: 0 },
    roic: { strong: 15, weak: 10 },
    roe: { strong: 15, weak: 8 },
    roa: { strong: 5, weak: 2 },
    fcfy: { strong: 5, weak: 2 },
    divy: { strong: 2, weak: 0.5 },
    augdiv: { strong: 3, weak: 1 },
    buyback: { strong: 2, weak: 0.5 },
    beta: { strong: 1, weak: 1.5, lowerIsBetter: true },
    de: { strong: 0.5, weak: 2, lowerIsBetter: true },
};

const OUT: Record<MetricStateName, MetricState> = {
    strong: { state: 'strong', word: 'Fuerte', symbol: '▲' },
    weak: { state: 'weak', word: 'Débil', symbol: '▼' },
    neutral: { state: 'neutral', word: 'Neutral', symbol: '●' },
};

export function metricState(key: MetricKey, value: number): MetricState {
    const t = THRESHOLDS[key];
    if (t.lowerIsBetter) return OUT[value <= t.strong ? 'strong' : value > t.weak ? 'weak' : 'neutral'];
    return OUT[value >= t.strong ? 'strong' : value < t.weak ? 'weak' : 'neutral'];
}
