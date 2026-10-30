# Known Pitfalls Reference (`docs/architecture/known-pitfalls.md`)

This document is the canonical reference catalog for historical edge cases, runtime traps, and integration pitfalls across InvestmentToolkit. Numbering is permanent and retained for backwards traceability in tests and scripts.

---

### 1. `__dirname` in TypeScript Backend
`dist/index.js` resolves to `backend/dist/`, not `backend/src/`. Use `path.resolve(__dirname, '../src/script.py')`.

### 2. Python Virtual Environment Gaps
New Python imports must be added to `requirements.in`. Required baseline packages include `keyring cryptography yfinance pandas fastapi uvicorn pydantic rich typer python-dotenv`. After editing: `venv/bin/pip-compile requirements.in -o requirements.txt`.

### 3. Backend Restart Required
Production runs compiled `node dist/index.js`. Any backend code changes require `npm run build -w backend` followed by a server restart. The frontend hot-reloads via Vite; the backend does not.

### 4. (Retired Legacy Broker Seed)
The legacy broker seed endpoint was removed when the standalone broker REST integration was archived. The number is permanently reserved and not reassigned.

### 5. `lastActualPS` Nullable
In `zod-schemas.ts` use `.nullable().transform(v => v ?? 0)`. Strict `z.number()` causes HTTP 400 errors for pre-revenue or exploration mining stocks.

### 6. Projection Action Enum
`aiThesis.action` carries `INITIATE|ACCUMULATE|MAINTAIN|TRIM|EXIT|WATCHLIST`. The DCF algorithmic signal lives in `analyticsLog.valuationAction`. Portfolio urgency is recorded in `analyticsLog.portfolioUrgency`. Actions are not limited to BUY/HOLD/SELL.

### 7. TradingView CDP Single-Ticker Limitation
`tv_call("quote", sym)` reads whichever ticker is loaded on the **active chart**, regardless of the `sym` argument. Never use it for batch price refreshes (use yfinance). The "TV Live" UI badge indicates port 9222 is reachable, not that TradingView is the batch price feed.

### 8. ETF Dual-Write Persistence
`persist_etf_analysis.py` writes to `data/etf_analysis/` and `data/projections/`. Both destinations must exist for Dashboard and ETF views.

### 9. TradingView CDP `process.exit()` Mandate
All Node.js CDP snippets must conclude with `.then(() => process.exit(0)).catch(() => process.exit(1))`. Without this explicit termination, Python `subprocess.run()` calls will hang indefinitely.

### 10. TradingView CDP Monaco Key Traversal
Do not use CSS class selectors for Pine Editor / Monaco internals because TradingView class names change frequently across builds. Use `__reactFiber` key traversal to locate Monaco editor instances.

### 11. TradingView CDP Engine Location
Located at the `tradingview-cdp/` root (ADR-024). Import via `tv_client.py`: `from tv_client import TV_CLI, tv_call, TV_NODE_DIR`. Never hardcode relative or absolute machine paths.

### 12. Pine Inject: Pass Content, Not File Path
`tv_pine_inject.py` passes `--content` to Node. Node's working directory is `tradingview-cdp/`, so relative file paths from Node fail silently.

### 13. "Update on Chart" vs "Add to Chart"
When the Pine Editor already has a prior script loaded, the editor button displays "Update on chart" instead of "Add to chart". The selector must match both patterns: `/(?:add|update).*(?:to|on).*chart/i` against `button.textContent + button.title`.

### 14. TradingView Data Window Tab
To read technical indicators, toggle `data-name="object_tree"`. You must switch to the "Data window" tab (not the default "Object tree"). Read via `[data-test-id-value-title]`. Commands: `chart openDataWindow`, `chart read`.

### 15. TradingView CDP CLI Reference
Commands route via `node tradingview-cdp/cli.js`:
- Chart: `chart symbol`, `chart timeframe`, `chart addIndicator`, `chart removeIndicator`, `chart openDataWindow`, `chart read`, `chart saveLayout`
- Pine: `pine inject --file`, `pine save`, `pine read`

### 16. Temporary Scratch Files
Use `InvestmentToolkit/temp/<artifact>`, never `/tmp/` or system temp folders. Create directories with `os.makedirs(TEMP_DIR, exist_ok=True)`.

### 17. TradingView Account Dropdown Click
Standard `.click()` events fail on TradingView's custom React dropdowns. Dispatch `mousedown + mouseup + click` to both the option span and its `parentElement`.

### 18. PSU-U.TO Symbol Canonicalization
`PSU.U.TO` (broker dot notation) = `PSU-U.TO` (canonical hyphen format, hardcoded in `fetch_broker_data.py`). Never allow divergent thesis or holding entries for the cash vehicle.

### 19. `targetEntryPrice` Storage
Optional float, stored as a `TARGET_ENTRY`-kind row in `domain_model.sqlite`'s `price_level_tier` table. Set via `update_targets.py --set-entry TICKER=PRICE --write`. Never propose buys above this price.

### 20. Portfolio Sync Fallback Hierarchy
1. Express API `POST sync-tv/apply`
2. `fetch_broker_data.py --snapshot` (direct CDP, operates independently of backend server). Run `--snapshot` directly when the backend is offline.

### 21. Fractional Shares Support
`place_order.py --shares` accepts floating-point quantities (e.g. `0.5`).

### 22. Good-Till-Cancelled (GTC) Orders
TradingView CDP submits limit orders as **Day orders** by default. To make an order Good-Till-Cancelled, update the order duration manually in the TradingView interface after placement.

### 23. Pine Editor Dialog Overlay Blocks `addIndicator`
The Pine Editor dialog overlays the screen and intercepts mouse clicks, blocking the Indicators search modal. Use the "Update on chart" button directly via synthetic mouse events rather than `.click()`. Inspect `.editorBaseLayoutContainer-dialog-z_CXxRZA` visibility rather than `aria-pressed`.

### 24. Indicator Insertion Without Pine Editor
Dispatch `Input.dispatchMouseEvent` at the geometric center of the Indicators button (standard `.click()` inadvertently opens the timezone menu). Results list items match `div[class*="container-WeNdU0sq"]`.

### 25. Indicator Source Code Viewing
Access via Legend More menu → `"Source code…"` (unicode ellipsis `…`) or Indicators dialog search → source icon.

### 26. Custom Pine Script Library
Canonical multi-EMA indicator lives at `plugins/tradingview/.apm/skills/operating-tradingview-charts/assets/pinescript-indicators/ai-ta-levels.pine` (Multi-EMA 21/50/200 + volume bias). Always lint custom Pine Script before injecting: `python3 .../pine_linter.py <file.pine>`.

### 27. Portfolio Total Calculation & Exchange Rates
Compute portfolio totals using the exact cash invariant:
$$\text{Total USD} = \sum(\text{Held Equities Market Value}) + \sum(\text{Account Cash USD})$$
Never convert USD to CAD using external API calls. Always infer the exchange rate directly from TradingView's native values (e.g. `totalEquityCADCombined / totalEquityUSDCombined`).

### 28. Worktree and Subagent Isolation
All development and agent orchestration must be isolated in dedicated git worktrees. Follow the mandatory post-task verification in `.agent/rules/worktree-subagent-leak-detection.md`.

### 29. Gitignored SQLite Data Files in Worktrees
`domain_model.sqlite`, `intelligence.sqlite`, and `.env` are gitignored. Each git worktree maintains its own isolated on-disk database copies that are never merged back to `main`. To test a schema change against real data without altering it, run `plugins/toolkit-manager/.apm/skills/managing-the-toolkit/scripts/app_smoke_test.py`. Always verify real data state against the main checkout's actual database.

### 30. Deprecated JSON Data Stores Retired
`target-portfolio.json` and `portfolio.json` are permanently retired. `domain_model.sqlite` is the sole source of truth for portfolio holdings, thesis targets, pillars, price levels, and standing decisions. Automated test `plugins/toolkit-manager/.apm/skills/managing-the-toolkit/tests/test_no_retired_file_access.py` strictly prevents new reads or writes to retired JSON paths.

### 31. A Table Built by Hand on a Branch Blocks Adoption on `main`
A branch that pre-dates `schema_migrator.py` can create a table in `db_client.py` with `CREATE TABLE IF NOT EXISTS`. Opening that same gitignored database on `main` then fails with `existing database does not match 0001_baseline.sql; refusing to adopt it: unexpected table or index set: <table>`, because the baseline never declares it.

Fix it forward, never by editing the baseline or dropping the table: add a migration that declares the same table with `CREATE ... IF NOT EXISTS`, in the exact shape the branch built (columns, types, defaults, foreign keys). `_adoption_tolerances` then keeps the existing rows, records the object in the `adopted` row's `tables_touched`, and the new migration is a no-op over that file. Any shape difference, undeclared object, or unguarded `CREATE` still refuses adoption (ADR-039). When the owning branch merges, delete its hand-written DDL.

