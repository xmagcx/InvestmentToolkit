/**
 * signalLabel.ts
 *
 * Purpose: map recommendation.py actions to the Spanish signal shown on the Análisis page (S5).
 * Layer: Frontend / Utils. Key Functions: signalFor(action).
 */
import type { RecommendationRecord } from '../services/api';

export interface Signal {
    label: string;
    symbol: '▲' | '▼' | '●' | '◐';
    tone: 'buy' | 'sell' | 'hold' | 'watch' | 'none';
}

const SIGNALS: Record<RecommendationRecord['action'], Signal> = {
    INITIATE: { label: 'Comprar', symbol: '▲', tone: 'buy' },
    ACCUMULATE: { label: 'Comprar más', symbol: '▲', tone: 'buy' },
    MAINTAIN: { label: 'Mantener', symbol: '●', tone: 'hold' },
    TRIM: { label: 'Vender (reducir)', symbol: '▼', tone: 'sell' },
    EXIT: { label: 'Vender (todo)', symbol: '▼', tone: 'sell' },
    WATCHLIST: { label: 'En vigilancia', symbol: '◐', tone: 'watch' },
};

export const NO_SIGNAL: Signal = { label: 'Sin señal', symbol: '◐', tone: 'none' };

export function signalFor(action: RecommendationRecord['action'] | null | undefined): Signal {
    return (action && SIGNALS[action]) || NO_SIGNAL;
}
