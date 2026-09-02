# Application Modules

User-facing modules exposed by the React dashboard (`investment_screener/frontend`), as registered in `src/App.tsx` and `src/components/Sidebar.tsx`.

## Type Legend

| Type | Meaning |
|------|---------|
| **Automatic** | Runs on load with no user action; data appears by itself. |
| **Triggered** | Requires an event (button, upload, external script run) to produce or refresh data. |
| **AI** | Interacts with an agent or LLM (Gemini, Grok, plugin skills). |
| **Manual** | The user must act directly — enter data, decide, or execute outside the app. |

Most modules are hybrids. The dominant type is listed first.

---

## 1. Heatmap

- **Route:** `/` (default landing page)
- **Component:** `pages/Heatmap.tsx` → `components/PortfolioHeatmap.tsx`
- **Objective:** High-level visual representation of portfolio concentration and performance. Answers "where am I heavy and what is moving" at a glance.
- **Type:** Automatic + Triggered
  - Automatic: loads `/api/portfolio-heatmap`, `/api/screener/all-holdings`, `/api/theses/pillars` on mount.
  - Triggered: `refreshPrices()` and `syncAndRefreshPortfolio()` buttons re-pull from broker/market data.
- **Benefits:**
  - Instant read on concentration risk without scanning a table.
  - Pillar grouping makes strategy drift visible, not just ticker-level noise.
  - Single click refresh from TradingView CDP without leaving the page.
- **Improvements:**
  - Add a staleness indicator per tile (price age + source). Pitfall #7 means a "TV Live" badge does not guarantee the price came from TV.
  - Automate the refresh: a lightweight poll or WebSocket during market hours removes the manual click.
  - Add a "delta vs yesterday" toggle so the heatmap shows change, not just current state.
  - Persist the last refresh timestamp so a stale page is obvious after leaving the browser open overnight.

---

## 2. Portfolio Summary

- **Route:** `/portfolio-summary`
- **Component:** `pages/PortfolioSummaryPage.tsx`
- **Objective:** Executive overview of portfolio performance — YTD return, 1D/1W/1M period changes, strategy allocation.
- **Type:** Automatic + Triggered
  - Automatic: `fetchPortfolioSummary`, `fetchPortfolioPerformance`, `fetchStrategyAllocation`.
  - Triggered: `syncAndRefreshPortfolio()`.
- **Benefits:**
  - One screen answers "how am I doing" across multiple horizons.
  - Strategy allocation exposes target-vs-actual drift before it compounds.
  - Enforces the cash invariant (rule #18), so totals are not distorted by uninvested cash.
- **Improvements:**
  - Add a benchmark comparison (SPY/QQQ/custom). Absolute return without a benchmark cannot distinguish skill from beta.
  - Show return net of costs — FX, commissions, slippage — not only gross.
  - Add risk-adjusted metrics (max drawdown, volatility, Sharpe) alongside raw return.
  - Automate a daily snapshot so period-over-period comparisons survive a missed sync.

---

## 3. Portfolio Table

- **Route:** `/portfolio-table`
- **Component:** `pages/PortfolioTablePage.tsx` → `components/PortfolioTable.tsx` (41 KB)
- **Objective:** Granular position-by-position view — shares, cost basis, market value, current weight vs target.
- **Type:** Automatic + Triggered (`syncAndRefreshPortfolio()`)
- **Benefits:**
  - Ground truth of what is actually held, sourced from `domain_model.sqlite`.
  - Direct current-weight vs target-weight comparison surfaces rebalancing needs.
  - Per-account breakdown (TFSA/RRSP) matters for the capital-sourcing rule (PSU-U.TO must be sold in the same account).
- **Improvements:**
  - Add an inline "distance to target" column with a rebalance-priority sort.
  - Surface unrealized gain/loss with tax lot detail per account.
  - Split the 41 KB component — it is a maintenance bottleneck for any new column.
  - Add a per-position risk contribution column (volatility-weighted), not just capital weight.

---

## 4. Portfolio Advisor

- **Route:** `/screener`
- **Component:** `pages/ScreenerPage.tsx` → `components/ScreenerTable.tsx` (60 KB) + `DeepDiveModal.tsx`
- **Objective:** Primary decision surface. Deep-dive agent analyses plus investment thesis management. Where buy/sell decisions get made.
- **Type:** AI + Triggered
  - Reads agent-produced research from `/api/research/`, `/api/docs/latest-review-data`, `/api/theses/target-portfolio/health`.
  - Research itself is produced out-of-band by agent skills (`/daily`, `/weekly-review`, `/run-advisor`), not by the page.
- **Benefits:**
  - Consolidates DCF signal, thesis health, current weight, and agent research per ticker in one row.
  - Deep-dive modal keeps the reasoning trail attached to the position.
  - Thesis-health endpoint flags misalignment before it becomes a bad trade.
- **Improvements:**
  - The page consumes research but cannot request it. Add a "run analysis" trigger that invokes the agent pipeline directly instead of requiring a terminal.
  - Add a local LLM path (llama.cpp / Ollama) for deep dives. Portfolio holdings and thesis rationale are sensitive; a local 7B–14B model handles summarization and thesis-breaker checks without sending positions to a public cloud API. Keep Gemini/Grok for tasks that genuinely need frontier reasoning or live news.
  - Show research age per ticker — a stale deep dive presented as current is worse than no deep dive.
  - Split the 60 KB component before adding features.

---

## 5. Stock Analysis

- **Route:** `/analysis`
- **Component:** `pages/Dashboard.tsx` → `MetricsGrid.tsx` (34 KB), `ValuationModeler.tsx` (60 KB), `AIAnalysisModal.tsx` (28 KB)
- **Objective:** Analytics hub for a selected ticker — metrics, charts, and the valuation modeler (DCF, scenarios, sensitivity).
- **Type:** Manual + AI + Triggered
  - Manual: user selects the ticker and adjusts DCF assumptions.
  - Triggered: valuation math runs in `py_services` (`dcf_scenarios.py`, `reverse_dcf.py`, `wacc.py`) on demand.
  - AI: `runAIAnalysis()` exists in `services/api.ts` and routes to `GeminiService`.
- **Benefits:**
  - Valuation assumptions are explicit and editable, not a black box.
  - Scenario and sensitivity analysis show how fragile a fair value is to inputs.
  - Financial math lives in versioned Python scripts (rule #2), so results are reproducible.
- **Improvements:**
  - **`runAIAnalysis()` is defined but never called from any page or component** (`grep` returns zero call sites). Either wire it up or remove it — dead surface area is worse than no surface area.
  - Add reverse-DCF as a default view: "what growth is the market pricing in" is often more actionable than a point fair value.
  - Cache computed DCF runs by ticker + assumption hash to avoid recomputing identical scenarios.
  - Local model option for the narrative layer (thesis summary, risk enumeration) — the numbers already come from Python, so the LLM is only writing prose and does not need frontier capability.

---

## 6. Daily Brief

- **Route:** `/daily-brief`
- **Component:** `pages/DailyBriefPage.tsx` (28 KB)
- **Objective:** Daily portfolio brief — macro regime, conviction-scored holdings (ACCUMULATE / HOLD / WATCH / REDUCE / EXIT), earnings binary-event flags, pillar health, score delta vs yesterday.
- **Type:** Triggered + AI
  - Reads `/api/daily-brief/latest` — displays whatever the last run produced.
  - Generation happens via the `/daily` agent skill (`daily_brief.py`, `compute_conviction_scores.py`, `macro_regime.py`), executed manually.
- **Benefits:**
  - Ranked, opinionated starting point each morning instead of a blank dashboard.
  - Score delta vs yesterday highlights what changed, which is the actionable part.
  - Earnings binary-event flags prevent walking into a print unaware.
- **Improvements:**
  - **This is the strongest automation candidate in the app.** There is no scheduler anywhere in the repo (no `node-cron`, `setInterval`, or crontab in backend, `py_services`, or `run_investment_toolkit.py`). A pre-market scheduled run would deliver the brief without the user remembering to invoke `/daily`.
  - Show brief age prominently — a three-day-old brief rendered as "Daily" is actively misleading.
  - Add a diff view: which holdings changed conviction bucket and why.
  - Deterministic parts (conviction scores, pillar health, earnings flags) are already pure Python — only the narrative needs an LLM, and a local model covers that.

---

## 7. Trade Log

- **Route:** `/trade-log`
- **Component:** `pages/TradeLog.tsx` (38 KB) → `TradePrepModal.tsx` (48 KB)
- **Objective:** Order lifecycle by state (planned / working / filled / cancelled / inactive), with sync from TradingView.
- **Type:** Manual + Triggered
  - Triggered: `syncTradeLogFromTV()`, `runTradePreflight()`, `runTradeExecute()`, `runTradeSubmit()`.
  - Manual by design: rule #17 forbids autonomous order placement. Execution is 100% human-in-the-loop in the broker UI.
- **Benefits:**
  - Full audit trail from intent to fill, which is the raw material for measuring decision quality.
  - Preflight gates (`order_risk_gates.py`) catch sizing and account errors before submission.
  - TV sync reconciles the app against actual broker state instead of trusting local records.
- **Improvements:**
  - Record slippage: reference price at signal time vs actual fill. `execution_quality_scorecard.py` already exists but is not exposed in the UI.
  - Capture commissions and FX rate per trade so net alpha is measurable.
  - Warn on GTC orders (pitfall #22 — CDP submits as Day orders, requiring a manual change in TradingView).
  - Add time-to-execution tracking: the gap between signal and fill is a silent source of lost return.

---

## 8. Investment Theses

- **Route:** `/theses`
- **Component:** `pages/ThesesPage.tsx` → `ThesisViewModal.tsx`, `InvestmentThesisModal.tsx`
- **Objective:** Sub-strategies and pillars that define portfolio direction — the "why" behind each position.
- **Type:** Manual (read-only viewer today)
  - Single `GET /api/theses/sub-strategies`. No writes, no analysis triggers, no AI calls from the page.
  - Mutations happen exclusively via CLI: `update_thesis.py --holding INTC --target 8.0`.
- **Benefits:**
  - Every position carries an explicit, versioned rationale, which counters drift and hindsight bias.
  - Validation enforced at write time (weights must sum to 100%, versioned changeLog).
  - Pillar grouping ties individual holdings to a coherent strategy.
- **Improvements:**
  - **`POST /:id/strategic-review` and `POST /:id/optimize` already exist in `routes/theses.ts`, already call `GeminiService` via `ThesisService`, and are called from nowhere in the frontend** (`grep -rn "strategic-review\|optimize" frontend/src` → zero results). Wiring two buttons is the cheapest high-value improvement in the entire app: it replaces the manual Grok round-trip with in-app strategic review and rebalance proposals.
  - Current thesis workflow is a manual loop: `generate_grok_prompt.py` → paste into Grok → read reply → `update_thesis.py`. Closing that loop in-app removes three context switches per revision.
  - Add thesis-breaker status inline (`thesis_breakers.py` exists) so an invalidated thesis is visible in the list, not buried in a sweep.
  - Add an edit surface for target weights so `update_thesis.py` is not the only mutation path.
  - Local-model candidate: strategic review reads the entire thesis plus positions. That is exactly the payload one would prefer not to send to a public API. llama.cpp with a long-context model handles it locally.

---

## 9. 13F — SA LP

- **Route:** `/13f`
- **Component:** `pages/ThirteenFPage.tsx` (25 KB)
- **Objective:** Track a reference fund's 13F holdings with quarter-over-quarter diffs. Idea generation by observing institutional positioning.
- **Type:** Automatic + Triggered (`/api/13f/summary` on mount)
- **Benefits:**
  - Surfaces new positions and exits from a manager whose process is respected.
  - Diff view isolates what changed instead of restating the whole portfolio.
  - Feeds the candidate universe with pre-filtered names.
- **Improvements:**
  - 13F data is lagged 45 days. Show filing date and lag explicitly so it is never treated as current positioning.
  - Add multi-fund tracking with overlap analysis — conviction rises when several respected managers converge.
  - Automate quarterly fetches from EDGAR (`edgar_facts.py` already exists) instead of manual refresh.
  - Add a one-click "promote to Candidate Universe" action to close the idea-generation loop.

---

## 10. Candidate Universe

- **Route:** `/universe`
- **Component:** `pages/UniversePage.tsx`
- **Objective:** Curated watchlist manager. CSV upload (`ticker,name,source`) feeding the candidate funnel before a thesis exists.
- **Type:** Manual (`uploadUniverseCsv()`, `deleteUniverseTicker()`)
- **Benefits:**
  - Separates "interesting" from "owned", preventing premature position-taking.
  - `source` field preserves provenance of each idea.
  - CSV ingest allows bulk import from external screens.
- **Improvements:**
  - Add automated screening: run cheap quantitative filters (valuation, momentum, quality) over the universe so candidates are ranked, not just listed.
  - Add price alerts against `targetEntryPrice` (pitfall #19) so a candidate reaching its entry level surfaces automatically instead of requiring a manual check.
  - Auto-promote from 13F and agent research rather than requiring CSV round-trips.
  - Track why a candidate was rejected — rejection reasoning is as valuable as the thesis for calibration.

---

## 11. Settings

- **Route:** `/settings`
- **Component:** `pages/Settings.tsx`
- **Objective:** Portfolio/account configuration and TradingView CDP link status (live/offline via `/api/tv-status`).
- **Type:** Manual + Automatic (status polls on load)
- **Benefits:**
  - Single place to confirm the CDP bridge is alive before relying on TV-sourced data.
  - Account configuration is centralized rather than scattered across scripts.
- **Improvements:**
  - Expand into a full health dashboard. Pieces already exist (`system_health.py`, `tv_cdp_health.py`, `verify_portfolio_total.py`, `audit_staleness.py`) but there is no single traffic light for: CDP alive, price freshness, cash invariant, target drift.
  - Surface the last successful sync per data source, not just live/offline.
  - Add a local-model configuration section if llama.cpp/Ollama is adopted — endpoint, model, and a per-task routing toggle (local vs cloud).

---

## Cross-Cutting Observations

### Missing module: Track Record / Calibration

There is no page showing whether past theses were correct. The data already exists in `intelligence.sqlite`, produced by `harvest_predictions.py`, `grade_predictions.py`, and `generate_track_record_report.py`. Without it, the user cannot know how much to weight the system's signals. This is the highest-value addition to the app.

### No automation layer

`grep -rlE "node-cron|setInterval|schedule\(|crontab"` across `backend/src`, `py_services`, and `run_investment_toolkit.py` returns nothing. Every refresh, brief, and sweep is manually invoked. A scheduler for pre-market brief generation, price refresh during market hours, and quarterly 13F fetches would convert several Triggered modules into Automatic ones without violating rule #17 (which restricts autonomous *order execution*, not data refresh).

### Orphaned AI capability

Three AI-backed surfaces are built and unreachable from the UI:

| Endpoint / function | Backend status | Frontend call sites |
|---|---|---|
| `POST /api/theses/:id/strategic-review` | Implemented, calls Gemini | 0 |
| `POST /api/theses/:id/optimize` | Implemented, calls Gemini | 0 |
| `runAIAnalysis()` | Implemented in `services/api.ts` | 0 |

Wiring these is low-effort, high-impact work already paid for.

### Local model opportunity (llama.cpp / Ollama)

Current AI dependencies are Gemini (backend) and Grok via manual copy-paste. Both send portfolio composition, position sizes, and thesis reasoning to third-party clouds. A local inference layer is a good fit for:

- Thesis summarization and strategic review (long context, no frontier reasoning required)
- Daily brief narrative generation (scores are already computed deterministically in Python)
- Thesis-breaker evaluation against news text
- Research document summarization

Cloud models remain justified for live news sweeps (Grok's X access) and genuinely hard reasoning. A per-task routing toggle in Settings would let the user choose the boundary explicitly.

### Component size as a feature blocker

Six components exceed 40 KB: `ValuationModeler.tsx` (60 KB), `ScreenerTable.tsx` (60 KB), `TradePrepModal.tsx` (48 KB), `PortfolioTable.tsx` (41 KB), `TradeLog.tsx` (38 KB), `MetricsGrid.tsx` (34 KB). Most improvements listed above require editing them. Splitting is a prerequisite for velocity, not cosmetic cleanup.
