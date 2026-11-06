/**
 * useResource.ts (React hook)
 * =====================================
 *
 * Purpose:
 *     Lazy tab data: a tab calls it on mount, so nothing is fetched until the tab is first opened. `load` is the
 *     page's promise cache (one request per ticker+tab per page visit); tests pass `noCache`.
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: const { loading, data } = useResource(load, `news:${ticker}`, () => fetchNewsSentiment(ticker));
 */
import { useEffect, useRef, useState } from 'react';

export type Loader = <T>(key: string, fn: () => Promise<T>) => Promise<T>;
export const noCache: Loader = (_key, fn) => fn();

/** Promise cache for AnalysisPage: a failed request is dropped so reopening the tab retries it. */
export function makeLoader(cache: Map<string, Promise<unknown>>): Loader {
    return <T,>(key: string, fn: () => Promise<T>) => {
        if (!cache.has(key)) cache.set(key, fn().catch((e: unknown) => { cache.delete(key); throw e; }));
        return cache.get(key) as Promise<T>;
    };
}

export function useResource<T>(load: Loader, key: string, fn: () => Promise<T | null>): { loading: boolean; data: T | null } {
    const [state, setState] = useState<{ key: string; data: T | null } | null>(null);
    const fnRef = useRef(fn);
    useEffect(() => { fnRef.current = fn; });
    useEffect(() => {
        let live = true;
        load(key, () => fnRef.current())
            .then((data) => { if (live) setState({ key, data }); })
            .catch(() => { if (live) setState({ key, data: null }); });
        return () => { live = false; };
    }, [load, key]);
    const ready = state?.key === key;
    return { loading: !ready, data: ready ? state.data : null };
}
