# Tasks: Portfolio Maintainer

## Review Workload Forecast

| Field | Value |
|-------|-------|
| Estimated changed lines | ~850–950 |
| Budget risk (session threshold 1000) | Medium |
| Chained PRs recommended | Yes |
| Suggested split | PR1 service → PR2 routes/repo → PR3 frontend |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: Medium

### Work Units

| Unit | Goal | PR | Focused test cmd | Rollback boundary |
|------|------|----|------------------|-------------------|
| 1 | Service + avg-cash math | PR1 | `npm run test -w backend -- unit/portfolioMaintainerAverageCost.spec.ts` | Service only, no routes — deletable |
| 2 | Repo methods + routes + wiring | PR2 | `npm run test -w backend -- api/portfolioMaintainer.spec.ts` | Endpoints removable; service untouched |
| 3 | Page + api.ts + App/Sidebar | PR3 | `npm run lint -w frontend && npm run test -w frontend` | Page/nav removable; API stable |

## Phase 1: Backend Service (PR 1)

- [x] 1.1 RED: unit spec avg-cost — first buy 55, commission omitted 25 (REQ-1 S1,S3)
- [x] 1.2 RED: unit spec sub buy weighted 56.67, sell keeps avg + cash +115, oversell throw (REQ-1 S2, REQ-2 S1,S2, REQ-3)
- [x] 1.3 GREEN: `PortfolioMaintainerService.ts` ctor opens+owns one better-sqlite3 connection (dbPath)
- [x] 1.4 GREEN: pure helpers avgMath (first/sub weighted avg), cashMath (buy deduct, sell add, overspend guard) (REQ-1,2,3)
- [x] 1.5 GREEN: `buy()`/`sell()` read→recompute→upsert position (currency = base_currency) in `db.transaction()`; full exit DELETE (REQ-1,2,7)
- [x] 1.6 GREEN: synthetic `CASH_<cur>` via `resolveInvestmentId('CASH_<cur>','CASH','<cur>')`, avg_cost 1.0; overspend/oversell → `PortfolioMaintainerError` 400 (REQ-3,7)
- [x] 1.7 GREEN: write `trade_log_entry` (action BUY|SELL, total_cost, source MANUAL, status EXECUTED, logged_at=now) same txn; skipped on reject (REQ-5)

## Phase 2: Routes + Repo + Wiring (PR 2)

- [x] 2.1 RED: `portfolioMaintainer.spec.ts` (tmp SQLite, mirror universe.spec.ts) — create TFSA defaults CAD, set initial cash → CASH_CAD 5000, USD cash sell no FX, full exit deletes row, rejected op no trade_log (REQ-4, REQ-2 S3, REQ-3 S3, REQ-5 S2, REQ-7 S1)
- [x] 2.2 GREEN: `PortfolioRepository.ts` add `listAccounts()`, `getAccount(accountId)`, `deleteAccountInvestment(accountId, investmentId)` (REQ-4,6)
- [x] 2.3 GREEN: `portfolioMaintainer.ts` `buildPortfolioMaintainerRoutes(dbPath)` — GET/POST/PATCH accounts, POST /:id/cash, POST /transaction, DELETE /position/:account/:ticker; 400/404 (REQ-1–7)
- [x] 2.4 GREEN: `index.ts` `app.use('/api/portfolio-maintainer', portfolioMaintainerRouter)` (A-6)

## Phase 3: Frontend (PR 3)

- [x] 3.1 GREEN: `api.ts` typed fetchers — accounts/positions/transaction/delete (A-8)
- [x] 3.2 GREEN: `PortfolioMaintainerPage.tsx` mirrors UniversePage (slate-800/surface) — accounts, positions table, buy/sell form, delete-confirm dialog (A-9)
- [x] 3.3 GREEN: `App.tsx` route `portfolio-maintainer`; `Sidebar.tsx` NAV_ITEMS + lucide icon (A-7)

## Phase 4: Verification

- [x] 4.1 Verify: build/lint/test green (`npm run test -w backend`, `npm run lint -w frontend`, `tsc --noEmit`), worktree-first + TDW — backend 223 passing (3 pre-existing real-DB failures on empty worktree DB, not this change); frontend 31 passing + build + tsc clean; lint fails on pre-existing repo-wide errors (~197, same on base), my files add none
- [x] 4.2 Verify: manual smoke on fresh SQLite mirroring `domain_model.sqlite` — account, initial cash, buy, sell, full exit; confirm trade_log rows + cash invariant (REQ-5,6,7). Real-DB injection into main checkout deferred (Pitfall 29 + data-integrity guard: would write fake positions into the real source of truth; orchestrator/user decision)

Traceability: REQ-1..7 + S1..S15 from spec (142); A-6..A-9 from design (143). Threat matrix N/A.
