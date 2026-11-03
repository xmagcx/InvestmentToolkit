/**
 * usePortfolioRisk.ts - Loads GET /api/portfolio/risk once and on demand.
 *
 * Purpose:
 *     The per-holding volatility, drawdown and risk contribution behind the bars and the Riesgo tab.
 *     A failure leaves `risk` null and sets `error`; the page keeps working without the risk columns.
 *
 * Layer: Frontend / Components / Portfolio
 *
 * Usage Examples:
 *     const { risk, loading, error, refresh } = usePortfolioRisk();
 *
 * Key Functions (Index):
 *     - usePortfolioRisk(): { risk, loading, error, refresh }
 *
 * Key Input Dependencies:
 *     - services/api (fetchPortfolioRisk)
 *
 * Key Output Dependencies:
 *     - pages/PortfolioPage.tsx
 */
import { useCallback, useEffect, useState } from 'react';
import { fetchPortfolioRisk, type PortfolioRisk } from '../../services/api';

export function usePortfolioRisk() {
    const [risk, setRisk] = useState<PortfolioRisk | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        setLoading(true);
        try {
            setRisk(await fetchPortfolioRisk());
            setError(null);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to fetch portfolio risk');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { void refresh(); }, [refresh]);
    return { risk, loading, error, refresh };
}
