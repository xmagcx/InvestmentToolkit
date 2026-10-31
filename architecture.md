# Architecture Overview

Living reference for InvestmentToolkit. Update when structure, data flows, or integrations change. One copy — tool-agnostic.

---

## 1. Project Structure

```
InvestmentToolkit/                         ← repo root
├── run_investment_toolkit.py              ← unified startup (venv + npm + TV launch)
├── run_tests.py                           ← T0 compile gate + T0.5 bridge smoke
├── requirements.in / requirements.txt    ← Python deps (pip-compile managed)
│
├── investment_screener/                   ← npm workspace root
│   ├── frontend/                          ← React 19 + Vite + Tailwind CSS 4.0 (port 5173)
│   │   └── src/
│   │       ├── components/               ← shared UI (AIAnalysisModal, TradeButtons, etc.)
│   │       ├── pages/                    ← Dashboard, StockAnalysis, TradeLog, Portfolio
│   │       └── services/api.ts           ← typed fetch wrapper for backend API
│   └── backend/                          ← Node.js Express API (port 3001)
│       ├── src/
│       │   ├── index.ts                  ← Express entry point, route registration
│       │   ├── routes/                   ← /api/portfolio, /api/stock/:ticker, /api/ta-sweep
│       │   ├── services/                 ← BrokerSyncService.ts (TV CDP waterfall sync)
│       │   └── utils/                    ← zod-schemas.ts, tickerAliases.ts
│       ├── py_services/                  ← canonical Python scripts (never inline)
│       │   ├── portfolio_action.py       ← drift + DCF → BUY/HOLD/SELL actions
│       │   ├── fetch_financials.py       ← yfinance raw data fetch
│       │   ├── dcf_scenarios.py          ← DCF math (bear/base/bull)
│       │   ├── record_intelligence_event.py ← canonical event ledger tool
│       │   └── extract_portfolio_symbols.py
│       ├── data/
│       │   ├── domain_model.sqlite       ← investment/pillar/price-level/projection/trade/
│       │   │                                policy tables (gitignored, self-creating; see §4)
│       │   ├── intelligence.sqlite       ← research/TA-sweep/prediction event ledger (gitignored,
│       │   │                                self-creating)
│       │   ├── projections/              ← per-ticker DCF + aiThesis JSON copies (the
│       │   │                                valuations are in projection_version)
│       │   ├── etf_analysis/             ← ETF analysis results (versioned)
│       │   └── theses/                   ← investment_thesis.md + sub_strategies/
│       └── tests/
│           ├── fixtures/                 ← test portfolio + target JSON
│           ├── py_services/              ← unit tests for Python services
│           │   └── test_math_parity.py
│           ├── validate_all_projections.py
│           └── api/ services/ utils/
│
├── tradingview-cdp/                       ← standalone CDP engine (npm ci once)
│   ├── cli.js                            ← CLI entry: `node tradingview-cdp/cli.js <cmd>`
│   ├── README.md                         ← Engine setup, architecture, and CLI documentation
│   ├── core/
│   │   ├── trading.js                    ← order placement / cancellation / modification
│   │   ├── broker_data.js                ← account balances, positions snapshot
│   │   ├── data.js                       ← chart quotes (active chart only)
│   │   ├── pine.js                       ← Pine Script inject / save / read (Monaco fiber)
│   │   ├── chart.js                      ← symbol, timeframe, indicators, Data Window
│   │   └── sweep.js                      ← batch TA Data Window reads
│   └── package.json
│
├── plugins/                               ← APM packages (apm.yml + .apm/skills|agents)
│   ├── portfolio-advisor/                ← valuing-investments, running-portfolio-reviews,
│   │                                       setting-portfolio-targets, tracking-13f-filings,
│   │                                       auditing-portfolio-data (+ 4 agents)
│   ├── tradingview/                      ← operating-tradingview-charts, trading-via-tradingview,
│   │                                       analyzing-charts (+ ta-guide agent; audit/ runtime data)
│   ├── toolkit-manager/                  ← managing-the-toolkit (onboarding, run-app, sqlite-admin, audits)
│   └── questrade/                        ← syncing-questrade-accounts, trading-with-questrade (MCP)
│
├── apm.yml / apm.lock.yaml               ← installs the four plugins into .agents/skills/
│
├── .agents/                               ← multi-tool skill/agent store (Claude, Gemini, Copilot)
│   ├── skills/                           ← project-local skills
│   └── agents/                           ← sub-agent definitions
│
├── .agent/rules/                          ← mandatory agent behaviour policies
│   ├── self-evolution-policy.md
│   ├── test-driven-development.md
│   ├── no-inline-python.md
│   ├── coding-conventions.md
│   ├── dependency-management.md
│   └── plugin-architecture.md
│
├── docs/architecture/                     ← ADRs and sequence diagrams
├── temp/                                  ← gitignored scratch space (never /tmp/)
├── context/                               ← Agentic OS runtime control plane & 3-layer memory
│   ├── control_plane.db                  ← SQLite task state, execution lifecycle, sessions
│   ├── plugin-config.json                ← plugin maintenance policy (fork-and-pr / patch)
│   ├── events.jsonl                      ← agent self-evolution event log
│   └── os-state.json                     ← substrate runtime health & cache state
├── INIT_AGENTS.md                         ← fresh clone onboarding & upstream dependency setup
└── start_here.md                          ← session briefing & personal roadmap tracker
```

---

## 2. High-Level System Diagram

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│  User / AI Coding Agent (Claude Code / Gemini CLI / Cursor / Antigravity)         │
└─────────────┬─────────────────────────────────┬───────────────────────────────────┘
              │ browser                         │ CLI skill / agent orchestration
              ▼                                 ▼
┌───────────────────────┐       ┌───────────────────────────────────────────────────┐
│  React 19 Frontend    │       │  Agentic OS Substrate & Plugins (.agents/)        │
│  Vite · port 5173     │       │  Upstream: richfrem/agent-plugins-skills          │
└───────────┬───────────┘       │  • Control Plane: context/control_plane.db        │
            │                   │  • Substrate: os-control-init, -health, hooks     │
            │                   │  • Domain Plugins: portfolio-advisor, tradingview,│
            │                   │    stock-valuation, toolkit-manager, questrade    │
            │                   └─────────────────────────┬─────────────────────────┘
          │ /api/* (Vite proxy)               │ subprocess / Bash
          ▼                                   ▼
┌─────────────────────────────────────────────────────────────────┐
│  Express Backend  ·  Node.js / TypeScript  ·  port 3001        │
│                                                                 │
│  Routes: /api/portfolio  /api/stock/:ticker  /api/ta-sweep     │
│  BrokerSyncService.ts — TV CDP waterfall sync orchestrator     │
└──────┬──────────────────────────────────────────────────────────┘
       │ spawn
       ▼
┌──────────────────┐
│  py_services/    │
│  fetch_financials│
│  dcf_scenarios   │
│  portfolio_action│
└──────┬───────────┘
       │ HTTP
       ▼
┌──────────────────┐
│  yfinance        │
│  (market data)   │
└──────────────────┘

─────────────────── TradingView CDP Layer ────────────────────────

┌──────────────────────────────────────────────────────────────┐
│  TradingView Desktop  (macOS app, --remote-debugging-port=9222)│
└──────────────────┬───────────────────────────────────────────┘
                   │ Chrome DevTools Protocol (WebSocket)
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  tradingview-cdp/  (Node.js CDP engine)                      │
│  cli.js · core/{chart,trading,pine,broker_data,sweep}.js     │
└──────────────────┬───────────────────────────────────────────┘
                   │ subprocess
                   ▼
┌──────────────────────────────────────────────────────────────┐
│  investment_screener/backend/py_services/tv_client.py                    │
│  (Python bridge — locates CLI via TV_CDP_DIR or walk-up)    │
│  Used by: ta_sweep_batch.py, place_order.py, fetch_broker_  │
│           data.py, tv_pine_inject.py, tv_pine_manager.py,   │
│           tv_thesis_overlay.py, tv_create_alerts.py         │
└──────────────────────────────────────────────────────────────┘
```

---

## 3. Core Components

### 3.1. Frontend — React Dashboard
**Technologies:** React 19, Vite, Tailwind CSS 4.0, TypeScript  
**Port:** 5173 (dev), served via Vite proxy for `/api/*`  
**Key pages:**
- `Dashboard.tsx` — portfolio heatmap, AI thesis panel, TA sweep results
- `StockAnalysis.tsx` — per-ticker DCF projections, thesis, trade buttons
- `TradeLog.tsx` — order history (Working / Inactive / Planned / Filled / Cancelled tabs)
- `Portfolio.tsx` — drift vs. target weights

**State:** No global store — pages fetch from `/api/*` on mount. positions come from `domain_model.sqlite`'s `account_investment` / `investment_price` tables, and the thesis, targets and breakers from `investment`, `strategy_pillar` and `thesis_breaker` (ADR-038).

### 3.2. Backend — Express API
**Technologies:** Node.js, Express, TypeScript (compiled to `dist/`), Zod validation  
**Port:** 3001  
**Key routes:**
- `GET /api/portfolio` — reads positions from `domain_model.sqlite` (`dataSource: 'empty'` when none are synced yet)
- `GET /api/stock/:ticker` — reads `projections/{TICKER}.json` or `etf_analysis/{TICKER}.json`
- `POST /api/portfolio/sync-tv/apply` — applies the TV broker snapshot to `domain_model.sqlite`
- `GET /api/ta-sweep/results` — reads `intelligence.sqlite`'s TA-sweep events (formerly `ta-sweep-results.json`, migrated Wave 5B)

**Python bridge pattern:** `bridge.ts` spawns Python scripts via `child_process.spawn`. Scripts live in `src/` (NOT copied to `dist/`); always reference via `path.resolve(__dirname, '../src/script.py')`.

### 3.3. Python Services Layer
**Location:** `investment_screener/backend/py_services/`  
**Rule:** No inline calculations — all financial math lives in versioned scripts here.

| Script | Purpose |
|--------|---------|
| `portfolio_action.py` | Computes drift + DCF-gated actions (BUY/HOLD/SELL/EXIT etc.) |
| `fetch_financials.py` | Fetches raw yfinance data for a ticker |
| `dcf_scenarios.py` | Bear/Base/Bull DCF math, outputs weighted fair value |
| `extract_portfolio_symbols.py` | Reads `temp/stocks.xlsx`, outputs symbols JSON |

### 3.4. TradingView CDP Engine
**Location:** `tradingview-cdp/` (standalone Node.js package, `npm ci` once)  
**Entry:** `node tradingview-cdp/cli.js <namespace> <command> [args]`  
**Python bridge:** `investment_screener/backend/py_services/tv_client.py` — locates the CLI via `TV_CDP_DIR` env var or 10-level directory walk-up. Import: `from tv_client import TV_CLI, tv_call, TV_NODE_DIR`

**Key capabilities:**
- `chart symbol/timeframe/addIndicator/openDataWindow/read` — chart control
- `pine inject/save/read` — Pine Script v6 authoring (Monaco fiber traversal)
- `trading placeOrder/cancelOrder/modifyOrder/listOpenOrders` — live broker execution
- `brokerData getAccounts/getPositions/getAccountTotals` — portfolio sync
- `sweep readDataWindow` — batch TA reads across all holdings

**Critical rule:** All Node.js CDP snippets must end with `.then(() => process.exit(0)).catch(() => process.exit(1))` — otherwise the WebSocket holds the event loop open indefinitely.

### 3.5. AI Agent Plugin & Substrate Layer
**Location:** `plugins/` (canonical domain plugins), `.agents/` (multi-tool ecosystem skill store), `context/` (control plane & configuration).  
**Ecosystem Upstream Dependency:** [`richfrem/agent-plugins-skills`](https://github.com/richfrem/agent-plugins-skills) — provides the core **Agentic OS substrate** (`agent-agentic-os` plugin: `os-control-init`, `os-control-health`, `os-control-intake`) and shared developer skills.  
**Convention:** Each plugin is an APM package (`apm.yml`, `.apm/skills/<hub>/`, `.apm/agents/`). A hub holds `SKILL.md`, `references/modes/<mode>.md`, `scripts/`, `assets/`, `tests/`, `evals/`. The root `apm.yml` installs the four plugins into `.agents/skills/`.

#### Domain Plugins (Local to InvestmentToolkit)
| Plugin | Key Skills | Key Scripts |
|--------|-----------|-------------|
| `portfolio-advisor` | `/daily`, `/weekly-review`, `/run-advisor`, `/news-sweep`, `/rebalance`, `/update-stock-analysis`, `/stock-research`, `/analyze-etf` | `daily_brief.py`, `update_targets.py`, `validate_projection.py`, `dcf_scenarios.py`, `persist_etf_analysis.py` |
| `tradingview` | `/tv-place-order`, `/tv-ta-daily-sweep`, `/tv-portfolio-sync`, `/tv-pine-inject` | `ta_sweep_batch.py`, `place_order.py`, `tv_launch.py` |
| `toolkit-manager` | `/toolkit-onboarding`, `/start-screener` | `sqlite_admin.py`, `db_backup.py` |
| `questrade` | `/questrade-sync-portfolio`, `/questrade-activities`, `/questrade-order-draft`, `/questrade-deposit-funds`, `/norberts-gambit` | `questrade_sync.py`, `questrade_trades_import.py` |

#### Agentic OS Substrate (`agent-agentic-os` via upstream repo)
- **Control Plane (`context/control_plane.db`)**: SQLite task lifecycle and session state tracking (`scripts/agent_control.py`).
- **Interactive Initialization (`os-control-init`)**: `init_agentic_os.py` bootstraps hooks, evolution guards, and aligns the plugin maintenance policy (`context/plugin-config.json`).
- **Substrate Health Check (`os-control-health`)**: Deterministically audits control plane integrity, symlinks, and backup file hygiene.
- **Phase 0 Intake Gate (`interview-spec`)**: Mandatory Socratic interview and 4-Pillar Specification generation (`TASK_SPEC.md`) before implementation.

---

## 4. Data Stores

**SQLite-first as of the Domain Data Model v3.2 migration (Waves 0-5E, closed by Wave 6,
2026-07-25 — see `docs/superpowers/status/wave6-program-closure-report.md`).** Most domains
(investment/pillar/price-level/projection/trade/portfolio-policy, research/TA-sweep/predictions)
now live in two gitignored, self-creating SQLite files. A small number of JSON files remain as
deliberate, documented retained exceptions — not something to migrate away casually — each with a
completed Retained-JSON Rationale Bar in the Wave 6 report.

| Database | Contents | Repository layer |
|---|---|---|
| `backend/data/domain_model.sqlite` | `account`, `strategy_pillar`, `sub_strategy`, `investment`, `investment_price`, `account_investment`, `price_level_set`, `price_level_tier`, `alert`, `investment_note`, `projection_version`, `projection_scenario`, `trade_log_entry`, `order_execution`, `cash_flow`, `cash_flow_baseline`, `portfolio_policy`, `broker_exchange_rate`, `broker_reported_total` (20 tables) | `py_services/domain_model/*_repository.py`, TS mirrors in `src/services/`/`src/repositories/` |
| `backend/data/intelligence.sqlite` | `instrument`, `ledger_checkpoint`, `intelligence_event` (+ FTS5 virtual table) | `py_services/intelligence/event_repository.py`/`event_store.py` |

Both are gitignored, private data files created automatically the first time a script calling
`initialize_db()` runs — see `docs/architecture/domain-data-model.md` and
`docs/architecture/supplementary-domain-schemas.md` for full DDL and rationale.

**Other files.** Portfolio data is SQLite only (ADR-038). What is still on disk:

| File / Dir | Type | Contents | Gitignored? |
|-----------|------|----------|-------------|
| `backend/data/projections/*.json` | JSON | DCF Bear/Base/Bull, aiThesis action/rationale, analyticsLog (also mirrored into `projection_version`/`projection_scenario`) | No |
| `backend/data/etf_analysis/*.json` | JSON | ETF holdings analysis (versioned array) | No |
| `backend/data/theses/` | Markdown + JSON | Investment thesis narrative + sub-strategies | No |
| `plugins/portfolio-advisor/.apm/skills/running-portfolio-reviews/assets/templates/` | Markdown | Grok sweep prompt templates (daily + weekly) | No |
| `plugins/portfolio-advisor/.apm/skills/running-portfolio-reviews/references/evolution-log.md` | Markdown | Daily session log (scores, overrides, tool failures) | No |
| `temp/` | Various | Scratch space for scripts (never /tmp/) | Yes |

**Retired files** (formerly live JSON, now SQLite-backed; superseded files under
`./ARCHIVE/`): `ta-sweep-results.json`, `predictions.jsonl`,
`account_policy.json`, `tradingview_alerts_actual.json` and `watchlist.json`,
82 per-ticker projection files migrated in Wave 1 (originals retained, see above).

**`aiThesis.action` vocabulary:** `INITIATE | ACCUMULATE | MAINTAIN | TRIM | EXIT | WATCHLIST`  
(DCF valuation signal is separate: `analyticsLog.valuationAction` = `BUY | HOLD | SELL`)

---

## 5. External Integrations & Upstream Dependencies

| Service / Dependency | Purpose | Method |
|----------------------|---------|--------|
| **`richfrem/agent-plugins-skills`** | Upstream Agentic OS substrate (`agent-agentic-os`), developer skills, hooks, and evolution guards | Git repository dependency / plugin syncer (`.agents/`) |
| **yfinance** (Python) | Market data: OHLCV, financials, balance sheet, income statement | Python library — `fetch_financials.py` |
| **TradingView Desktop** | Live chart prices, order execution, broker panel sync (broker: Broker) | Chrome DevTools Protocol (WebSocket port 9222) |
| **X.com / Grok** | News sweep and portfolio analysis | Manual paste workflow — agent generates prompt, user pastes to grok.com |
| **SEC EDGAR** | 13F institutional filing downloads | REST (`/13f-tracker` skill) |

---

## 6. Deployment & Infrastructure

This is a **local-only** personal investment toolkit — no cloud infrastructure.

| Concern | Implementation |
|---------|---------------|
| Runtime environment | macOS (Apple Silicon) |
| Python venv | Created by `run_investment_toolkit.py`, installed from `requirements.txt` |
| Node.js | System install; npm workspaces via `investment_screener/` |
| TradingView CDP | `tradingview-cdp/` node_modules via `npm ci` (one-time) |
| Startup | `python3 run_investment_toolkit.py` — orchestrates venv, npm, backend, frontend, TV Desktop |
| Process model | Backend: `node dist/index.js` (requires rebuild on change). Frontend: Vite HMR. |
| Ports | Frontend: 5173, Backend: 3001, TradingView CDP: 9222 |

---

## 7. Security

| Concern | Implementation |
|---------|---------------|
| Order execution | Human-in-the-loop (HITL) at every trade: preflight card → explicit CONFIRM before CDP submits. |
| API keys / secrets | `.env` at repo root (gitignored). `.env.example` is tracked. |
| Scope | Personal local tool — no network exposure, no auth layer on Express. |

---

## 8. Development & Testing

**Local setup:**
```bash
python3 run_investment_toolkit.py   # first run bootstraps everything
```

**Individual service commands** (from `investment_screener/`):
```bash
npm run dev -w backend      # port 3001 with ts-node-dev hot reload
npm run dev -w frontend     # port 5173 with Vite HMR
npm run build -w backend    # compile TypeScript → dist/
npm run lint -w frontend
```

**Test runner:**
```bash
python3 run_tests.py            # T0 compile gate + T0.5 bridge smoke
python3 run_tests.py --t0-only  # compile + syntax only
pytest investment_screener/backend/tests/    # unit tests
pytest plugins/tradingview/.apm/skills/*/tests/   # TV CDP unit tests (pytest skips dot-directories: pass the path)
```

**Test locations:**
| Area | Path |
|------|------|
| Python py_services | `investment_screener/backend/tests/py_services/` |
| Express routes | `investment_screener/backend/tests/api/` |
| TV CDP | `plugins/tradingview/.apm/skills/*/tests/` (engine tests in `investment_screener/backend/tests/py_services/`) |
| Plugin scripts | `plugins/<plugin>/.apm/skills/*/tests/` |
| React | `investment_screener/frontend/tests/` |

**Code quality:** ESLint (frontend), Pyright (Python), `python3 -m py_compile` in T0 gate.  
**Dependency management:** Python — edit `requirements.in` → `pip-compile requirements.in -o requirements.txt`. Never manual `pip install`.

---

## 9. Key Architectural Decisions

| ADR | Decision |
|-----|---------|
| ADR-024 | CDP engine extracted to `tradingview-cdp/` root ("Thin Skill + Thick Engine") — plugins import via `tv_client.py`, never hardcode paths |
| ADR-026/027/028 | Intelligence data layer: `intelligence.sqlite` (the ledger: single store, FTS5, SQLite selection rationale in ADR-027; ADR-026 first made `observations.jsonl` the authority, now retired) → generated `research/{TICKER}.summary.md` views, behind a shared `py_services/intelligence/` repository layer (ADR-028). See `ADRs/026_canonical_research_consolidation_and_unified_ingest.md`, `ADRs/027_sqlite_database_selection.md`, `ADRs/028_shared_intelligence_data_access_layer.md`. |
| ADR-029/030 | Domain Data Model v3.2: persistence domain rationalization and gated migration from flat JSON to `domain_model.sqlite` (ADR-029, Waves 0-5E, closed by Wave 6 program-closure pass) — "store facts, compute aggregates" (ADR-030, e.g. portfolio totals always computed live from `account_investment`/`investment_price`, never stored). See `ADRs/029_persistence_domain_rationalization_and_retirement_gated_migration.md`, `ADRs/030_portfolio_totals_computed_not_stored.md`, and `docs/superpowers/status/wave6-program-closure-report.md` for the final state and retained-JSON rationale. |
| ADR-dcf-calculator | DCF math lives in `dcf_scenarios.py`, never inlined. One script, one bug surface. |
| Investment sources (ADR-040) | External catalogues (Racional sheet → `stocks_origin`, Dataroma → `recent_buys_q` / `recent_buys_insider`, yfinance enrichment) implement one `InvestmentSource` contract in `py_services/investment_sources/`, synced via `sync_cli.py`, `/api/sources/:code/sync` and the in-process `SourceScheduler`; every run is logged in `source_sync_run`. Screener-only; TradingView appears in the UI only as public widgets. See `ADRs/040-investment-sources.md`. |
| SQLite only (ADR-038) | Portfolio data lives in `domain_model.sqlite`, research in `intelligence.sqlite` (both gitignored, self-creating). No JSON fallback; `test_no_retired_file_access` fails if code or a document reintroduces a retired file. |
| Standing Decision anchor | `investment.standing_decision_*` is the source of truth. A fresh DCF run never silently overrides it — only material delta (>15% FV change) triggers a conflict flag. |
| No symlinks | Plugins are APM packages; each skill hub owns its scripts, references, assets and tests as real files. Shared or backend-imported scripts live in `py_services/`. Path ledger: `docs/plans/apm-migration/`. |

---

## 10. Project Identification

**Project:** InvestmentToolkit  
**Owner:** richfrem  
**Primary AI context files:** `.claude/CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`  
**Last updated:** 2026-07-25 (Wave 6 — Domain Data Model v3.2 program closure)

---

## 11. Glossary

| Term | Definition |
|------|-----------|
| CDP | Chrome DevTools Protocol — WebSocket API used to automate TradingView Desktop |
| DCF | Discounted Cash Flow — valuation model producing Bear/Base/Bull fair value per share |
| `standingDecision` | User-confirmed buy/sell/hold decision stored in the `investment.standing_decision_*` columns. Not overridden by automated DCF runs. |
| `targetEntryPrice` | GTC limit price for accumulating a position; sourced from TA support + DCF margin of safety |
| `aiThesis.action` | Portfolio-level recommendation (`INITIATE/ACCUMULATE/MAINTAIN/TRIM/EXIT/WATCHLIST`) — distinct from the raw DCF signal |
| PSU-U.TO | Purpose US Cash ETF (~$100 USD/share on TSX) — the idle cash parking vehicle. All new purchases are funded by trimming this. |
| HITL | Human-in-the-loop — mandatory confirmation step before any order is submitted to the broker |
| T0 gate | Compile + syntax + path regression checks (`run_tests.py`) — must pass before any commit |
| T0.5 gate | Bridge smoke test — verifies `portfolio_action.py` returns valid JSON via symlink |
| Grok sweep | Portfolio news analysis workflow: agent generates prompt → user pastes to x.com/i/grok → pastes response back → agent gates against DCF + 8 hard gates |
| Sweep template | `daily_sweep.md.template` / `weekly_sweep.md.template` — Grok prompt templates; must be updated when thesis/pillars change |
| py_services | Canonical Python scripts in `investment_screener/backend/py_services/`. All financial calculations go here — never inline. |
