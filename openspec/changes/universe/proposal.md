# Proposal: Universe — Curated Candidate Stock List

## Intent

User needs a curated set of potential investment candidates (stocks/companies) stored in a dedicated SQLite table, independent from existing investment/watchlist tables. Purpose: run automated/AI analysis scoped to exactly that group. Current state: no mechanism to manage such a list — data exists only in ad-hoc CSVs with no persistence or UI.

## Scope

### In Scope
- New `universe_candidate` table in `domain_model.sqlite` (independent entity, not reusing investment/watchlist)
- CSV upload parser: `ingest_universe_csv.py` in `py_services/` — parses `ticker,name,source` CSVs, normalizes tickers via `ticker_aliases.normalize_ticker`
- Express route `POST /api/universe/upload` (sends raw CSV text in JSON body — no multer)
- Express routes `GET /api/universe` (list all) and `DELETE /api/universe/:ticker` (remove)
- Frontend `UniversePage.tsx`: file input, upload button, simple maintainer table with per-row delete
- Route registration in `App.tsx` + sidebar entry in `NAV_ITEMS`

### Out of Scope
- AI/automated analysis over the universe group (future phase — this delivers data foundation only)
- Duplicate detection / merge logic beyond ticker normalization
- Bulk operations beyond single CSV upload
- Universe-level tagging or metadata beyond the stored columns

## Capabilities

### New Capabilities
- `universe-storage`: New `universe_candidate` table with ticker/name/source/asset_class/added_at columns; DDL via `SCHEMA_EVOLUTIONS` self-heal in `db_client.py`
- `universe-ingestion`: CSV parser in `py_services/` that handles the 2-column and 3-column source format ambiguity
- `universe-api`: Express CRUD routes (upload, list, delete) behind `/api/universe`
- `universe-maintainer-ui`: React page with file upload + table view + row-level delete

### Modified Capabilities
None — all new.

## Assumption Log

| # | Assumption | Risk if Wrong |
|---|-----------|---------------|
| 1 | CSV header is `ticker,name,source` (3 columns comma-separated) | Parser rejects upload — user gets clear error |
| 2 | `source` field may contain `EQUITY,RACIONAL` (asset_class + comma + source) or just `RACIONAL` (source only) | asset_class column stays NULL; no data loss |
| 3 | `domain_model.sqlite` is sole storage target (local backup) | Acceptable — matches all existing data patterns |
| 4 | Frontend sends raw CSV text via `express.json()` body (no file upload library) | Body size limit ~1MB may need slight increase for large universes |

## Approach

New table `universe_candidate` with DDL evolution via `SCHEMA_EVOLUTIONS` in `db_client.py`. Python script `ingest_universe_csv.py` handles CSV parsing, ticker normalization, and DB writes — called via Express bridge (shells out to `python3`). Frontend `UniversePage.tsx` is a simple file input + table + delete button, no complex state management needed.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `investment_screener/backend/py_services/domain_model/db_client.py` | Modified | New DDL in `SCHEMA_EVOLUTIONS` for `universe_candidate` table |
| `investment_screener/backend/py_services/ingest_universe_csv.py` | New | CSV parser script |
| `investment_screener/backend/src/routes/universe.ts` | New | Express CRUD routes |
| `investment_screener/backend/src/index.ts` | Modified | Register `/api/universe` router |
| `investment_screener/frontend/src/pages/UniversePage.tsx` | New | Maintainer UI page |
| `investment_screener/frontend/src/App.tsx` | Modified | Add route |
| `investment_screener/frontend/src/components/Sidebar.tsx` | Modified | Add NAV_ITEMS entry |
| `investment_screener/frontend/src/services/api.ts` | Modified | Add fetch wrappers |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| CSV format assumption wrong (source field layout) | Medium | Parser handles both formats; returns clear errors for unrecognized rows |
| Body size limit hit for large CSVs | Low | Increase `express.json` limit to 2MB; universe CSVs typically <1000 rows |
| Ticker normalization misses edge cases | Low | Reuse existing `ticker_aliases.normalize_ticker` — battle-tested |

## Rollback Plan

1. Drop `universe_candidate` table via `DELETE FROM schema_evolutions WHERE name = 'backfill_universe_candidate'` + `DROP TABLE universe_candidate`
2. Remove new files: `ingest_universe_csv.py`, `routes/universe.ts`, `UniversePage.tsx`
3. Revert modifications to `db_client.py`, `index.ts`, `App.tsx`, `Sidebar.tsx`, `api.ts`
4. Run `python3 run_tests.py --unit` to confirm clean state

## Dependencies

None — stdlib CSV parsing only. No new packages.

## Success Criteria

- [ ] `universe_candidate` table exists in `domain_model.sqlite` after DB init
- [ ] CSV upload via UI populates table with correct ticker normalization
- [ ] `GET /api/universe` returns all rows
- [ ] `DELETE /api/universe/:ticker` removes exactly one row
- [ ] CSV with `EQUITY,RACIONAL` source splits into asset_class=EQUITY, source=RACIONAL
- [ ] CSV with `RACIONAL` source leaves asset_class=NULL, source=RACIONAL
- [ ] All unit tests pass: `python3 run_tests.py --unit`
