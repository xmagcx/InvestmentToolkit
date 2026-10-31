/**
 * ProfileSummaryService.ts — read-only per-profile portfolio summary (specs S1/S2).
 *
 * Purpose:
 *   Every portfolio profile (`account` row) is reported in ITS base currency —
 *   market value, invested cost, unrealized P/L, wallet cash and its positions —
 *   plus the consolidated total in USD with the FX rates actually used. No CAD is
 *   involved unless a profile is in CAD. Two invariants:
 *     - an unpriced ticker is excluded from value and P/L and listed by name; it
 *       is NEVER valued at its cost (AGENTS "missing price" rule);
 *     - a currency with no FX rate leaves that profile's `valueUsd` null and marks
 *       the total `partial`; a missing rate is never treated as 1.0 or as zero.
 *   The synthetic `CASH_<CUR>` row is the wallet, never a position.
 *
 * Layer:
 *   Backend / Services (read-only; opens its own better-sqlite3 connection and
 *   verifies the Python-owned schema via ensureSchemaReady, like other repos)
 *
 * Key Functions (Index):
 *   - ProfileSummaryService.load() - the whole summary payload
 *   - pythonFxProvider - fx_rates.py through runPythonScriptFresh, cached 15 min
 *
 * Key Input Dependencies:
 *   - domain_model.sqlite (account, account_investment, investment, investment_price)
 *   - py_services/fx_rates.py (USD rate per profile currency)
 *
 * Key Output Dependencies:
 *   None (never writes)
 */
import Database from 'better-sqlite3';
import { ensureSchemaReady } from '../utils/schemaVersion';
import { runPythonScriptFresh } from './bridge';

export interface FxRate {
    usdTo: number;      // units of the currency that buy 1 USD
    source: string;
    asOf: string;
}

export interface FxResult {
    rates: Record<string, FxRate>;
    unavailable: string[];
}

export interface FxProvider {
    rates(currencies: string[]): Promise<FxResult>;
}

export interface SummaryPosition {
    ticker: string;
    qty: number;
    avgCost: number | null;
    price: number | null;
    priceAsOf: string | null;
    priceCurrency: string | null;
    value: number | null;
    pnl: number | null;
}

export interface ProfileSummary {
    accountId: string;
    name: string;
    currency: string;
    cash: number;
    invested: number;
    marketValue: number;
    unrealizedPnl: number;
    unrealizedPnlPct: number | null;
    pricedCount: number;
    unpricedCount: number;
    unpricedTickers: string[];
    positions: SummaryPosition[];
    usdRate: number | null;
    valueUsd: number | null;
}

export interface ProfilesSummary {
    profiles: ProfileSummary[];
    totals: {
        valueUsd: number;
        marketValueUsd: number;
        investedUsd: number;
        cashUsd: number;
        unrealizedPnlUsd: number;
        unrealizedPnlPct: number | null;
        partial: boolean;
    };
    fx: Array<{ currency: string } & FxRate>;
    fxUnavailable: string[];
    lastPriceAt: string | null;
}

const FX_CACHE_TTL_MS = 15 * 60 * 1000;
const FX_TIMEOUT_MS = 60_000;

/** fx_rates.py, with one in-memory cache entry per currency set (15 minutes). */
export const pythonFxProvider: FxProvider = {
    async rates(currencies: string[]): Promise<FxResult> {
        const wanted = [...new Set(currencies.map(c => c.toUpperCase()))].sort();
        if (wanted.length === 0) return { rates: {}, unavailable: [] };
        const key = wanted.join(',');
        const cached = _fxCache.get(key);
        if (cached && Date.now() - cached.ts < FX_CACHE_TTL_MS) return cached.value;

        const run = await runPythonScriptFresh('fx_rates.py', ['--currencies', key], FX_TIMEOUT_MS);
        const json = run.json ?? {};
        const value: FxResult = {
            rates: Object.fromEntries(
                Object.entries(json.rates ?? {}).map(([cur, r]: [string, any]) => [
                    cur,
                    { usdTo: Number(r.usd_to), source: String(r.source ?? ''), asOf: String(r.as_of ?? '') },
                ])
            ),
            unavailable: Array.isArray(json.unavailable) ? json.unavailable.map(String) : [],
        };
        _fxCache.set(key, { ts: Date.now(), value });
        return value;
    },
};

const _fxCache = new Map<string, { ts: number; value: FxResult }>();

/** Trim float dust (10 * 229.35 = 2293.4999…) without inventing precision. */
function round6(v: number): number {
    return Math.round(v * 1e6) / 1e6;
}

interface PositionRow {
    accountId: string;
    symbol: string;
    quantity: number;
    average_cost: number | null;
    price: number | null;
    price_currency: string | null;
    fetched_at: string | null;
}

export class ProfileSummaryService {
    private db: Database.Database;

    constructor(dbPath: string, private readonly fx: FxProvider = pythonFxProvider) {
        this.db = new Database(dbPath, { readonly: false });
        ensureSchemaReady(this.db, dbPath);
    }

    close(): void {
        this.db.close();
    }

    async load(): Promise<ProfilesSummary> {
        const accounts = this.db
            .prepare('SELECT account_id, account_name, base_currency FROM account ORDER BY account_id')
            .all() as Array<{ account_id: string; account_name: string; base_currency: string }>;

        const rows = this.db
            .prepare(`
                SELECT ai.account_id AS accountId, i.symbol AS symbol, ai.quantity, ai.average_cost,
                       ip.price, ip.currency AS price_currency, ip.fetched_at
                FROM account_investment ai
                JOIN investment i ON i.investment_id = ai.investment_id
                LEFT JOIN investment_price ip ON ip.investment_id = ai.investment_id
                WHERE i.symbol NOT LIKE 'CASH\\_%' ESCAPE '\\'
                ORDER BY ai.account_id, i.symbol`)
            .all() as PositionRow[];

        const cashRows = this.db
            .prepare(`
                SELECT ai.account_id AS accountId, i.symbol AS symbol, ai.quantity
                FROM account_investment ai
                JOIN investment i ON i.investment_id = ai.investment_id
                WHERE i.symbol LIKE 'CASH\\_%' ESCAPE '\\'`)
            .all() as Array<{ accountId: string; symbol: string; quantity: number }>;

        // Currencies needing a USD rate: every profile currency plus every price currency.
        const currencies = new Set<string>();
        for (const a of accounts) currencies.add(a.base_currency.toUpperCase());
        for (const r of rows) if (r.price_currency) currencies.add(r.price_currency.toUpperCase());
        const fx = await this.fx.rates([...currencies]);

        const rateOf = (currency: string | null): number | null => {
            if (!currency) return null;
            const code = currency.toUpperCase();
            if (code === 'USD') return 1;
            const rate = fx.rates[code];
            return rate && rate.usdTo > 0 ? rate.usdTo : null;
        };

        let lastPriceAt: string | null = null;
        const profiles: ProfileSummary[] = accounts.map(account => {
            const currency = account.base_currency.toUpperCase();
            const profileRate = rateOf(currency);
            const cash = cashRows
                .filter(c => c.accountId === account.account_id && c.symbol === `CASH_${currency}`)
                .reduce((sum, c) => sum + c.quantity, 0);

            const positions: SummaryPosition[] = [];
            const unpricedTickers: string[] = [];
            let invested = 0;
            let marketValue = 0;

            for (const row of rows.filter(r => r.accountId === account.account_id)) {
                const priceCurrency = row.price_currency ? row.price_currency.toUpperCase() : null;
                const priceRate = rateOf(priceCurrency);
                // A stored price in another currency converts through USD; without both
                // rates the position stays unpriced rather than mixing currencies.
                const value = row.price != null && priceRate != null && profileRate != null
                    ? round6(row.price * row.quantity * (profileRate / priceRate))
                    : null;
                const cost = row.average_cost != null ? round6(row.average_cost * row.quantity) : null;

                if (value == null) {
                    unpricedTickers.push(row.symbol);
                } else {
                    marketValue += value;
                    if (cost != null) invested += cost;
                    if (row.fetched_at && (lastPriceAt == null || row.fetched_at > lastPriceAt)) {
                        lastPriceAt = row.fetched_at;
                    }
                }

                positions.push({
                    ticker: row.symbol,
                    qty: row.quantity,
                    avgCost: row.average_cost ?? null,
                    price: value == null ? null : row.price,
                    priceAsOf: value == null ? null : row.fetched_at ?? null,
                    priceCurrency: value == null ? null : priceCurrency,
                    value,
                    pnl: value != null && cost != null ? round6(value - cost) : null,
                });
            }

            marketValue = round6(marketValue);
            invested = round6(invested);
            const unrealizedPnl = round6(marketValue - invested);
            return {
                accountId: account.account_id,
                name: account.account_name,
                currency,
                cash: round6(cash),
                invested,
                marketValue,
                unrealizedPnl,
                unrealizedPnlPct: invested > 0 ? round6((unrealizedPnl / invested) * 100) : null,
                pricedCount: positions.length - unpricedTickers.length,
                unpricedCount: unpricedTickers.length,
                unpricedTickers,
                positions,
                usdRate: profileRate,
                valueUsd: profileRate != null ? round6((marketValue + cash) / profileRate) : null,
            };
        });

        const sumUsd = (pick: (p: ProfileSummary) => number): number =>
            round6(profiles.reduce((sum, p) => (p.usdRate != null ? sum + pick(p) / p.usdRate : sum), 0));

        const investedUsd = sumUsd(p => p.invested);
        const marketValueUsd = sumUsd(p => p.marketValue);
        const cashUsd = sumUsd(p => p.cash);
        const unrealizedPnlUsd = round6(marketValueUsd - investedUsd);

        return {
            profiles,
            totals: {
                valueUsd: round6(marketValueUsd + cashUsd),
                marketValueUsd,
                investedUsd,
                cashUsd,
                unrealizedPnlUsd,
                unrealizedPnlPct: investedUsd > 0 ? round6((unrealizedPnlUsd / investedUsd) * 100) : null,
                partial: profiles.some(p => p.usdRate == null),
            },
            fx: Object.entries(fx.rates)
                .filter(([currency]) => currency !== 'USD')
                .map(([currency, rate]) => ({ currency, ...rate })),
            fxUnavailable: fx.unavailable,
            lastPriceAt,
        };
    }
}
