/**
 * SourcesRepository.ts - read-only SQLite access for the investment-source tables.
 *
 * Purpose:
 *   Serves the "Fuentes" page (sync runs + the stocks_origin catalogue) and the "Compras
 *   recientes" page (Dataroma quarterly and insider buys). Writes belong to the Python
 *   connectors (`py_services/investment_sources/`); this class only reads, and like every
 *   other repository it verifies the Python-owned schema version via `ensureSchemaReady`
 *   and never creates or alters a table.
 *
 *   `recent_buys_q` / `recent_buys_insider` arrive in migration 0014: until that migration is
 *   applied, their readers return empty results instead of throwing, so the page renders.
 *
 * Layer:
 *   Backend / Services / Data Persistence (SQLite-backed repository)
 *
 * Usage Examples:
 *   const repo = new SourcesRepository(DOMAIN_MODEL_DB_FILE);
 *   try { repo.listLastRuns(); } finally { repo.close(); }
 *
 * Key Functions (Index):
 *   - listLastRuns() - latest run and latest successful run per source_code
 *   - listRuns(sourceCode, limit) - newest runs of one source
 *   - listStocksOrigin(filters) - paginated catalogue rows + total count
 *   - listQuarters() - quarters present in recent_buys_q, newest first
 *   - listQuarterlyBuys({quarter, symbol, limit}) - one quarter of superinvestor buys
 *   - listInsiderBuys({symbol, minAmount, relationship, tenPctOnly, days, limit}) - insider buys
 *   - in_platform (both recent-buys readers) - an active racional_gsheet row exists for the symbol
 *
 * Key Input Dependencies:
 *   - investment_screener/backend/data/domain_model.sqlite (stocks_origin, source_sync_run,
 *     recent_buys_q, recent_buys_insider)
 *
 * Key Output Dependencies:
 *   None (JSON payloads expose `ticker`; SQL keeps `symbol`)
 */
import Database from 'better-sqlite3';
import { ensureSchemaReady } from '../utils/schemaVersion';

export const RACIONAL_SOURCE_CODE = 'racional_gsheet';
export const MAX_ROW_LIMIT = 500;

export interface SourceRunRow {
    id: number;
    source_code: string;
    trigger: string;
    started_at: string;
    finished_at: string | null;
    status: 'running' | 'success' | 'failed';
    fetched: number;
    inserted: number;
    updated: number;
    reactivated: number;
    deactivated: number;
    rejected: number;
    duration_ms: number | null;
    error_message: string | null;
}

export interface SourceLastRuns {
    [sourceCode: string]: { last: SourceRunRow | null; lastSuccess: SourceRunRow | null };
}

export interface StocksOriginRow {
    id: number;
    source_code: string;
    ticker: string;
    normalized_symbol: string;
    exchange: string;
    company_name: string | null;
    asset_type: string | null;
    currency: string | null;
    country: string | null;
    sector: string | null;
    industry: string | null;
    is_active: boolean;
    platform_url: string | null;
    first_seen_at: string | null;
    last_seen_at: string | null;
}

export interface QuarterlyBuyRow {
    ticker: string;
    quarter: string;
    company_name: string | null;
    portfolio_pct: number | null;
    buys_count: number | null;
    hold_price: number | null;
    current_price: number | null;
    low_52w: number | null;
    pct_above_low_52w: number | null;
    high_52w: number | null;
    source_url: string | null;
    in_platform: boolean;
}

export interface InsiderBuyRow {
    ticker: string;
    filing_at: string;
    security_name: string | null;
    reporting_name: string | null;
    relationship: string | null;
    transaction_date: string | null;
    transaction_type: string | null;
    shares: number | null;
    price: number | null;
    amount: number | null;
    ownership_type: string | null;
    is_ten_pct_owner: boolean;
    is_amendment: boolean;
    filing_url: string | null;
    in_platform: boolean;
}

export interface StocksOriginFilters {
    source?: string;
    active?: boolean;
    assetType?: string;
    q?: string;
    limit?: number;
    offset?: number;
}

export interface InsiderFilters {
    symbol?: string;
    minAmount?: number;
    relationship?: string;
    tenPctOnly?: boolean;
    days?: number;
    limit?: number;
}

/** `true` when an active Racional catalogue row carries this normalized symbol. */
const IN_PLATFORM_SQL = `EXISTS (
    SELECT 1 FROM stocks_origin so
    WHERE so.normalized_symbol = r.normalized_symbol
      AND so.source_code = '${RACIONAL_SOURCE_CODE}'
      AND so.is_active = 1
)`;

export class SourcesRepository {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.db.pragma('journal_mode = WAL');
        ensureSchemaReady(this.db, dbPath);
    }

    close(): void {
        this.db.close();
    }

    /** Migration 0014 owns recent_buys_*; readers degrade to empty before it lands. */
    private hasTable(name: string): boolean {
        const row = this.db
            .prepare("SELECT 1 AS present FROM sqlite_master WHERE type='table' AND name = ?")
            .get(name) as { present: number } | undefined;
        return row !== undefined;
    }

    listLastRuns(): SourceLastRuns {
        const rows = this.db
            .prepare(
                `SELECT * FROM source_sync_run
                 WHERE id IN (SELECT MAX(id) FROM source_sync_run GROUP BY source_code)
                    OR id IN (SELECT MAX(id) FROM source_sync_run WHERE status = 'success' GROUP BY source_code)`
            )
            .all() as SourceRunRow[];
        const result: SourceLastRuns = {};
        for (const row of rows) {
            const entry = (result[row.source_code] ??= { last: null, lastSuccess: null });
            if (!entry.last || row.id > entry.last.id) entry.last = row;
            if (row.status === 'success' && (!entry.lastSuccess || row.id > entry.lastSuccess.id)) entry.lastSuccess = row;
        }
        return result;
    }

    listRuns(sourceCode: string, limit = 20): SourceRunRow[] {
        return this.db
            .prepare('SELECT * FROM source_sync_run WHERE source_code = ? ORDER BY id DESC LIMIT ?')
            .all(sourceCode, Math.min(limit, MAX_ROW_LIMIT)) as SourceRunRow[];
    }

    listStocksOrigin(filters: StocksOriginFilters): { total: number; rows: StocksOriginRow[] } {
        const where: string[] = [];
        const params: any[] = [];
        if (filters.source) { where.push('source_code = ?'); params.push(filters.source); }
        if (filters.active !== undefined) { where.push('is_active = ?'); params.push(filters.active ? 1 : 0); }
        if (filters.assetType) { where.push('UPPER(asset_type) = ?'); params.push(filters.assetType.toUpperCase()); }
        if (filters.q) {
            where.push("(UPPER(symbol) LIKE ? OR UPPER(COALESCE(company_name, '')) LIKE ?)");
            const like = `%${filters.q.toUpperCase()}%`;
            params.push(like, like);
        }
        const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
        const limit = Math.min(filters.limit ?? 100, MAX_ROW_LIMIT);
        const offset = Math.max(filters.offset ?? 0, 0);

        const total = (this.db.prepare(`SELECT COUNT(*) AS n FROM stocks_origin ${clause}`).get(...params) as { n: number }).n;
        const raw = this.db
            .prepare(`SELECT * FROM stocks_origin ${clause} ORDER BY symbol ASC LIMIT ? OFFSET ?`)
            .all(...params, limit, offset) as any[];
        return { total, rows: raw.map(row => this.toOriginRow(row)) };
    }

    private toOriginRow(row: any): StocksOriginRow {
        let platformUrl: string | null = null;
        if (row.source_metadata) {
            try {
                platformUrl = JSON.parse(row.source_metadata).platform_url ?? null;
            } catch {
                platformUrl = null;
            }
        }
        return {
            id: row.id,
            source_code: row.source_code,
            ticker: row.symbol,
            normalized_symbol: row.normalized_symbol,
            exchange: row.exchange,
            company_name: row.company_name,
            asset_type: row.asset_type,
            currency: row.currency,
            country: row.country,
            sector: row.sector,
            industry: row.industry,
            is_active: row.is_active === 1,
            platform_url: platformUrl,
            first_seen_at: row.first_seen_at,
            last_seen_at: row.last_seen_at,
        };
    }

    listQuarters(): string[] {
        if (!this.hasTable('recent_buys_q')) return [];
        return (this.db.prepare('SELECT DISTINCT quarter FROM recent_buys_q ORDER BY quarter DESC').all() as { quarter: string }[])
            .map(r => r.quarter);
    }

    listQuarterlyBuys(filters: { quarter?: string; symbol?: string; limit?: number }): { quarter: string | null; rows: QuarterlyBuyRow[] } {
        if (!this.hasTable('recent_buys_q')) return { quarter: null, rows: [] };
        const quarter = filters.quarter ?? this.listQuarters()[0] ?? null;
        if (!quarter) return { quarter: null, rows: [] };

        const params: any[] = [quarter];
        let symbolClause = '';
        if (filters.symbol) {
            symbolClause = ' AND UPPER(r.symbol) LIKE ?';
            params.push(`%${filters.symbol.toUpperCase()}%`);
        }
        const limit = Math.min(filters.limit ?? MAX_ROW_LIMIT, MAX_ROW_LIMIT);
        const rows = this.db
            .prepare(
                `SELECT r.*, ${IN_PLATFORM_SQL} AS in_platform
                 FROM recent_buys_q r
                 WHERE r.quarter = ?${symbolClause}
                 ORDER BY r.portfolio_pct DESC, r.symbol ASC
                 LIMIT ?`
            )
            .all(...params, limit) as any[];
        return {
            quarter,
            rows: rows.map(row => ({
                ticker: row.symbol,
                quarter: row.quarter,
                company_name: row.company_name,
                portfolio_pct: row.portfolio_pct,
                buys_count: row.buys_count,
                hold_price: row.hold_price,
                current_price: row.current_price,
                low_52w: row.low_52w,
                pct_above_low_52w: row.pct_above_low_52w,
                high_52w: row.high_52w,
                source_url: row.source_url,
                in_platform: row.in_platform === 1,
            })),
        };
    }

    listInsiderBuys(filters: InsiderFilters): InsiderBuyRow[] {
        if (!this.hasTable('recent_buys_insider')) return [];
        const days = filters.days ?? 30;
        const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 16);
        const where = ['r.filing_at >= ?'];
        const params: any[] = [since];
        if (filters.symbol) { where.push('UPPER(r.symbol) LIKE ?'); params.push(`%${filters.symbol.toUpperCase()}%`); }
        if (filters.minAmount !== undefined) { where.push('COALESCE(r.amount, 0) >= ?'); params.push(filters.minAmount); }
        if (filters.relationship) { where.push("UPPER(COALESCE(r.relationship, '')) LIKE ?"); params.push(`%${filters.relationship.toUpperCase()}%`); }
        if (filters.tenPctOnly) { where.push('r.is_ten_pct_owner = 1'); }
        const limit = Math.min(filters.limit ?? 200, MAX_ROW_LIMIT);

        const rows = this.db
            .prepare(
                `SELECT r.*, ${IN_PLATFORM_SQL} AS in_platform
                 FROM recent_buys_insider r
                 WHERE ${where.join(' AND ')}
                 ORDER BY r.filing_at DESC, r.id DESC
                 LIMIT ?`
            )
            .all(...params, limit) as any[];
        return rows.map(row => ({
            ticker: row.symbol,
            filing_at: row.filing_at,
            security_name: row.security_name,
            reporting_name: row.reporting_name,
            relationship: row.relationship,
            transaction_date: row.transaction_date,
            transaction_type: row.transaction_type,
            shares: row.shares,
            price: row.price,
            amount: row.amount,
            ownership_type: row.ownership_type,
            is_ten_pct_owner: row.is_ten_pct_owner === 1,
            is_amendment: row.is_amendment === 1,
            filing_url: row.filing_url,
            in_platform: row.in_platform === 1,
        }));
    }
}
