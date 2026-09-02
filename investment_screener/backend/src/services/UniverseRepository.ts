/**
 * UniverseRepository.ts - SQLite persistence for the `universe_candidate` table.
 *
 * Purpose:
 *   TS-side counterpart to `py_services/domain_model/universe_repository.py`,
 *   reading/writing the same physical `data/domain_model.sqlite` file via
 *   `better-sqlite3`. Mirrors `InvestmentRepository.ts`'s established pattern:
 *   a thin repository class wrapping the Node SQLite driver for one table, with
 *   `ensureSchema()` transcribing the same `CREATE TABLE IF NOT EXISTS` DDL as
 *   `db_client.py::initialize_db` (idempotent no-op against the real file;
 *   load-bearing for fresh temp/test databases).
 *
 *   One-writer-per-table contract: reads (list) and deletes (delete) go through
 *   this class on the TS side; inserts are owned by the Python
 *   `ingest_universe_csv.py` → `universe_repository.py` path (the upload bridge).
 *   This class never inserts — it only lists and deletes.
 *
 * Layer:
 *   Backend / Services / Data Persistence (SQLite-backed repository)
 *
 * Key Functions (Index):
 *   - list() - All universe_candidate rows ordered by added_at DESC
 *   - delete(ticker) - Remove one candidate by (normalized) ticker; returns boolean
 */
import Database from 'better-sqlite3';

export interface UniverseCandidate {
    ticker: string;
    name: string;
    source: string;
    asset_class: string | null;
    added_at: string;
}

/** Normalize ticker aliases on the TS side (mirror ticker_aliases.normalize_ticker). */
const TICKER_ALIASES: Record<string, string> = {
    'PSU.U': 'PSU-U.TO',
    'PSU.U.TO': 'PSU-U.TO',
};

function normalizeTicker(ticker: string): string {
    return TICKER_ALIASES[ticker] ?? ticker;
}

export class UniverseRepository {
    private db: Database.Database;

    constructor(dbPath: string) {
        this.db = new Database(dbPath);
        this.ensureSchema();
    }

    close(): void {
        this.db.close();
    }

    /** Transcribed from `py_services/domain_model/db_client.py::initialize_db`.
     * Idempotent against the real, already-initialized file. */
    private ensureSchema(): void {
        this.db.pragma('journal_mode = WAL');
        this.db.pragma('foreign_keys = ON');
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS universe_candidate (
                ticker      TEXT PRIMARY KEY,
                name        TEXT NOT NULL,
                source      TEXT NOT NULL,
                asset_class TEXT,
                added_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
            );
        `);
    }

    /** All candidates ordered newest-first by added_at. */
    list(): UniverseCandidate[] {
        const rows = this.db.prepare(
            'SELECT ticker, name, source, asset_class, added_at ' +
            'FROM universe_candidate ORDER BY added_at DESC;'
        ).all() as any[];
        return rows.map((r) => ({
            ticker: r.ticker,
            name: r.name,
            source: r.source,
            asset_class: r.asset_class,
            added_at: r.added_at,
        }));
    }

    /** Delete one candidate by normalized ticker. Returns true if a row was removed. */
    delete(ticker: string): boolean {
        const info = this.db.prepare(
            'DELETE FROM universe_candidate WHERE ticker = ?;'
        ).run(normalizeTicker(ticker));
        return info.changes > 0;
    }
}
