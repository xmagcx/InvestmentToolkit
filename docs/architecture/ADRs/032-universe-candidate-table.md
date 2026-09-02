# ADR-032: Universe Candidate Table & Repository Layer

- **Status**: Accepted
- **Date**: 2026-09-02
- **Author**: SDD design phase (universe change)

---

## Context

The user needs a curated set of potential investment candidates (stocks/companies) stored in a dedicated SQLite table, independent from the existing `investment`/watchlist tables. Purpose: run automated/AI analysis scoped to exactly that group. Previously this data existed only in ad-hoc CSVs with no persistence or UI.

## Decision

### 1. New `universe_candidate` table in `domain_model.sqlite`

```
ticker      TEXT PRIMARY KEY,
name        TEXT NOT NULL,
source      TEXT NOT NULL,
asset_class TEXT,              -- nullable
added_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
```

DDL registered as a new `CREATE TABLE IF NOT EXISTS` block in `db_client.py::initialize_db`. This is a brand-new table, so it does NOT go into `SCHEMA_EVOLUTIONS` (that registry handles column-adds to existing tables only, per `_evolve_schema`'s docstring). It self-creates on the next `initialize_db()` call.

Independent entity — deliberately not reusing `investment`/watchlist, keeping the curated candidate pool separate from live portfolio thesis state.

### 2. Repository layer (one-writer-per-table)

- Python: `domain_model/universe_repository.py` — `upsert_universe_candidate`, `list_universe_candidates`, `delete_universe_candidate`. Mirrors `cash_flow_repository.py`.
- TS: `services/UniverseRepository.ts` — better-sqlite3 counterpart for list/delete, mirroring `services/InvestmentRepository.ts`.

Per ADR-028's anti-duplication rule, no service or route opens its own connection against `universe_candidate`; the two repositories are the only writers.

### 3. Ingestion via `py_services/ingest_universe_csv.py`

Bridge pattern: Express `POST /api/universe/upload` shells out to `spawnPythonScript('ingest_universe_csv.py', [...])`, matching how `portfolio_performance.py` is invoked. Parsing + ticker normalization (`ticker_aliases.normalize_ticker`) live in Python only (no duplicated logic in TS). Reads/deletes use the TS `UniverseRepository` directly (trivial, no python round-trip needed).

## Consequences

- One canonical source of truth for the candidate universe, self-healing on DB init.
- No new npm/Python dependencies (stdlib `csv` only).
- The bridge maintains the existing Express↔Python split already load-bearing in the codebase.
