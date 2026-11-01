/**
 * sentimentCache.ts (TypeScript helper)
 * =====================================
 *
 * Purpose:
 *     Session cache of the sentiment read of each ticker (S13): a row expanded twice reads the
 *     API once. Kept apart from SentimentBlock.tsx so the component file only exports a component.
 *
 * Layer: Frontend / UI / Helpers
 *
 * Usage Examples:
 *     sentimentCache.get('TMO'); resetSentimentCache();
 */
import type { SentimentResponse } from '../../services/opportunities';

export const sentimentCache = new Map<string, SentimentResponse>();

/** Drops the session cache (used by tests so each one starts from no reads). */
export function resetSentimentCache(): void {
    sentimentCache.clear();
}
