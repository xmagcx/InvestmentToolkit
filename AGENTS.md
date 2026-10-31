# AGENTS.md

## Overview
Investment **screener and recommendation** suite built around **TradingView CDP automation** (port 9222, works without a TradingView login) for live prices, chart telemetry and TA sweeps, backed by a React 19 dashboard (port 5173) and Node.js/Express backend (port 3001). Holdings are kept by hand in portfolio profiles (Portafolio page, `/api/portfolio-maintainer`). **Broker integration is disabled by default** (`BROKER_INTEGRATION=off`, ADR-041): no broker sync, no order flow. yfinance serves strictly as a background fundamentals data bridge and offline fallback.

**Startup**: `python3 run_investment_toolkit.py` — creates venv, installs deps, launches frontend + backend + TradingView Desktop (CDP port 9222).

## Architecture
Complete repository structure, data flows, and subsystem architecture live in [`architecture.md`](architecture.md). ADRs and deep-dive specs live in [`docs/architecture/`](docs/architecture/).

**npm commands** — run from `investment_screener/` (workspace root): `npm run dev -w backend | frontend`, `npm run build -w backend | frontend`, `npm run lint -w frontend`. (Never use `--prefix investment_screener` from inside `investment_screener/`).

## On-Demand Skills (Enable / Disable)
The four project plugins (`plugins/*`) install with `apm install --target agent-skills` (root `apm.yml`, `apm.lock.yaml`); never edit the deployed copies. Library plugin skills, agents, rules and hooks are on demand. Look for them in `.agents/` first (`.agents/skills/<name>/SKILL.md`, `.agents/agents/`); read `SKILL.md` directly and don't copy assets into `.claude/`. Desired state lives in `.agents/ownership/<plugin>.json` (one JSON line per component with a `should_install` flag).

When the user asks to enable or disable a skill or plugin:
1. Read `.agents/ownership/<plugin>.json`, find the matching component(s); if several match or none, confirm first.
2. Set `should_install` to `true`/`false` for only those entries, keeping the one-line-per-component format.
3. Read `.agents/skills/plugin-syncer/SKILL.md` and run `python3 .agents/skills/plugin-syncer/scripts/sync_with_inventory.py` (`--dry-run` first for large changes). Never `plugin_add.py`: it resets every component to `true`.
4. Report what was enabled/disabled and what the sync changed.

Disabling removes files, so only the user's explicit request naming the skill or plugin authorizes it ("clean up skills" does not). Never toggle skills on your own initiative; suggest it and let the user decide.

## Task Planning & Discovery (Plan Mode)
For complex tasks, multi-file refactors, or feature requests:
- **Think Before Coding**: Run discovery in read-only Plan Mode first. Explicitly state assumptions, propose the minimal viable design, and list verification criteria.
- **Human Approval**: Obtain explicit user authorization before creating worktrees or modifying code.
- **Optional Control Plane**: If the optional `os-control-intake` skill is installed (`.agents/skills/os-control-intake/SKILL.md`), use `python3 scripts/agent_control.py init` to register structured tasks in `context/control_plane.db`. Otherwise, keep planning lean and direct.

## Behavioral Guidelines (Karpathy Principles)
These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them — don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First
- Minimum code that solves the problem. Nothing speculative.
- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- If you write 200 lines and it could be 50, rewrite it.

### 3. Surgical Changes
- Touch only what you must. Clean up only your own mess.
- Don't refactor things that aren't broken. Match existing style.
- When your changes create orphans, remove imports/variables/functions that your changes made unused.

### 4. Goal-Driven Execution
- Define success criteria. Loop until verified.
- For multi-step tasks, state a brief plan:
  1. [Step] → verify: [check]
  2. [Step] → verify: [check]

---

## Day-1 Agent Bootstrap & Core Commands
The full, ordered setup and core command reference (`/toolkit-onboarding`, `/daily`, `/weekly-review`, `/strategic-review`, `/tv-portfolio-sync`) live in [`INIT_AGENTS.md`](INIT_AGENTS.md). Follow it in order on any fresh clone; this file (`AGENTS.md`) holds behavioral rules and invariants.

## TradingView Skills & CDP Engine
- **Use the skills for TradingView work.** The TradingView skills (`operating-tradingview-charts`, `trading-via-tradingview` and `analyzing-charts` under `.agents/skills/`; slash commands such as `/tv-portfolio-sync`, `/place-order`, `/tv-ta-daily-sweep`, `/tv-pine-inject`, `/tv-get-orders` and `/tv-alert-sync` are unchanged and name a mode) hold the documented workflow, constraints and verification steps. Read the skill's `SKILL.md`, then the mode file for the command, and follow it; don't improvise a script run from memory.
- **All TradingView access goes through the CDP engine in `tradingview-cdp/`** (`node tradingview-cdp/cli.js status|quote|chart|pine|alert|watchlist|sweep`, or `tv_client.py` from Python). Check connectivity first with `node tradingview-cdp/cli.js status`; port 9222 must be reachable.
- **Broker reads (only with `BROKER_INTEGRATION=on`)** — per-account reads: `--positions` and `--accounts` reflect only the account currently selected in the broker panel. For all accounts, use `getPortfolio()` from `tradingview-cdp/core/broker_data.js` (via `tv_client.run_node_module`), which switches through each account and returns one snapshot per account. Compare against the stored per-account holdings (`account_investment` joined to `account`) before any commit. A `--positions` read that matches one account's share counts (about a third of the stored total for RRSP) is not a full sync.
- **Account switching**: `switchAccount` checks whether the dropdown is open before toggling it and retries on a miss (`switchWithRetry`). If a sync still reports "Account not found in dropdown", that account was not read and its stored rows are unchanged; re-run rather than asking the owner to click. The CASH account has no positions but holds real cash, so its balance must still be read; `--allow-partial` skips it and leaves the stored balance stale.
- **Commits need approval**: a `--snapshot` or trade import writes to `domain_model.sqlite`. Show the per-account diff and get the owner's go-ahead first.

## Non-Negotiable Rules
Detailed policy documents and invariants are governed in [`.agent/rules/`](file:///.agent/rules/). Key invariants:

1. **Test-Driven Work**: MUST have a failing test before writing production code. (details: [`.agent/rules/test-driven-development.md`](file:///.agent/rules/test-driven-development.md))
2. **No Inline Python**: MUST extract all calculations to versioned scripts in `py_services/`. (details: [`.agent/rules/local-data-pipeline.md`](file:///.agent/rules/local-data-pipeline.md))
3. **Coding Conventions**: MUST follow naming standards and file headers. (details: [`.agent/rules/coding-conventions.md`](file:///.agent/rules/coding-conventions.md))
4. **Dependency Management**: MUST use `pip-compile`; manual `pip install` is PROHIBITED. (details: [`.agent/rules/dependency-management.md`](file:///.agent/rules/dependency-management.md))
5. **Plugin Architecture**: plugins are APM packages (`plugins/<plugin>/.apm/skills/<hub>/` with its own scripts, references, assets, tests); symlinks are PROHIBITED; backend-imported or multi-hub scripts live in `py_services/`. (details: [`.agent/rules/plugin-architecture-policy.md`](file:///.agent/rules/plugin-architecture-policy.md))
6. **Evolution Log**: MUST record each fixed friction or failure in the hub's `references/evolution-log.md` under `plugins/<plugin>/.apm/skills/` (the commit hook enforces it for logic files).
7. **Destructive Action Guards**: File and skill deletions are strictly PROHIBITED without explicit user approval. (details: [`.agent/rules/destructive-action-guard.md`](file:///.agent/rules/destructive-action-guard.md))
8. **Self-Healing**: MUST fix broken snippets inline and re-run silently; NEVER leave broken output visible.
9. **Standing Decision is Anchor**: NEVER override standing decisions without material delta (>15% FV variance). (details: [`.agent/rules/local-standing-decision-policy.md`](file:///.agent/rules/local-standing-decision-policy.md))
10. **Post-Trade Update**: MUST update `lifecycle_status` and `agent_rationale` after ANY trade. Holdings change ONLY through portfolio-maintainer transactions (buy/sell/deposit/withdraw, each logged in `trade_log_entry`); raw SQL edits of share counts are PROHIBITED. (details: [`.agent/rules/local-data-pipeline.md`](file:///.agent/rules/local-data-pipeline.md))
11. **Ticker vs Symbol**: MUST use `symbol` for SQL/Python and `ticker` for API JSON payloads; NEVER conflate. (details: [`.agent/rules/local-data-pipeline.md`](file:///.agent/rules/local-data-pipeline.md))
12. **Worktree-First Mandatory**: MUST create an isolated git worktree before any multi-file change. (details: [`.agent/rules/git-operations.md`](file:///.agent/rules/git-operations.md))
13. **Worktree Hygiene**: PR merge triggers cleanup: MUST sync main, verify ancestry, and remove worktrees. (details: [`.agent/rules/worktree-lifecycle-management.md`](file:///.agent/rules/worktree-lifecycle-management.md))
14. **No Trade Execution**: The platform is screener-only; broker order placement is disabled (`BROKER_INTEGRATION=off`) and MUST NOT be re-enabled or performed by an agent. (details: [`.agent/rules/local-trade-execution-policy.md`](file:///.agent/rules/local-trade-execution-policy.md))
15. **Mandatory Cash Invariant**: Portfolio total USD MUST strictly include held equities market value plus account cash. (details: [`.agent/rules/local-architecture-invariants.md`](file:///.agent/rules/local-architecture-invariants.md))
16. **Adversarial Reasoning**: MUST challenge thesis premises and correlate news catalysts with price action. (details: [`.agent/rules/adversarial-reasoning-before-agreement-rule.md`](file:///.agent/rules/adversarial-reasoning-before-agreement-rule.md))
17. **TradingView Baseline**: TradingView CDP (anonymous mode supported) is the universal market-data baseline; broker reads are disabled unless the owner sets `BROKER_INTEGRATION=on`. (details: [`.agent/rules/local-broker-augment-policy.md`](file:///.agent/rules/local-broker-augment-policy.md))
18. **Domain Database Primary**: `domain_model.sqlite` is the sole source of truth; raw SQL updates PROHIBITED during sync. (details: [`.agent/rules/local-data-pipeline.md`](file:///.agent/rules/local-data-pipeline.md))
19. **One Implementation Per Concept**: MUST consolidate duplicate calculations into canonical shared modules. (details: [`.agent/rules/local-architecture-invariants.md`](file:///.agent/rules/local-architecture-invariants.md))
20. **One Table System**: ALL ticker views MUST render through shared `PositionsTable` from SQLite. (details: [`.agent/rules/local-architecture-invariants.md`](file:///.agent/rules/local-architecture-invariants.md))
21. **Thesis Page Currency**: MUST record news sweeps in `intelligence.sqlite`; NEVER hardcode dated prices in prose. (details: [`.agent/rules/local-architecture-invariants.md`](file:///.agent/rules/local-architecture-invariants.md))
22. **Installed Rules vs Local Rules**: Project-specific overrides MUST strictly live in `.agent/rules/local-*.md`. (details: [`.agent/rules/local-worktree-and-dual-repo-edit-protocol.md`](file:///.agent/rules/local-worktree-and-dual-repo-edit-protocol.md))
23. **Recommendation Coherence**: Calls MUST come from `recommendation.py --all` and reflect analysis saved this cycle; every daily loop, weekly review or analysis session MUST start with `review_gate.py begin` and NEVER end while `review_gate.py verify` exits 1. (details: [`.agent/rules/local-recommendation-coherence.md`](file:///.agent/rules/local-recommendation-coherence.md))
24. **Daily Order Before Advice**: On a new trading day, MUST run the daily loop's readiness, brief and news sweep before giving any buy or sell price, and MUST record every price or plan given before presenting it. (details: [`.agent/rules/local-recommendation-coherence.md`](file:///.agent/rules/local-recommendation-coherence.md))
25. **One Price Refresh**: Exactly ONE function refreshes `investment_price`: `investment_screener/backend/py_services/tv_price_refresh.py`. The web app's Refresh button, `/refresh-prices`, `/daily` and the weekly review MUST all call it; a second price writer is PROHIBITED. It prices every held ticker (all portfolio profiles) plus the watchlist from TradingView quotes (broker position validation and the broker-backed FX refresh run only with `BROKER_INTEGRATION=on`), and MUST report every unpriced or stale ticker by name; a partial refresh is NEVER reported as success. (details: [`.agent/rules/local-architecture-invariants.md`](file:///.agent/rules/local-architecture-invariants.md))
26. **One Copy Per TradingView List**: There are exactly two lists, `TV-Full Watchlist` and `TV-Portfolio`, ONE copy each. Sync MUST update the existing list in place; creating a list whose name already exists is PROHIBITED, and if TradingView holds more than one copy of a name, stop and report it. (details: [`.agent/rules/local-architecture-invariants.md`](file:///.agent/rules/local-architecture-invariants.md))
27. **Ticker Aliases**: `PSU.U`, `PSU.U.TO`, `PSU-U` and `PSU-U.TO` are the SAME fund. MUST normalize every symbol through `ticker_aliases.normalize_ticker` only (never a local alias map) and compare lists, positions and prices in that canonical form. (details: [`.agent/rules/local-architecture-invariants.md`](file:///.agent/rules/local-architecture-invariants.md))

## Canonical Scripts
| Script | Purpose |
|--------|---------|
| `py_services/fetch_financials.py {TICKER}` | Raw yfinance data |
| `py_services/dcf_scenarios.py --raw FILE --scenarios FILE` | DCF scenario math |
| `py_services/validate_projection.py` | Schema validation |
| `investment_screener/backend/py_services/price_changes.py` (`period_changes`) | The only 1D/1W/1M/3M/YTD/1Y/5Y % change calculation (heatmap, tables, Stock Analysis) |

Create a new canonical script + ADR in `docs/architecture/` whenever you'd compute the same formula twice (see rule 19).

## Test Locations
Python: `investment_screener/backend/tests/py_services/`; Express: `investment_screener/backend/tests/api/`; TV CDP: `investment_screener/backend/tests/py_services/tv_test_harness.py`; plugin scripts: `plugins/<plugin>/.apm/skills/<hub>/tests/` (pass the path to pytest explicitly; it skips dot-directories); React: `investment_screener/frontend/tests/`.

**Frontend type check:** run `npx tsc -b` in `investment_screener/frontend` (what `npm run build` runs). `tsc -p .` checks nothing: the root `tsconfig.json` has `"files": []` and only references `tsconfig.app.json` / `tsconfig.node.json`. Under `verbatimModuleSyntax`, import types with `import type`.

## SUB-agent usage
Use the cheapest models possible where possible. If the job doesn't require spawning sub-agents don't do so.

## Known Pitfalls
All 30 cataloged integration traps, TradingView CDP subtleties, and database edge cases are permanently documented in [`docs/architecture/known-pitfalls.md`](docs/architecture/known-pitfalls.md). Always consult this reference before writing TradingView automation scripts, SQLite queries, or price calculation logic.


