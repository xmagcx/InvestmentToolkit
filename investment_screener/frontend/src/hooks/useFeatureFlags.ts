/**
 * useFeatureFlags.ts - which optional integrations the backend has enabled.
 *
 * Purpose:
 *   This platform is a screener and recommendation tool (spec S6): broker-backed
 *   trading and portfolio sync are off unless the owner set BROKER_INTEGRATION=on,
 *   in which case the backend answers 410 BROKER_DISABLED. The UI must not offer a
 *   button that can only fail, so every broker-backed control reads this hook first.
 *   It fails closed: disabled until the backend explicitly says otherwise.
 *
 * Layer:
 *   Frontend / Hooks
 *
 * Usage Examples:
 *   const { broker_integration } = useFeatureFlags();
 *   if (!broker_integration) return null;
 *
 * Key Functions (Index):
 *   - useFeatureFlags() - the current flags, disabled while loading or on any failure
 *
 * Key Input Dependencies:
 *   - GET /api/portfolio/features
 *
 * Key Output Dependencies:
 *   None (read-only).
 */
import { useEffect, useState } from 'react';

export interface FeatureFlags {
    /** Broker order execution (/api/trading/*) and broker sync (/api/portfolio/sync*). */
    broker_integration: boolean;
}

const DISABLED: FeatureFlags = { broker_integration: false };

export function useFeatureFlags(): FeatureFlags {
    const [flags, setFlags] = useState<FeatureFlags>(DISABLED);

    useEffect(() => {
        let active = true;
        (async () => {
            try {
                const res = await fetch('/api/portfolio/features');
                if (!res.ok) return;
                const data = await res.json();
                // Only a literal true enables anything: an old backend without the route,
                // a proxy error page or any other payload leaves the UI screener-only.
                if (active) setFlags({ broker_integration: data?.broker_integration === true });
            } catch {
                /* offline or no backend: stay disabled */
            }
        })();
        return () => { active = false; };
    }, []);

    return flags;
}
