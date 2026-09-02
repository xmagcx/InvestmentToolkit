# Design: Portfolio Maintainer (manual web portfolio entry)

## Technical Approach

Pure-TS web maintainer replacing TV/CDP broker sync as the manual portfolio entry path. A single synchronous service computes weighted-average cost + cash, mutating `account_investment` **in place** (read → recompute → upsert) and writing one `trade_log_entry` audit row per buy/sell. All reads/writes go through one `better-sqlite3` connection wrapped in `db.transaction()` for atomicity + single-writer serialization. No Python spawn, no new schema, no new transactions table.

Wiring mirrors `universe.ts`: a route factory `buildPortfolioMaintainerRoutes(dbPath)` registers under `/api/portfolio-maintainer`; handlers delegate to `PortfolioMaintainerService`. Frontend `PortfolioMaintainerPage.tsx` mirrors `UniversePage.tsx` (Tailwind slate-800/surface).

## Architecture Decisions

| Decision | Option | Tradeoff | Choice |
|---|---|---|---|
| Compute engine | TS service vs Python `/py_services` | Python = "no inline Python" rule + versioned script, but slower round-trip + spawn. TS = synchronous, unit-testable, fits Express write path | **TS service** (locked) — single-writer serialization via one connection + `db.transaction()` |
| Persistence | In-place `account_investment` vs new transactions ledger | Ledger = richer history but new schema + cross-table reconcile. In-place = no schema, read-then-recompute required | **In-place** (locked) — every op reads current row, recomputes, upserts |
| Atomicity | Per-repo connections vs one shared connection | Per-repo = no cross-table atomicity. One connection + `db.transaction()` = atomic pos+cash+audit | **Service owns one connection**; all writes wrapped in a transaction |
| Cash model | Synthetic `CASH_<CURRENCY>` `account_investment` row (avg_cost 1.0) vs account table column | Column = faster, but violates "account table is read-only by convention" + breaks existing market-value queries. Synthetic row = reuses portfolio-total machinery | **Synthetic row** (locked) |
| Currency | Position `currency` = account `base_currency` | Simple isolation; no FX mixing per account | **Per-account isolation** |

Cash is modeled per spec: a synthetic `CASH_<CURRENCY>` `account_investment` row (`quantity` = cash amount, `average_cost` = 1.0, `book_value` = quantity). It requires an `investment` row (`resolveInvestmentId('CASH_<CUR>', 'CASH', '<CUR>')` → investment_id = `CASH_<CUR>`).

## Data Flow

```
User form ── POST /transaction {account, ticker, side, qty, price, commission}
   └─ route → PortfolioMaintainerService[side](…)
        └─ db.transaction():
             read account (base_currency)        [404 if missing]
             read position  (account_investment)
             read cash row  (CASH_<cur>)
             validate oversell / overspend       [400]
             recompute qty + avg / cash
             upsert position  (or DELETE on full exit)
             upsert cash row
             write trade_log_entry
```

## File Changes

| File | Action | Description |
|---|---|---|
| `backend/src/services/PortfolioMaintainerService.ts` | Create | Weighted-avg + cash math, owns one connection, `db.transaction()` writes |
| `backend/src/services/PortfolioRepository.ts` | Modify | Add `listAccounts()`, `getAccount(accountId)`, `deleteAccountInvestment(accountId, investmentId)` |
| `backend/src/routes/portfolioMaintainer.ts` | Create | `buildPortfolioMaintainerRoutes(dbPath)` factory; GET/POST/PATCH/DELETE handlers |
| `backend/src/index.ts` | Modify | `app.use('/api/portfolio-maintainer', portfolioMaintainerRouter)` |
| `frontend/src/pages/PortfolioMaintainerPage.tsx` | Create | Accounts + positions UI, transaction form, delete-confirm dialog |
| `frontend/src/App.tsx` | Modify | Add `<Route path="portfolio-maintainer">` |
| `frontend/src/components/Sidebar.tsx` | Modify | Add `NAV_ITEMS` entry + lucide icon |
| `frontend/src/services/api.ts` | Modify | Typed fetchers (accounts/positions/transaction/delete) |
| `backend/tests/api/portfolioMaintainer.spec.ts` | Create | tmp-SQLite route tests (mirror universe.spec.ts) |
| `backend/tests/unit/portfolioMaintainerAverageCost.spec.ts` | Create | Pure avg-cost/cash unit tests |

## Interfaces / Contracts

### Service API (`PortfolioMaintainerService`)

```ts
type Side = 'BUY' | 'SELL';
interface TransactionInput { accountId: string; ticker: string; side: Side;
  qty: number; price: number; commission?: number /* default 0 */; }
class PortfolioMaintainerService {
  constructor(dbPath: string);            // opens+owns one connection
  createAccount(name: string, type: 'TFSA'|'RRSP'|'CASH', currency?: string): Account;
  setInitialCash(accountId: string, amount: number): void;   // ensures CASH_<cur> row
  buy(input: TransactionInput): PositionView;
  sell(input: TransactionInput): PositionView;               // throws on oversell
  deletePosition(accountId: string, ticker: string): void;   // 404 if absent
  listAccounts(): AccountView[];  listPositions(accountId?): PositionView[];
}
```

Arithmetic (all in account base currency; `comm = commission ?? 0`):

- **First buy**: `avg = (qty*price + comm)/qty`
- **Subsequent buy**: `newQty = oldQty + qty; newAvg = (oldQty*oldAvg + qty*price + comm)/newQty`
- **Cash buy**: `newCash = oldCash - (qty*price + comm)`; reject if `< 0` (overspend)
- **Sell**: `newQty = oldQty - qty; newAvg = oldAvg`; reject if `qty > oldQty` (oversell)
- **Cash sell**: `newCash = oldCash + (qty*price - comm)`
- **Full exit** (`newQty <= 0`): `DELETE` the position row; cash still updated

### Errors

```ts
class PortfolioMaintainerError extends Error { status: number } // 400|404
// Oversell → 400  'Cannot sell N of TICKER — position holds M'
// Overspend→ 400  'Insufficient <CUR> cash: need X, have Y'
// Not found → 404  'Account/position not found: …'
```

### trade_log_entry write (inside the transaction, after successful upsert)

`action = BUY|SELL`, `shares = qty`, `price`, `total_cost = qty*price + comm` (buy) / `qty*price - comm` (sell), `trade_date = logged_at = now ISO`, `status = 'EXECUTED'`, `source = 'MANUAL'`, `notes = first? 'opened' : 'avg=' + newAvg` / `'exit'`. Rejected ops write nothing.

### Routes (`/api/portfolio-maintainer`)

| Method/Path | Request | Response (200) |
|---|---|---|
| GET `/accounts` | – | `[{accountId, name, type, currency, cash}]` |
| GET `/positions` | – | `[{accountId, ticker, qty, avgCost, currency}]` |
| POST `/accounts` | `{name, type, currency?→default per type}` | `{accountId, name, type, currency, cash:0}` |
| PATCH `/accounts/:id` | `{name?, currency?}` | updated account |
| POST `/accounts/:id/cash` | `{amount}` | `{cash}` |
| POST `/transaction` | `{accountId, ticker, side, qty, price, commission?}` | `{position:{ticker,qty,avgCost}, cash, currency}` |
| DELETE `/position/:account/:ticker` | – | `{deleted: ticker}` |

## Testing Strategy

| Layer | Spec scenario | Test |
|---|---|---|
| Unit | First buy avg 55 | avg-cost fn |
| Unit | Subsequent buy weighted 56.67 | avg-cost fn |
| Unit | Commission omitted → 25 | avg-cost fn |
| Unit | Sell keeps avg, cash +115 | cash+avg fn |
| Unit | Oversell rejected (throw, no write) | service |
| API | Overspend rejected, no trade_log | `portfolioMaintainer.spec.ts` |
| API | Full exit deletes row, cash updated | route test |
| API | Set initial cash → CASH_CAD qty | route test |
| API | Create TFSA defaults CAD | route test |
| API | USD cash sell no FX conversion | route test |
| API | Rejected op writes no trade_log_entry | route test |

## Threat Matrix

N/A — no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary. Purely CRUD over a TS service + SQLite.

## Migration / Rollout

No migration. New routes + page are additive; existing TV/CDP sync untouched. Account/cash rows self-create on first maintainer write.

## Open Questions

- [ ] Cash synthetic `investment` symbol collision risk if a real ticker ever named `CASH_*` (accept; reserved namespace).
