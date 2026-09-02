# Design: Universe — Curated Candidate Stock List

## Technical Approach

Add a dedicated `universe_candidate` table to `domain_model.sqlite` via the `SCHEMA_EVOLUTIONS` self-heal registry. A new `ingest_universe_csv.py` parses `ticker,name,source` CSVs, normalizes tickers, and writes rows through a new `universe_repository.py` (one-writer-per-table). Express `routes/universe.ts` bridges to the Python script for upload and reads/writes the table directly via better-sqlite3 for list/delete. A simple `UniversePage.tsx` frontend provides file input + maintainer table.

## Architecture Decisions

| # | Decision | Tradeoffs | Choice |
|---|---|---|---|
| 1 | DDL registration | Add full `CREATE TABLE IF NOT EXISTS` in `initialize_db` + register nothing in `SCHEMA_EVOLUTIONS` (new table, not new columns on existing table) | New table needs ONLY the `CREATE TABLE IF NOT EXISTS` block. `SCHEMA_EVOLUTIONS` handles column adds to EXISTING tables (per `_evolve_schema` docstring); a brand-new table is created by the CREATE block on every init. Do NOT add universe columns to `SCHEMA_EVOLUTIONS` — they'd never be missing. |
| 2 | Python DB write | `universe_repository.py` (new, mirrors cash_flow_repository.py) vs inline SQL in ingest script | New repository. Matches "one writer per table" rule; ingest script stays a thin CLI/parse shell. |
| 3 | Upload bridging | Shell out to python via `spawnPythonScript` vs write SQL from TS | Shell out for upload (reuses ingest+normalization logic, no duplicated parse/normalize in TS). Matches existing bridge pattern (`portfolio_performance.py`). |
| 4 | List/Delete reads | better-sqlite3 direct (`new Database(DOMAIN_MODEL_DB_FILE)`) vs shell to python | better-sqlite3 direct. Reads/Deletes are trivial and don't need a python round-trip; matches `InvestmentRepository.ts` pattern of a TS-side repo class over the same physical file. Create `UniverseRepository.ts` mirroring `InvestmentRepository.ts`. |
| 5 | CSV source split | `_split_source(field)` helper handling "RACIONAL" vs "EQUITY,RACIONAL" | Helper in `universe_repository`-level parse module. Bare source ⇒ source=field, asset_class=NULL; two segments ⇒ asset_class=first, source=second. Empty/whitespace ticker rows rejected, reported not dropped. |
| 6 | Duplicate handling | Upsert vs skip-on-constraint | Skip-not-fail at parser: check existence per row (via repo), report as `skipped`. DB PK enforcement still rejects true collisions (spec universe-storage req 2). |
| 7 | Body limit | Global `express.json({limit:'1mb'})` vs per-route bump | Set `limit: '5mb'` globally in `index.ts`. Simple, sufficient for <1000-row universes; avoids per-route override complexity. |

## Data Flow

```
UniversePage.tsx ──FileReader──> {csv:"..."} ──POST /api/universe/upload──> routes/universe.ts
                                                                    │ spawnPythonScript('ingest_universe_csv.py',['--payload',…])
                                                                    ▼
                                                              ingest_universe_csv.py ──CSV parse + normalize──> universe_repository.upsert
                                                                    │
GET /api/universe ──> UniverseRepository.list ──> universe_candidate (domain_model.sqlite)
DELETE /:ticker ────> UniverseRepository.delete
```

## File Changes

| File | Action | Description |
|------|--------|-------------|
| `investment_screener/backend/py_services/domain_model/db_client.py` | Modify | Add `universe_candidate` `CREATE TABLE IF NOT EXISTS` |
| `investment_screener/backend/py_services/domain_model/universe_repository.py` | Create | `upsert_universe_candidate`, `list_universe_candidates`, `delete_universe_candidate` |
| `investment_screener/backend/py_services/ingest_universe_csv.py` | Create | CLI/CSV parser, calls repository |
| `investment_screener/backend/tests/py_services/test_ingest_universe_csv.py` | Create | tmp_path DB tests (mirror test_backfill_investment_universe.py) |
| `investment_screener/backend/src/routes/universe.ts` | Create | POST /upload, GET /, DELETE /:ticker |
| `investment_screener/backend/src/services/UniverseRepository.ts` | Create | better-sqlite3 repo for list/delete |
| `investment_screener/backend/src/index.ts` | Modify | Register `/api/universe`, bump json limit |
| `investment_screener/frontend/src/pages/UniversePage.tsx` | Create | File input + upload + maintainer table |
| `investment_screener/frontend/src/App.tsx` | Modify | Add `/universe` route |
| `investment_screener/frontend/src/components/Sidebar.tsx` | Modify | Add NAV_ITEMS entry |
| `investment_screener/frontend/src/services/api.ts` | Modify | Add `uploadUniverseCsv`, `getUniverse`, `deleteUniverseTicker` |

## Interfaces / Contracts

```sql
CREATE TABLE IF NOT EXISTS universe_candidate (
    ticker      TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    source      TEXT NOT NULL,
    asset_class TEXT,
    added_at    TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

**CLI**: `python3 ingest_universe_csv.py --csv <path> | --payload <csv-text> --db-path <path> [--dry-run]` → prints JSON `{inserted, skipped, rejected: [...]}`.

**`_split_source(field)`**: `"RACIONAL"` → `("RACIONAL", NULL)`; `"EQUITY,RACIONAL"` → `("RACIONAL", "EQUITY")`.

## Testing Strategy

| Layer | What | Approach |
|---|---|---|
| Python unit | Header validation, `_split_source`, reject empty ticker, normalize `PSU.U.TO`→`PSU-U.TO`, duplicates skipped | pytest via `test_ingest_universe_csv.py`, tmp_path DB |
| TS route | upload → shell result, GET list order, DELETE 200/404, empty body 400 | supertest-style against `UniverseRepository` with tmp db |
| Frontend | page renders routes + table + delete | existing frontend test harness |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary beyond the established `spawnPythonScript` bridge (already tested production pattern, not new adversarial surface).

## Migration / Rollout

No data migration required. Table self-creates on next `initialize_db()`. No feature flag.

## Open Questions

- [ ] None blocking.
