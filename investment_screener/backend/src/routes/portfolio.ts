/**
 * portfolio.ts - Express routing for user portfolio positions, balances, and sync.
 * 
 * Purpose:
 *   Handles backend Express routes for user portfolio data management,
 *   rebalancing updates, live snapshot sync, and performance tracking.
 * 
 * Layer:
 *   Backend / Routes / Portfolio
 * 
 * Key Functions (Index):
 *   - loadYtdPerformanceReport() - Executes time-weighted returns script and reads generated report
 *   - verifyPortfolioTotals(holdings, tvSnapshot) - Reconciliation gate comparing computed vs broker total
 *   - getHoldingsForDisplayFromDb() - SQLite-sourced enriched holdings for GET /
 *
 * Routes Index:
 *   - GET / - Reads and returns aggregate portfolio holdings and the data source (domain_model_sqlite or empty)
 *   - GET /summary - Aggregates YTD/TWR returns and portfolio USD/CAD totals
 *   - GET /performance - Triggers and returns period performance details
 *   - GET /weights - Computes weight allocation ratios for each holding
 *   - GET /status - Returns the latest position sync timestamp
 *   - GET /position/:ticker - Returns price, shares, and per-account breakdown for a ticker
 *   - GET /holdings/:ticker - Retrieves per-account position counts
 *   - GET /features - Reports which optional integrations are enabled (broker_integration)
 *   - POST /refresh-prices - Refreshes prices from TradingView real-time quotes (503 when TradingView is not connected)
 *   - POST /sync-tv - Gated TradingView CDP sync returning HITL preview diff (410 while the broker is disabled)
 *   - POST /sync-tv/promote - Finalizes the HITL TradingView snapshot into domain_model.sqlite (410 while the broker is disabled)
 *   - POST /sync-tv/apply - One-shot automated sync applying TV data immediately (410 while the broker is disabled)
 *   - POST /sync - Auto-priority sync selecting reachable sources (410 while the broker is disabled)
 *   - GET /strategy-allocation - Aggregates cash and holdings by sub-strategy and pillar
 * 
 * Key Input Dependencies:
 *   - investment_screener/backend/data/domain_model.sqlite (positions, prices, cash flows, the YTD
 *     baseline with its January 1 USD/CAD rate, totals)
 *   - ytd_return.py --json (TWR performance report, printed on stdout, nothing written to disk)
 * 
 * Key Output Dependencies:
 *   - domain_model.sqlite (sync routes write through BrokerSyncService.persistSnapshotToDb)
 */

import express from 'express';
import fs from 'fs';
import { spawnPythonScript } from '../services/bridge';
import { brokerSyncService, mergeIntoPortfolio, persistSnapshotToDb } from '../services/BrokerSyncService';
import { getLiveUsdCadRate, isTradingViewConnected } from '../utils/helpers';
import { DOMAIN_MODEL_DB_FILE } from '../utils/paths';
import { computeWeightsMap, PortfolioTotals } from '../utils/portfolioSnapshot';
import { computeStrategyAllocation } from '../utils/strategyAllocation';
import { PortfolioRepository } from '../services/PortfolioRepository';
import { InvestmentRepository } from '../services/InvestmentRepository';
import { normalizeTicker } from '../utils/tickerAliases';
import { isBrokerIntegrationEnabled, requireBrokerIntegration } from '../utils/brokerIntegration';

const router = express.Router();

/** The January 1 USD/CAD rate recorded with the YTD baseline in domain_model.sqlite, or null. */
export function getJan1UsdCadRateFromDb(dbPath: string = DOMAIN_MODEL_DB_FILE): number | null {
    const repo = new PortfolioRepository(dbPath);
    try {
        return repo.getJan1UsdCadRate();
    } finally {
        repo.close();
    }
}

/**
 * Runs the Python TWR calculation and returns its JSON report (null when there is no cash-flow
 * baseline yet). Nothing is written to disk.
 */
async function loadYtdPerformanceReport(): Promise<any> {
    /*
      Cash-flow data lives in domain_model.sqlite's cash_flow / cash_flow_baseline tables.
      ytd_return.py performs the gate itself: load_cash_flows() returns {} when the DB has no
      baseline row yet (fresh install / no cash flows recorded), and calculate_twr() then prints
      {"available": false, "reason": ...} with exit 0 — an empty state, returned as null. A real
      failure (bad baseline, crash) still exits non-zero and is logged below.
     */
    try {
        const report = await spawnPythonScript('ytd_return.py', ['--json']);
        return report?.available === false ? null : report;
    } catch (err) {
        console.error(`[loadYtdPerformanceReport] Failed to run ytd_return.py:`, err);
    }
    return null;
}

// ── SQLite-backed reads (account_investment / investment_price) ──
// Each helper returns null/[] (never throws, never fabricates) when the database has no usable
// data yet; every route below reports that as an explicit empty state, never as file data.

/** Per ADR-030 / portfolio_repository.py::get_portfolio_total_value: the
 * portfolio-wide USD total, computed live as the sum of per-account totals
 * (never a stored value, never an independent flat query). Returns null
 * (not 0) when there's no priced position data yet, so /summary reports an empty state. */
export function getPortfolioTotalUsdFromDb(dbPath: string = DOMAIN_MODEL_DB_FILE): number | null {
    const repo = new PortfolioRepository(dbPath);
    try {
        const total = repo.getPortfolioTotalValue();
        return total > 0 ? total : null;
    } finally {
        repo.close();
    }
}

/** The time the stalest held price was fetched: the honest "as of" time for the portfolio value. */
export function getOldestPositionPriceAtFromDb(dbPath: string = DOMAIN_MODEL_DB_FILE): string | null {
    const repo = new PortfolioRepository(dbPath);
    try {
        return repo.getOldestPositionPriceAt();
    } finally {
        repo.close();
    }
}

/** The real, current "last synced" timestamp — `MAX(account_investment.last_synced_at)`,
 * which updates on every real sync. */
export function getLastSyncedAtFromDb(dbPath: string = DOMAIN_MODEL_DB_FILE): string | null {
    const repo = new PortfolioRepository(dbPath);
    try {
        return repo.getLastSyncedAt();
    } finally {
        repo.close();
    }
}

/** Builds the {holdings, totals}-shaped input `computeWeightsMap` expects from
 * account_investment/investment_price. Returns null when there's no priced position data. */
export function getWeightsFromDb(dbPath: string = DOMAIN_MODEL_DB_FILE): Record<string, number> | null {
    const repo = new PortfolioRepository(dbPath);
    try {
        const positions = repo.listPositionsBySymbol();
        const totalUSD = repo.getPortfolioTotalValue();
        if (positions.length === 0 || totalUSD <= 0) return null;
        const holdings = positions.map(p => ({
            symbol: p.symbol === 'CASH_USD' ? 'USD_CASH' : p.symbol,
            shares: p.quantity,
            price: p.price ?? p.averageCost ?? 0,
        }));
        const totals: PortfolioTotals = {
            holdingsUSD: totalUSD, cashUSD: 0, totalUSD, totalCAD: 0, exchangeRate: 1,
            timestamp: new Date().toISOString(), totalSource: 'tv_authoritative',
        };
        return computeWeightsMap(holdings, totals);
    } finally {
        repo.close();
    }
}

/** Builds `positions`/`totals` input for `computeStrategyAllocation` from SQLite.
 * Returns null when there's no priced position data. */
export function getStrategyAllocationInputFromDb(dbPath: string = DOMAIN_MODEL_DB_FILE): { positions: any[]; totals: { totalUSD: number } } | null {
    const repo = new PortfolioRepository(dbPath);
    try {
        const positions = repo.listPositionsBySymbol();
        const totalUSD = repo.getPortfolioTotalValue();
        if (positions.length === 0 || totalUSD <= 0) return null;
        const mapped = positions.map(p => {
            const symbol = p.symbol === 'CASH_USD' ? 'USD_CASH' : p.symbol;
            return {
                symbol,
                shares: p.quantity,
                price: p.price ?? p.averageCost ?? 0,
                book_price: p.averageCost ?? 0,
                sector: symbol === 'USD_CASH' ? 'CASH' : undefined,
            };
        });
        return { positions: mapped, totals: { totalUSD } };
    } finally {
        repo.close();
    }
}

/** Per-account quantity/average_cost for one ticker, for /position/:ticker and
 * /holdings/:ticker. Returns [] when the symbol has no `account_investment` rows:
 * an empty per-account breakdown is a legitimate "not currently held" answer. */
export function getAccountPositionsFromDb(
    ticker: string,
    dbPath: string = DOMAIN_MODEL_DB_FILE
): Array<{ accountId: string; quantity: number; averageCost: number | null }> {
    const repo = new PortfolioRepository(dbPath);
    try {
        return repo.getPerAccountPositions(ticker);
    } finally {
        repo.close();
    }
}

/** The enriched holdings array GET /api/portfolio serves, sourced from SQLite. Per held
 * symbol: shares (quantity summed across accounts), price, book_price
 * (average_cost) from account_investment/investment_price, plus
 * name/sector/industry/pillar_id from the `investment` row. sector/industry fall
 * back to "Unknown" (matching fetch_portfolio_heatmap.py) when not yet resolved —
 * e.g. right after a fresh TV sync, before the first /refresh-prices run.
 * Returns null when there are no priced/held positions in SQLite yet, so GET /
 * reports an empty state. */
export function getHoldingsForDisplayFromDb(dbPath: string = DOMAIN_MODEL_DB_FILE): any[] | null {
    // InvestmentRepository first: it owns and fully creates the `investment` table
    // (all columns + indexes). Opening PortfolioRepository first on a brand-new
    // file would create a narrower `investment` table, making InvestmentRepository's
    // later index-on-lifecycle_status/pillar_id creation fail.
    const investmentRepo = new InvestmentRepository(dbPath);
    const portfolioRepo = new PortfolioRepository(dbPath);
    try {
        const positions = portfolioRepo.listPositionsBySymbol();
        if (positions.length === 0) return null;
        return positions.map(p => {
            const displaySymbol = p.symbol === 'CASH_USD' ? 'USD_CASH' : p.symbol;
            const inv = investmentRepo.getInvestment(p.symbol);
            return {
                symbol: displaySymbol,
                shares: p.quantity,
                price: p.price ?? undefined,
                book_price: p.averageCost ?? undefined,
                name: inv?.name ?? displaySymbol,
                sector: displaySymbol === 'USD_CASH' ? 'CASH' : (inv?.sector ?? 'Unknown'),
                industry: displaySymbol === 'USD_CASH' ? 'CASH' : (inv?.industry ?? 'Unknown'),
                pillarId: inv?.pillar_id ?? null,
            };
        });
    } finally {
        investmentRepo.close();
        portfolioRepo.close();
    }
}

/** Book value (sum of quantity * average_cost across held positions) and
 * position count, from account_investment. Returns null when there are no
 * priced/held positions in SQLite yet. */
export function getBookValueAndCountFromDb(dbPath: string = DOMAIN_MODEL_DB_FILE): { totalBookValueUSD: number; positionCount: number } | null {
    const portfolioRepo = new PortfolioRepository(dbPath);
    try {
        const positions = portfolioRepo.listPositionsBySymbol();
        if (positions.length === 0) return null;
        const totalBookValueUSD = positions.reduce((sum, p) => sum + p.quantity * (p.averageCost ?? 0), 0);
        const equityPositions = positions.filter(p => p.symbol !== 'CASH_USD' && p.symbol !== 'USD_CASH');
        return { totalBookValueUSD, positionCount: equityPositions.length };
    } finally {
        portfolioRepo.close();
    }
}

/** Single-ticker price + book_price (weighted average cost across accounts),
 * from investment_price/account_investment. Returns null when the ticker has
 * no investment_price row (never synced/priced yet). */
export function getPositionPriceFromDb(ticker: string, dbPath: string = DOMAIN_MODEL_DB_FILE): { price: number | null; book_price: number | null } | null {
    const investmentRepo = new InvestmentRepository(dbPath);
    const portfolioRepo = new PortfolioRepository(dbPath);
    try {
        // Read-only lookup: viewing a ticker this database does not know must not create a row.
        const investment = investmentRepo.getInvestment(ticker);
        if (investment == null) return null;
        const priceRow = portfolioRepo.getInvestmentPrice(investment.investment_id);
        if (priceRow == null) return null;
        const accountRows = portfolioRepo.getPerAccountPositions(ticker);
        const totalQty = accountRows.reduce((s, r) => s + r.quantity, 0);
        const totalCost = accountRows.reduce((s, r) => s + r.quantity * (r.averageCost ?? 0), 0);
        const book_price = totalQty > 0 ? totalCost / totalQty : null;
        return { price: priceRow.price, book_price };
    } finally {
        investmentRepo.close();
        portfolioRepo.close();
    }
}

/**
 * Reconciliation gate: compare our computed portfolio value vs TV broker total.
 * holdings = the merged positions (with stored prices)
 * tvSnapshot = raw TV snapshot object (has snapshots[].balances)
 */
function verifyPortfolioTotals(holdings: any[], tvSnapshot: any): {
    holdingsTotal: number; totalCash: number; computedTotal: number;
    brokerTotal: number; diff: number; pct: number; isValid: boolean;
} {
    const holdingsTotal = holdings
        .filter(p => (p.symbol || p.ticker) !== 'USD_CASH')
        .reduce((sum, p) => sum + (p.shares || 0) * (p.price ?? p.book_price ?? 0), 0);
    const totalCash = (tvSnapshot.snapshots ?? []).reduce((sum: number, snap: any) => {
        return sum + (snap?.balances?.cashUSD ?? 0);
    }, 0);
    const computedTotal = holdingsTotal + totalCash;
    const brokerTotal = (tvSnapshot.snapshots ?? []).reduce((sum: number, snap: any) => {
        const equity = snap?.balances?.totalEquityUSDCombined ?? snap?.balances?.totalEquityUSD ?? 0;
        return sum + (typeof equity === 'number' && equity > 0 ? equity : 0);
    }, 0);
    const diff = computedTotal - brokerTotal;
    const pct = brokerTotal > 0 ? (diff / brokerTotal) * 100 : 0;
    const isValid = Math.abs(diff) <= 200 || Math.abs(pct) <= 0.5;
    return { holdingsTotal, totalCash, computedTotal, brokerTotal, diff, pct, isValid };
}

// ── Portfolio CRUD ────────────────────────────────────────────────────────────

router.get('/', async (_req, res) => {
    try {
        // Enriched holdings come from SQLite only (account_investment / investment_price plus
        // investment.name / sector / industry / pillar_id). An empty database is reported as an
        // explicit empty state; positions arrive through the broker sync (POST /sync-tv/apply).
        const dbHoldings = getHoldingsForDisplayFromDb();
        res.json({ items: dbHoldings ?? [], dataSource: dbHoldings != null ? 'domain_model_sqlite' : 'empty' });
    } catch (error) {
        console.error(`[API] Error reading portfolio: `, error);
        res.status(500).json({ error: 'Failed to read portfolio' });
    }
});

// ── Summary & Performance ─────────────────────────────────────────────────────

router.get('/summary', async (_req, res) => {
    console.log(`[API] Computing portfolio summary...`);
    try {
        // ── Market value: computed live from domain_model.sqlite (account_investment JOIN
        // investment_price, GROUP BY account_id then summed, per ADR-030 /
        // portfolio_repository.py::get_portfolio_total_value), never from a stored `totals`
        // block. With no priced positions the summary is an explicit empty state (zeros,
        // price_source 'empty').
        let totalMarketValueUSD = 0;
        let totalMarketValueCAD = 0;
        // Rate fallback when no live rate was ever synced: the January 1 rate recorded with the
        // YTD baseline, else 1 (CAD totals then equal USD totals and the summary says so).
        const jan1UsdCadRate = getJan1UsdCadRateFromDb();
        const fallbackUsdCadRate = jan1UsdCadRate ?? 1;
        let liveUsdCadRate = fallbackUsdCadRate;
        let priceSource = 'empty';

        const dbTotalUSD = getPortfolioTotalUsdFromDb();
        if (dbTotalUSD != null) {
            // Always the live, SQLite-sourced broker_exchange_rate, so the Portfolio Summary and
            // the Portfolio Table show the same CAD total (stock.ts also always uses
            // getLiveUsdCadRate()).
            liveUsdCadRate = await getLiveUsdCadRate(fallbackUsdCadRate);
            totalMarketValueUSD = dbTotalUSD;
            totalMarketValueCAD = dbTotalUSD * liveUsdCadRate;
            priceSource = 'domain_model_sqlite';
            console.log(`[Summary] totalUSD=$${totalMarketValueUSD.toFixed(2)} (from domain_model.sqlite)`);
        } else {
            liveUsdCadRate = await getLiveUsdCadRate(fallbackUsdCadRate);
            console.log(`[Summary] No priced positions in domain_model.sqlite — reporting an empty portfolio`);
        }

        // Book value + position count: SUM(quantity * average_cost) and the equity position
        // count from account_investment; zeros when the database has no priced positions.
        const dbBookValue = getBookValueAndCountFromDb();
        const totalBookValueUSD = dbBookValue?.totalBookValueUSD ?? 0;
        const positionCount = dbBookValue?.positionCount ?? 0;
        const totalBookValueCAD = totalBookValueUSD * liveUsdCadRate;

        // The real "last synced" time is MAX(account_investment.last_synced_at), updated on every
        // sync; with nothing synced yet it is the current time.
        // "As of" is the oldest held price, not the position sync: a sync can succeed while the price
        // refresh fails, and the page must not look current when the prices are not.
        const lastUpdated = getOldestPositionPriceAtFromDb() ?? getLastSyncedAtFromDb() ?? new Date().toISOString();

        // Fetch time-weighted performance metrics from report
        const twrReport = await loadYtdPerformanceReport();

        // Without a recorded baseline there is no year-to-date figure: explicit zeros, not an invented start.
        const ytdAvailable = twrReport != null;
        const ytdStartValueCAD_toUse = twrReport?.starting_balance_cad ?? 0;
        const ytdChangeCAD_toUse = twrReport?.dollar_gain_cad ?? 0;
        const ytdChangePctCAD_toUse = twrReport?.time_weighted_return_pct ?? 0;
        const ytdSimpleReturnPctCAD = twrReport?.simple_return_pct ?? 0;

        const ytdStartValueUSD = ytdStartValueCAD_toUse / (jan1UsdCadRate ?? liveUsdCadRate);
        const ytdChangeUSD = ytdChangeCAD_toUse / liveUsdCadRate;
        const ytdChangePctUSD = ytdChangePctCAD_toUse;

        res.json({
            positionCount,
            totalMarketValueUSD, totalMarketValueCAD,
            totalBookValueUSD, totalBookValueCAD,
            ytdAvailable,
            ytdStartValueCAD: ytdStartValueCAD_toUse,
            ytdStartValueUSD,
            ytdChangeCAD: ytdChangeCAD_toUse,
            ytdChangePctCAD: ytdChangePctCAD_toUse,
            ytdSimpleReturnPctCAD,
            ytdChangeUSD,
            ytdChangePctUSD,
            unrealizedGainUSD: totalMarketValueUSD - totalBookValueUSD,
            unrealizedGainPctUSD: totalBookValueUSD > 0 ? ((totalMarketValueUSD - totalBookValueUSD) / totalBookValueUSD) * 100 : 0,
            unrealizedGainCAD: totalMarketValueCAD - totalBookValueCAD,
            unrealizedGainPctCAD: totalBookValueUSD > 0 ? ((totalMarketValueUSD - totalBookValueUSD) / totalBookValueUSD) * 100 : 0,
            liveUsdCadRate,
            // Always a number (the screen formats it); until a January 1 rate is recorded it shows the live rate.
            jan1UsdCadRate: jan1UsdCadRate ?? liveUsdCadRate,
            jan1UsdCadRateRecorded: jan1UsdCadRate !== null,
            lastUpdated,
            price_source: priceSource,
        });
    } catch (error) {
        console.error(`[API] Error computing portfolio summary: `, error);
        res.status(500).json({ error: 'Failed to compute portfolio summary' });
    }
});

router.get('/performance', async (_req, res) => {
    console.log(`[API] Computing portfolio period performance...`);
    try {
        if (!fs.existsSync(DOMAIN_MODEL_DB_FILE)) { res.status(404).json({ error: 'No portfolio data found' }); return; }
        const data = await spawnPythonScript('portfolio_performance.py', []);
        res.json(data);
    } catch (error) {
        console.error(`[API] Error computing performance: `, error);
        res.status(500).json({ error: 'Failed to compute portfolio performance' });
    }
});

router.get('/weights', (_req, res) => {
    try {
        // Weights come from domain_model.sqlite; no priced positions gives an empty map.
        res.json(getWeightsFromDb() ?? {});
    } catch (err: any) { res.status(500).json({ error: err.message }); }
});

router.get('/status', (_req, res) => {
    try {
        // MAX(account_investment.last_synced_at): the real, current sync timestamp.
        const lastSync = getLastSyncedAtFromDb();
        res.json({ lastSync });
    } catch { res.status(500).json({ error: 'Failed to get status' }); }
});

// ── Position (price + book + per-account holdings) ───────────────────────────

router.get('/position/:ticker', (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    try {
        // price/book_price come from investment_price / account_investment; a ticker with no
        // investment_price row yet (never synced or priced) has null price and book price.
        let price: number | null = null;
        let book_price: number | null = null;
        const dbPrice = getPositionPriceFromDb(ticker);
        if (dbPrice != null) {
            price = dbPrice.price;
            book_price = dbPrice.book_price;
        }
        // Per-account quantities from domain_model.sqlite (account_investment).
        const byAccount: Record<string, number> = {};
        const dbRows = getAccountPositionsFromDb(ticker);
        for (const r of dbRows) byAccount[r.accountId] = (byAccount[r.accountId] ?? 0) + r.quantity;
        const accounts = Object.entries(byAccount).map(([account, shares]) => ({ account, shares }));
        const accountTotal = accounts.reduce((s, a) => s + a.shares, 0);
        const totalShares = accountTotal;
        const unrealizedGain = (price !== null && book_price !== null && totalShares > 0)
            ? (price - book_price) * totalShares : null;
        const unrealizedGainPct = (price !== null && book_price !== null && book_price > 0)
            ? ((price - book_price) / book_price) * 100 : null;
        res.json({ ticker, price, book_price, shares: totalShares, unrealizedGain, unrealizedGainPct, accounts, accountTotal });
    } catch { res.json({ ticker, price: null, book_price: null, shares: 0, unrealizedGain: null, unrealizedGainPct: null, accounts: [], accountTotal: 0 }); }
});

// ── Holdings by Account ───────────────────────────────────────────────────────

router.get('/holdings/:ticker', (req, res) => {
    const ticker = req.params.ticker.toUpperCase();
    try {
        // Per-account quantity/average_cost from domain_model.sqlite (account_investment);
        // average_cost maps 1:1 to this route's `avgFillPrice` field.
        const dbRows = getAccountPositionsFromDb(ticker);
        if (dbRows.length === 0) { res.json({ ticker, accounts: [], total: 0, avgFillPrice: null, dataSource: 'empty' }); return; }
        const accounts = dbRows.map(r => ({
            account: r.accountId,
            shares: r.quantity,
            avgFillPrice: r.averageCost != null ? Math.round(r.averageCost * 100) / 100 : null,
        }));
        const total = accounts.reduce((s, a) => s + a.shares, 0);
        const totalCost = accounts.reduce((s, a) => s + (a.avgFillPrice ?? 0) * a.shares, 0);
        const avgFillPrice = total > 0 ? Math.round((totalCost / total) * 100) / 100 : null;
        res.json({ ticker, accounts, total, avgFillPrice, dataSource: 'domain_model_sqlite', timestamp: null });
    } catch { res.json({ ticker, accounts: [], total: 0, avgFillPrice: null, dataSource: 'error' }); }
});

// ── Feature flags ─────────────────────────────────────────────────────────────

/** What the UI must hide. Broker-backed trading and sync are off unless the owner
 *  opted in with BROKER_INTEGRATION=on (spec S6); everything else is always available. */
router.get('/features', (_req, res) => {
    res.json({ broker_integration: isBrokerIntegrationEnabled() });
});

// ── Refresh & Sync ────────────────────────────────────────────────────────────

// /refresh-prices is deliberately NOT guarded: the one price refresh (AGENTS rule 25)
// prices held and watchlisted symbols from anonymous TradingView quotes and needs no broker.
router.post('/refresh-prices', async (_req, res) => {
    console.log(`[API] Refreshing portfolio prices from TradingView...`);
    try {
        // Prices come from TradingView real-time quotes only; there is no second price source.
        if (!(await isTradingViewConnected())) {
            res.status(503).json({ error: 'TradingView Desktop is not connected, so prices were not refreshed. Start TradingView with the debugging port open and try again.' });
            return;
        }
        // One implementation for every refresh: the same Python script the tv-price-refresh skill
        // mode runs. It reads the scope (held + watchlisted) from SQLite, quotes it from
        // TradingView, writes investment_price through the repositories and refreshes USD->CAD.
        // A symbol TradingView cannot quote keeps its previous price (a zero would corrupt the
        // totals) and is listed under `missingPrices` so the staleness is visible.
        const result = await spawnPythonScript('tv_price_refresh.py', ['--exit-zero']);
        if (!result || result.error || result.stale) {
            res.status(502).json({ error: result?.error ?? result?.staleReason ?? 'Price refresh did not run' });
            return;
        }
        const written: string[] = result.written ?? [];
        console.log(`[Portfolio] refresh-prices: wrote ${written.length} fresh prices to investment_price (tv_price_refresh.py).`);
        res.json({
            success: true, updated: written.length, missingPrices: result.failed ?? [],
            stale: result.stale ?? [], exchangeRateRefreshed: result.exchange_rate_refreshed ?? null,
        });
    } catch (error) {
        console.error(`[API] Error refreshing prices: `, error);
        res.status(500).json({ error: 'Failed to refresh prices' });
    }
});

router.post('/sync-tv', requireBrokerIntegration, async (_req, res) => {
    console.log('[API] Triggering TradingView portfolio sync...');
    try {
        const snapshot = await brokerSyncService.syncFromTV();
        const posCount = snapshot.positions?.length ?? 0;
        if (posCount === 0) {
            res.status(503).json({ error: 'TradingView returned 0 positions. Is TradingView Desktop running with a broker connected?' });
            return;
        }
        // The diff baseline is the stored positions in account_investment.
        const existing = getHoldingsForDisplayFromDb() ?? [];
        const { merged, added, removed, changed } = mergeIntoPortfolio(snapshot, existing);
        res.json({
            success: true, dataSource: 'tradingview-cdp', positionCount: posCount,
            diff: { added, removed, changed }, snapshot, merged,
            message: `TV sync: ${posCount} positions. ${added.length} added, ${removed.length} removed, ${changed.length} changed. Call POST /api/portfolio/sync-tv/promote to persist to domain_model.sqlite.`,
        });
    } catch (error: any) {
        console.error('[API] TV Sync Error:', error);
        res.status(500).json({ error: 'TradingView sync failed', details: error.message });
    }
});

router.post('/sync-tv/promote', requireBrokerIntegration, async (req, res) => {
    const { merged, snapshot } = req.body;
    if (!Array.isArray(merged) || merged.length === 0) {
        res.status(400).json({ error: 'merged array is required in request body. Call /api/portfolio/sync-tv first.' });
        return;
    }
    // When the caller passes back the raw `snapshot` from the preceding /sync-tv response, its real
    // per-account positions/cash + FX rate are persisted to domain_model.sqlite via
    // persistSnapshotToDb (the single shared writer, no duplicated logic). Without a
    // snapshot there is no per-account attribution to write (the flat `merged` array
    // lacks it), so account_investment is left to the /sync-tv/apply or /sync path;
    // thesis shares are still synced from `merged`.
    if (snapshot?.snapshots?.length) {
        try {
            persistSnapshotToDb(snapshot);
        } catch (dbErr: any) {
            console.warn(`[API] promote: failed to persist snapshot to domain_model.sqlite:`, dbErr.message);
        }
    }
    console.log(`[API] TV snapshot promoted to domain_model.sqlite (${merged.length} positions).`);
    res.json({ success: true, positionCount: merged.length, message: 'Portfolio updated from TradingView data (SQLite).' });
});

// One-shot: fetch TV snapshot → merge → persist to domain_model.sqlite immediately (no HITL gate)
router.post('/sync-tv/apply', requireBrokerIntegration, async (_req, res) => {
    console.log('[API] TV sync + auto-apply to domain_model.sqlite...');
    try {
        const snapshot = await brokerSyncService.syncFromTV();
        const posCount = snapshot.positions?.length ?? 0;
        if (posCount === 0) {
            console.warn('[API] TradingView returned 0 positions — SQLite holdings unchanged.');
            res.json({ success: true, positionCount: 0, tvAvailable: false, message: 'TradingView not available or returned 0 positions — portfolio unchanged.' });
            return;
        }
        // The diff baseline is the stored positions in account_investment.
        const existing = getHoldingsForDisplayFromDb() ?? [];
        const { merged, added, removed, changed } = mergeIntoPortfolio(snapshot, existing);
        // The fresh snapshot's real per-account positions/cash + FX rate + broker-reported
        // total are persisted to domain_model.sqlite via persistSnapshotToDb (the
        // single shared writer). /summary, /weights, /strategy-allocation, GET /,
        // /position, /holdings all now read from there.
        try {
            persistSnapshotToDb(snapshot);
        } catch (dbErr: any) {
            console.warn(`[API] apply: failed to persist snapshot to domain_model.sqlite:`, dbErr.message);
        }

        // Reconciliation gate — compare stored prices vs TV broker total
        const recon = verifyPortfolioTotals(merged, snapshot);
        if (recon.isValid) {
            console.log(`[Recon] ✅ PASS  computed=$${recon.computedTotal.toFixed(2)} broker=$${recon.brokerTotal.toFixed(2)} diff=$${recon.diff.toFixed(2)} (${recon.pct.toFixed(2)}%)`);
        } else {
            console.error(`[Recon] ❌ MISMATCH  computed=$${recon.computedTotal.toFixed(2)} broker=$${recon.brokerTotal.toFixed(2)} diff=$${recon.diff.toFixed(2)} (${recon.pct.toFixed(2)}%)  — run ↻ Refresh to update stored prices`);
        }

        console.log(`[API] domain_model.sqlite auto-applied from TV (${merged.length} positions).`);
        res.json({ success: true, positionCount: merged.length, tvAvailable: true, diff: { added, removed, changed }, reconciliation: recon });
    } catch (error: any) {
        console.error('[API] TV sync/apply error:', error);
        res.status(500).json({ error: 'TV sync failed', details: error.message });
    }
});

router.post('/sync', requireBrokerIntegration, async (_req, res) => {
    console.log('[API] Auto portfolio sync (TV → cache)...');
    try {
        const result = await brokerSyncService.syncAuto();
        res.json({ success: true, ...result });
    } catch (error: any) {
        console.error('[API] Auto sync error:', error);
        res.status(500).json({ error: 'Auto sync failed', details: error.message });
    }
});

// ── Strategy Allocation ───────────────────────────────────────────────────────

router.get('/strategy-allocation', async (_req, res) => {
    console.log(`[API] Computing strategy allocation...`);
    try {
        // The pillar / sub-strategy mapping comes from strategy_pillar / investment
        // (InvestmentRepository.listPillars() / listThesisHoldings()).
        const investmentRepo = new InvestmentRepository(DOMAIN_MODEL_DB_FILE);
        let thesis: any;
        try {
            const pillars = investmentRepo.listPillars().map(p => ({ id: p.id, name: p.name }));
            const holdings = investmentRepo.listThesisHoldings().map(h => ({
                ticker: h.ticker, pillarId: h.pillarId, subStrategyId: h.subStrategyId,
            }));
            thesis = { pillars, holdings };
        } finally {
            investmentRepo.close();
        }

        // Positions and totals come from domain_model.sqlite; with no priced positions the
        // allocation is computed over an empty portfolio.
        const dbInput = getStrategyAllocationInputFromDb();
        const result = dbInput != null
            ? computeStrategyAllocation(dbInput.positions, dbInput.totals, thesis)
            : computeStrategyAllocation([], { totalUSD: 0 }, thesis);
        res.json(result);
    } catch (error) {
        console.error(`[API] Error computing strategy allocation: `, error);
        res.status(500).json({ error: 'Failed to compute strategy allocation' });
    }
});

export default router;
