# Proposal: Portfolio Maintainer

## Status
Draft — awaiting user confirmation

## Intent

`domain_model.sqlite` `account_investment` table is currently empty. The TradingView/CDP broker sync is broken and untrustworthy. User needs a manual web UI to enter, maintain, and audit portfolio positions and cash balances — replacing the broken automated sync with reliable human-driven data entry.

Without this, the entire dashboard, DCF, rebalancer, and daily sweep pipelines have zero live data to work with.

## Scope

### In Scope (6 locked product decisions)
1. **Buy → system computes weighted avg cost**: user enters ticker, qty, price, optional commission; system recomputes. First buy: `avg = (qty×price + commission) / qty`. Subsequent: `new_qty = old_qty + qty; new_avg = (old_qty×old_avg + qty×price + commission) / new_qty`.
2. **Sells/trim**: reduces quantity only, avg cost UNCHANGED: `new_qty = old_qty − qty; new_avg = old_avg`. Reject oversell (qty > old_qty). Full exit (new_qty ≤ 0): delete account_investment row.
3. **Accounts managed**: create/edit accounts (TFSA/RRSP/CASH) via the maintainer UI.
4. **Cash balance per account updated by transactions**: buy deducts `qty×price + commission`; sell adds `qty×price − commission`. Reject overspend (buy exceeding available account cash). Cash modeled as synthetic `CASH_<CURRENCY>` account_investment row (avg_cost 1.0, per existing migrate/ingest pattern).
5. **Initial cash balance editable**: maintainer allows setting each account's starting cash.
6. **Audit trail**: every buy/sell logged to `trade_log_entry`.

### Out of Scope
- No broker auto-sync (TradingView CDP or Questrade MCP integration)
- No DCF/thesis/projection logic changes
- No strategy rebalance or target-weight management
- No real-time price fetching (no investment_price writes)
- No new SQLite schema — all writes go to existing `account`, `account_investment`, `investment`, `trade_log_entry` tables

## Capabilities

### New Capabilities
- `portfolio-maintainer`: Manual portfolio data entry and maintenance — buy/sell transactions, account management, cash tracking, audit trail

### Modified Capabilities
None (no existing specs in `openspec/specs/`)

## Approach

### Architecture
Compute in-place on `account_investment` — NO new transactions table. Each operation = read current row → recompute → upsert. Pure TS service, no Python spawn overhead (matching `universe.ts` direct-DB pattern).

### Files to Create

| File | Purpose |
|------|---------|
| `backend/src/services/PortfolioMaintainerService.ts` | Pure avg-cost math + cash logic (unit-testable) |
| `backend/src/routes/portfolioMaintainer.ts` | Express factory (mirror `universe.ts` pattern) |
| `backend/tests/api/portfolioMaintainer.spec.ts` | API tests with tmp SQLite (mirror `universe.spec.ts`) |
| `frontend/src/pages/PortfolioMaintainerPage.tsx` | Table + input card + per-row actions (Tailwind slate-800/surface) |
| `frontend/tests/PortfolioMaintainerPage.spec.tsx` | Component tests |

### Files to Modify

| File | Change |
|------|--------|
| `backend/src/routes/index.ts` | Register `app.use('/api/portfolio-maintainer', router)` |
| `backend/src/services/PortfolioRepository.ts` | Add: `listAccounts()`, `getAccount()`, `deleteAccountInvestment()`, `insertAccount()` |
| `frontend/src/App.tsx` | Add route for PortfolioMaintainerPage |
| `frontend/src/components/Sidebar.tsx` | Add NAV_ITEMS entry + lucide icon |
| `frontend/src/services/api.ts` | Add typed fetchers for new endpoints |

### API Endpoints

| Method | Path | Purpose |
|--------|------|---------|
| GET | /api/portfolio-maintainer/accounts | List all accounts |
| POST | /api/portfolio-maintainer/accounts | Create account |
| PATCH | /api/portfolio-maintainer/accounts/:id | Edit account |
| POST | /api/portfolio-maintainer/accounts/:id/cash | Set initial cash balance |
| GET | /api/portfolio-maintainer/positions | List all positions (optionally filter by account) |
| POST | /api/portfolio-maintainer/transaction | Record buy or sell |
| DELETE | /api/portfolio-maintainer/position/:account/:ticker | Remove position |

### Formulas (from exploration)
- **First buy**: `avg = (qty × price + commission) / qty`
- **Subsequent buy**: `new_qty = old_qty + qty; new_avg = (old_qty × old_avg + qty × price + commission) / new_qty`
- **Sell/trim**: `new_qty = old_qty − qty; new_avg = old_avg` (reject if qty > old_qty)
- **Full exit**: delete account_investment row when new_qty ≤ 0
- **Cash buy**: deduct `qty × price + commission` from account cash (reject if insufficient)
- **Cash sell**: add `qty × price − commission` to account cash

### Cash Model
Cash stored as synthetic `CASH_<CURRENCY>` row in `account_investment` with `average_cost = 1.0` and `quantity = cash balance`. Initial cash set via POST `/accounts/:id/cash` endpoint.

## Affected Areas

| Area | Impact | Description |
|------|--------|-------------|
| `backend/src/services/PortfolioRepository.ts` | Modified | New repo methods for account CRUD and position deletion |
| `backend/src/services/PortfolioMaintainerService.ts` | New | Pure avg-cost + cash computation service |
| `backend/src/routes/portfolioMaintainer.ts` | New | Express route factory |
| `backend/src/routes/index.ts` | Modified | Route registration |
| `frontend/src/pages/PortfolioMaintainerPage.tsx` | New | Full maintainer UI page |
| `frontend/src/App.tsx` | Modified | Route addition |
| `frontend/src/components/Sidebar.tsx` | Modified | Nav item |
| `frontend/src/services/api.ts` | Modified | Typed fetchers |

## Risks

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| Upsert REPLACES avg_cost+qty (explore finding) | Confirmed | Every transaction: read current → recompute → upsert. Never upsert without prior read. |
| Cash balance drift if transaction partially fails | Low | Single DB transaction per operation (SQLite serializable) |
| No real-time prices → positions show stale market values | By design | Out of scope; dashboard shows last-known or manual price |
| Oversell edge case on concurrent requests | Very Low | SQLite serializes writes; single-user system |

## Rollback Plan

All new files. Rollback = delete new files + remove route registration + revert PortfolioRepository additions. No schema changes to domain_model.sqlite.

## Dependencies

- None (pure additive, existing DB schema sufficient)

## Success Criteria

- [ ] Buy transaction correctly computes weighted avg cost (unit test)
- [ ] Sell reduces qty, avg cost unchanged (unit test)
- [ ] Oversell rejected with clear error (unit test)
- [ ] Cash balance updated on buy/sell (unit test)
- [ ] Overspend rejected with clear error (unit test)
- [ ] Full exit deletes account_investment row (unit test)
- [ ] trade_log_entry written for every transaction (integration test)
- [ ] Account CRUD works via API (integration test)
- [ ] Frontend page renders, accepts input, shows positions (component test)
- [ ] All existing tests still pass (`run_tests.py`)

## Proposal Question Round

Before finalizing, here are product questions to sharpen the proposal:

1. **Commission field**: Should commission default to $0 (optional), or does user always enter it? If left blank, treat as 0?
2. **Cash currency**: When creating an account, should user pick currency (USD/CAD), or infer from account type (TFSA→CAD, RRSP→CAD, CASH→configurable)?
3. **Delete confirmation**: Frontend should show confirmation dialog before deleting a position or exiting a full position? Or silent with undo toast?
4. **Date of transaction**: Should each buy/sell have an optional date field (defaulting to today), or always use current timestamp?

**Assumptions** (if user skips questions):
- Commission defaults to 0 when omitted
- TFSA/RRSP = CAD, CASH = USD (matching existing `account` table convention)
- Confirmation dialog before deletes; no undo
- Timestamp = current time (no manual date entry in v1)

## Artifacts

| Artifact | Path | Topic Key |
|----------|------|-----------|
| Exploration | — | `sdd/portfolio-maintainer/explore` (Engram #140) |
| Proposal | `openspec/changes/portfolio-maintainer/proposal.md` | `sdd/portfolio-maintainer/proposal` |
| Next: Specs | `openspec/changes/portfolio-maintainer/spec.md` | — |

## Next Recommended Phase
`sdd-spec` — write delta specs with Given/When/Then scenarios for the `portfolio-maintainer` capability.
