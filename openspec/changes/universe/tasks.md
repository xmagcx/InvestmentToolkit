# Tasks: Universe — Curated Candidate Stock List

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | 500–600 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Suggested split | Single PR (delivery strategy: single-pr) |
| Delivery strategy | single-pr |
| Chain strategy | size-exception |

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: Medium

> Review budget is 400 lines but delivery strategy is `single-pr`. This is a
> modest feature across well-scoped new files + small modifications to 4
> existing files. No chain needed.

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|----------------------|-----------------|-------------------|
| 1 | Storage + Python ingestion | PR 1 | `python3 -m pytest investment_screener/backend/tests/py_services/test_ingest_universe_csv.py -v` | Real tmp_path DB writes | Remove universe_repository.py, ingest_universe_csv.py, db_client.py change |
| 2 | Express routes + TS repo | PR 1 | `npm run test -w backend` | Real better-sqlite3 against tmp DB | Remove UniverseRepository.ts, routes/universe.ts, index.ts change |
| 3 | Frontend page + nav + api | PR 1 | `npm run test -w frontend` + `npm run lint -w frontend` | Rendered page with mock fetch | Remove UniversePage.tsx, revert App.tsx/Sidebar.tsx/api.ts changes |

## Phase 1: Storage + Python Ingestion

- [x] 1.1 RED: Write pytest in `tests/py_services/test_ingest_universe_csv.py` — test `_split_source`, header validation, empty ticker rejection, ticker normalization (`PSU.U.TO` → `PSU-U.TO`), duplicate skip, empty CSV. All tests MUST fail (no impl yet).
- [x] 1.2 GREEN: Create `py_services/domain_model/universe_repository.py` with `upsert_universe_candidate`, `list_universe_candidates`, `delete_universe_candidate` — mirrors `cash_flow_repository.py`. Add `CREATE TABLE IF NOT EXISTS universe_candidate` block in `db_client.py::initialize_db` (NOT in SCHEMA_EVOLUTIONS). Verify tests pass: `python3 -m pytest tests/py_services/test_ingest_universe_csv.py -v`.

## Phase 2: Python Ingestion Script

- [x] 2.1 GREEN (continued): Create `py_services/ingest_universe_csv.py` — CLI accepting `--csv <path>` | `--payload <csv-text>` and `--db-path <path>` and `--dry-run`. CSV parse with header validation, `_split_source` helper, ticker normalization via `ticker_aliases.normalize_ticker`, idempotent upsert/skip-not-fail, rejected-row report. Verify all tests from 1.1 pass.
- [ ] 2.2 Verify full Python suite: `python3 run_tests.py --unit` — no regressions.

## Phase 3: Express Routes + TypeScript Repository

- [x] 3.1 RED: Write mocha test for `routes/universe.ts` — test POST /upload success (200 + summary), POST /upload malformed CSV (400), POST /upload missing body (400), GET / list (200 + array), GET / empty (200 + []), DELETE /:ticker success (200), DELETE /:ticker nonexistent (404). All tests MUST fail.
- [x] 3.2 GREEN: Create `src/services/UniverseRepository.ts` — better-sqlite3 repo with `list()` (ordered by `added_at DESC`) and `delete(ticker)` (normalize, return boolean). Mirror `services/InvestmentRepository.ts` pattern.
- [x] 3.3 GREEN (continued): Create `src/routes/universe.ts` — POST /upload shells to `spawnPythonScript('ingest_universe_csv.py', ...)`, GET / calls `UniverseRepository.list()`, DELETE /:ticker calls `UniverseRepository.delete()`. Register router in `src/index.ts` at `/api/universe`. Bump `express.json({limit:'5mb'})` in `index.ts`. Verify all tests from 3.1 pass.

## Phase 4: Frontend + Navigation

- [x] 4.1 RED (service-level): Write vitest test for the universe API client (`api.universe.test.ts`) — upload POSTs csv + returns summary, upload throws on non-ok, fetch GETs array, delete sends DELETE, delete throws on 404. Note: component-render testing of `UniversePage.tsx` is out of scope — the vitest harness is node-env with no jsdom/@testing-library and the change forbids new npm deps, so the reducible unit is the service layer (same approach as `api.test.ts`).
- [x] 4.2 GREEN: Add `uploadUniverseCsv(csvText)`, `fetchUniverse()`, `deleteUniverseTicker(ticker)` to `frontend/src/services/api.ts`.
- [x] 4.3 GREEN (continued): Create `frontend/src/pages/UniversePage.tsx` — file input for `.csv`, upload button, candidate table (Ticker, Name, Source, Asset Class, Added At), per-row delete button, error display. Add `/universe` route in `App.tsx`. Add "Candidate Universe" entry in `Sidebar.tsx` NAV_ITEMS. Verify vitest + lint pass.

## Phase 5: Integration Verification

- [ ] 5.1 Full build check: `npm run build -w backend && npm run build -w frontend` — no type errors.
- [ ] 5.2 Full test suite: `python3 run_tests.py --unit` + `npm run test -w backend` + `npm run test -w frontend` — all green, no regressions.

---

## Key Learnings

1. Universe candidate table uses CREATE TABLE IF NOT EXISTS in initialize_db, not SCHEMA_EVOLUTIONS — brand-new tables self-create on init.
2. Source field has two formats: bare source sets asset_class=NULL, comma-separated splits first segment to asset_class.
3. Upload bridges through spawnPythonScript pattern already load-bearing in portfolio_performance.py — no new bridge needed.
4. List/delete use better-sqlite3 direct (TS side), upload uses Python round-trrip for parse/normalization reuse.
5. TDD Iron Law means every phase starts with a RED task that writes failing tests before any implementation.
