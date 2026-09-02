# TODO — Opportunity Screener Requirements (OpenSpec)

Derived from [`docs/oportunity.md`](./oportunity.md). Each section below is a **proposed OpenSpec
change** to be created under `openspec/changes/<slug>/` following the house structure
(`proposal.md`, `design.md`, `tasks.md`, `verify.md`), matching the precedent set by
`openspec/changes/universe/`.

Nothing here is implemented. This document defines scope boundaries and acceptance criteria so
each change can be proposed, specced, and applied independently.

## Preconditions

- `openspec/config.yaml` declares `strict_tdd: true` → every change below is **test-first**. No implementation without a failing test.
- Test runners available: `pytest`, `npm run test -w backend` (mocha), `npm run test -w frontend` (vitest), `python3 run_tests.py`.
- [Rule #2](../AGENTS.md): no inline financial computation — every formula lands in a versioned `py_services/` script.
- [Rule #4](../AGENTS.md): new dependencies go through `requirements.in` → `pip-compile requirements.in -o requirements.txt`. No manual `pip install`.
- [Rule #21](../AGENTS.md): `domain_model.sqlite` is the sole source of truth. New persistence requires a schema decision, never ad-hoc SQL.
- [Rule #15](../AGENTS.md): worktree-first for every change below.

## Blocking decisions

The six open decisions in [`docs/oportunity.md` §8](./oportunity.md) must be answered before
CHANGE-02 is proposed. CHANGE-00 and CHANGE-01 can proceed without them.

## Dependency graph

```mermaid
flowchart LR
    C0["CHANGE-00<br/>TV field depth spike"] --> C1["CHANGE-01<br/>Fundamentals source layer"]
    C1 --> C2["CHANGE-02<br/>Quality gate"]
    C1 --> C3["CHANGE-03<br/>Valuation rank"]
    C2 --> C4["CHANGE-04<br/>Screen orchestration"]
    C3 --> C4
    C4 --> C5["CHANGE-05<br/>Universe screen UI"]
    C4 --> C6["CHANGE-06<br/>Backtest validation"]
```

---

## CHANGE-00 — `tv-field-depth-spike`

**Type:** Spike / research. Time-boxed. Produces a report, not production code.

### Intent

Factor **F2** states that TradingView's `*_h` historical slice fields (`free_cash_flow_ttm_h`,
`total_revenue_fq_h`, `earnings_fq_h`) have undocumented depth. Criterion A4 (ten-year
consistency) and factor F13 (multi-year cash ROCE) both depend on whether these fields deliver
usable history. **No downstream change should assume an answer.**

### In Scope

- Throwaway probe script under `temp/` ([pitfall #16](../AGENTS.md) — never `/tmp/`) querying `*_h` fields for a sample of 10–15 tickers spanning US, TSX, and one European listing
- Measure: number of periods returned, period spacing (annual vs quarterly), presence of nulls, behavior for recently listed companies
- Confirm whether `return_on_capital_employed_fy` / `return_on_invested_capital_fy` can be requested for prior fiscal years or only the latest
- Document observed rate-limit behavior and response latency

### Out of Scope

- Any persistence, any production code path, any dependency added to `requirements.in`

### Acceptance

- [ ] Written finding recorded in `docs/architecture/` stating, per field, the observed depth and reliability
- [ ] Explicit verdict: **does TradingView satisfy A4, yes or no**
- [ ] If no, the finding names which substitute chain (F12 + F10) becomes mandatory rather than optional

### Review workload forecast

| Field | Value |
|---|---|
| Estimated changed lines | < 150 (throwaway) |
| Chained PRs recommended | No |
| Decision needed before apply | No |

---

## CHANGE-01 — `fundamentals-source-layer`

**Depends on:** CHANGE-00

### Intent

Factors **F1, F2, F3, F5, F6, F21**. Today three fundamentals sources exist with no precedence
rule and no provenance record. `standardize_metrics.py` exists specifically to prevent
"split-brain math"; adding TradingView as a third source without a resolution layer defeats it.

### In Scope

- New `py_services/fundamentals_resolver.py`: single entry point returning a normalized fundamentals record for a ticker
- Declared precedence chain: EDGAR (`edgar_facts.py`) → TradingView → yfinance (`fetch_financials.py`)
- **Per-field provenance**: every returned value carries `{value, source, as_of, is_point_in_time, definition_id}`
- New `py_services/tradingview_fundamentals.py`: thin client over `tradingview-screener`, reusing the `_throttled_get()` + `cache_get`/`cache_set` pattern already proven in `edgar_facts.py`
- Add `tradingview-screener` to `requirements.in`, recompile
- FX normalization policy per **F5**, inferring rates from TradingView native values only ([rule #27](../AGENTS.md) — no external FX APIs)
- Unauthenticated access only. Fundamentals update quarterly; the 900-second delayed feed is sufficient and this avoids the session-cookie question entirely (**F6**)

### Out of Scope

- Any scoring, gating, or ranking logic
- Schema changes to `domain_model.sqlite`
- Replacing existing `fetch_financials.py` callers (additive layer; migration is a later change)

### Acceptance

- [ ] Given a US ticker with a CIK, EDGAR values win and are marked `is_point_in_time: true`
- [ ] Given a TSX ticker, TradingView values are returned and marked `is_point_in_time: false`
- [ ] Given a ticker absent from both, yfinance fallback is returned with correct provenance
- [ ] Every field in the returned record carries non-null `source` and `as_of`
- [ ] Rate limiting verified: N sequential calls do not exceed the documented throttle
- [ ] Cache hit on a second identical call within the TTL window
- [ ] Multi-currency ticker returns both native and normalized values with the inferred rate recorded

### Test requirements (strict TDD)

- `investment_screener/backend/tests/py_services/test_fundamentals_resolver.py` — precedence, provenance, fallback chain, all written before implementation
- Network calls stubbed at the client boundary. **Not** stubbed on the resolution logic itself — [rule #1](../AGENTS.md) forbids mocking on critical runtime paths

### Review workload forecast

| Field | Value |
|---|---|
| Estimated changed lines | 400–550 |
| 400-line budget risk | Medium-high |
| Chained PRs recommended | Yes — split client from resolver if it exceeds budget |
| Decision needed before apply | **Yes** — F1 precedence and raw-inputs-vs-precomputed-ratios must be confirmed |

---

## CHANGE-02 — `quality-gate-engine`

**Depends on:** CHANGE-01. **Blocked by** open decisions F4 and F9.

### Intent

Factors **F4, F9, F10, F11, F12, F13, F16**. Implements Block A and Block B as a **pass/fail gate**,
never a score. Resolves the A4 blocker through the substitute chain rather than waiting for
ten years of data.

### In Scope

- New `py_services/quality_gate.py` returning per-criterion `PASS` / `FAIL` / `NOT_EVALUABLE` with the reason and the evidence used
- **F9** — sector eligibility check runs first. Banks, insurers, REITs and utilities short-circuit to `NOT_APPLICABLE` before any ratio is computed. Reuses or extends `sector_overrides.py`
- **F4** — one canonical ROCE/ROIC definition, chosen by the open decision, encoded once and documented in the module header
- **F12** — surface the existing Piotroski F-Score from `fetch_financials.py` as the primary A4 substitute. **Read the existing implementation; do not reimplement it**
- **F10** — new dispersion metrics (standard deviation of revenue growth, EPS growth, and margins) over the available window, computed from the `hist_*` arrays already produced
- **F13** — cash-based ROCE alongside the accrual figure; flag divergence when conversion is weak
- **F16** — `owner_earnings()` using D&A as the maintenance-capex proxy, with the approximation documented in the docstring. A3 failures re-test against owner earnings before discarding
- **A4 strict path** where EDGAR provides ten years; substitute path elsewhere; the record states which path ran

### Out of Scope

- Valuation criteria (Block C) — CHANGE-03
- Persistence and orchestration — CHANGE-04
- Any UI

### Acceptance

- [ ] A bank ticker returns `NOT_APPLICABLE` without computing ROIC
- [ ] A US ticker with ten years of EDGAR data runs the strict A4 test and records `path: strict`
- [ ] A TSX ticker runs the Piotroski + dispersion substitute and records `path: substitute`
- [ ] A ticker failing A3 on FCF but passing on owner earnings returns `PASS` with the retest noted
- [ ] Missing data returns `NOT_EVALUABLE`, **never** `PASS` (**F18**)
- [ ] The gate returns pass/fail per criterion — no composite score anywhere in the output (**F11**)
- [ ] Piotroski values match those already produced by `fetch_financials.py` for the same ticker

### Test requirements (strict TDD)

- `tests/py_services/test_quality_gate.py` with fixtures covering: excluded sector, strict path, substitute path, owner-earnings retest, missing-data path
- Golden fixtures for at least one real ticker per branch
- Assert explicitly that `NOT_EVALUABLE` never coerces to `PASS`

### Review workload forecast

| Field | Value |
|---|---|
| Estimated changed lines | 600–800 |
| 400-line budget risk | **High** |
| Chained PRs recommended | **Yes** — suggested split: (a) sector exclusion + canonical ROIC, (b) A4 substitute chain (F12 + F10), (c) owner earnings (F16) |
| Decision needed before apply | **Yes** — F4 and F9 |

---

## CHANGE-03 — `valuation-rank-engine`

**Depends on:** CHANGE-01

### Intent

Factors **F7, F8, F11, F14, F15, F18**. Implements Block C as a **percentile ranking**, not a
threshold gate. Greenblatt ranks; he does not threshold. Ranking is robust to the definitional
disagreement F4 cannot fully eliminate.

### In Scope

- New `py_services/valuation_rank.py` producing percentile ranks, not booleans
- **C1** — FCF yield on enterprise value. First verify whether `framework_score.fcfYield` is EV-based or market-cap-based; correct or wrap accordingly (open decision C1)
- **C2** — PEG, using TradingView's `price_earnings_growth_ttm` cross-checked against a locally computed value; divergence beyond a tolerance flags the record
- **C3 via F14** — sector-relative EV/EBIT discount against the cohort median, extending `peer_bench.py`. Cohort pulled from TradingView in a single query
- **C3 via F15** — Acquirer's Multiple: EV / operating earnings constructed **top-down from the income statement**, not from reported EBIT, per Carlisle's standardization rationale
- **F8** — sector- and cycle-adjusted acceptance bands, consuming `market_regime.py` / `macro_regime.py`, following Burry's stated practice of varying the acceptable multiple by industry and cycle position
- **F18** — self-historical C3 is explicitly reported as `NOT_EVALUABLE`; it is never silently approximated

### Out of Scope

- **F17 snapshot accumulation. Deferred** — Alpha Architect's finding is that relative-to-own-history value does not outperform absolute value, so the accumulation cost is not currently justified
- Quality criteria — CHANGE-02

### Acceptance

- [ ] Output is percentile ranks within the evaluated cohort, not pass/fail
- [ ] Sector-relative discount computed against a cohort of at least N peers; below N the result is `NOT_EVALUABLE`
- [ ] Acquirer's Multiple built top-down and documented as differing from reported EBIT
- [ ] Cycle adjustment measurably shifts the band when the regime input changes
- [ ] Self-historical C3 always reports `NOT_EVALUABLE` with the reason recorded
- [ ] PEG divergence between the TradingView value and the local computation raises a flag rather than picking one silently

### Test requirements (strict TDD)

- `tests/py_services/test_valuation_rank.py` — ranking behavior, thin-cohort handling, cycle-band shift, PEG divergence flag
- Regression test asserting the FCF yield denominator is enterprise value

### Review workload forecast

| Field | Value |
|---|---|
| Estimated changed lines | 450–600 |
| 400-line budget risk | Medium-high |
| Chained PRs recommended | Yes — split F14/F15 valuation metrics from F8 cycle banding |
| Decision needed before apply | **Yes** — F7 (rank vs threshold) and the C1 denominator verification |

---

## CHANGE-04 — `universe-screen-orchestration`

**Depends on:** CHANGE-02, CHANGE-03

### Intent

Factors **F11, F18, F19, F21, F22**. Wires the gate and the rank into a single run over the
Candidate Universe, and persists results including rejections. Completes the phase that
`openspec/changes/universe/proposal.md` explicitly deferred: *"AI/automated analysis over the
universe group (future phase — this delivers data foundation only)."*

### In Scope

- New `py_services/screen_universe.py` orchestrating: resolve → sector filter → quality gate → valuation rank → classify
- Three output states matching the source decision tree: `DISCARD`, `WATCHLIST`, `PRIORITY_BUY`, plus `NOT_APPLICABLE`
- Schema decision for persisting screen results in `domain_model.sqlite` ([rule #21](../AGENTS.md)) — per-run results with timestamp, per-criterion outcome, provenance, and path taken
- **F22** — rejection reasons persisted, not discarded. Why a candidate failed is calibration data
- **F19** — declared structural bias emitted with every run: anti-momentum, anti-turnaround, penalizes growth capex
- Express route exposing the latest screen result for the universe

### Out of Scope

- UI rendering — CHANGE-05
- Automatic scheduling. No scheduler exists anywhere in the repository today; introducing one is a separate decision
- Any trade action. [Rule #17](../AGENTS.md) — output is advisory only

### Acceptance

- [ ] A full run over the universe produces one record per candidate with a terminal state
- [ ] Rejected candidates persist with their failing criterion and the evidence used
- [ ] Re-running does not overwrite history; results are append-only per run
- [ ] Non-evaluable criteria never contribute to a `PRIORITY_BUY` classification
- [ ] Every result is traceable to source and vintage per criterion (**F21**)
- [ ] Run output is consumable by `backtest_harness.py`

### Test requirements (strict TDD)

- `tests/py_services/test_screen_universe.py` — end-to-end over a fixture universe covering all four terminal states
- `tests/api/` coverage for the new route
- Idempotency test: two runs against identical inputs produce identical classifications

### Review workload forecast

| Field | Value |
|---|---|
| Estimated changed lines | 500–650 |
| 400-line budget risk | High |
| Chained PRs recommended | **Yes** — split persistence schema from orchestration logic |
| Decision needed before apply | Yes — schema shape |

---

## CHANGE-05 — `universe-screen-ui`

**Depends on:** CHANGE-04

### Intent

Factors **F18, F19, F20, F21**. Surfaces screen results in `UniversePage.tsx`, converting the
Candidate Universe from a passive list into a ranked funnel — the gap identified in
[`docs/modules.md`](./modules.md).

### In Scope

- Per-candidate state badge: `PRIORITY_BUY` / `WATCHLIST` / `DISCARD` / `NOT_APPLICABLE`
- Expandable per-criterion breakdown showing `PASS` / `FAIL` / `NOT_EVALUABLE` with source and vintage per row, following the `PriceSourceBadge.tsx` precedent (**F21**)
- **F18** — non-evaluable criteria render visually distinct from passing ones. Never green
- **F19** — the declared bias is visible in the UI, not buried in documentation
- **F20** — a "send to Advisor" action. The screen is an input to the Portfolio Advisor, never a verdict. Copy must not present the checklist as due diligence
- Sort and filter by state and by valuation rank

### Out of Scope

- Triggering a screen run from the UI (that is a scheduler/trigger decision, deferred)
- Any change to `ScreenerTable.tsx` (60 KB) or `PortfolioTable.tsx` (41 KB) — see CHANGE-07

### Acceptance

- [ ] A candidate with any `NOT_EVALUABLE` criterion cannot display as a fully-passing checklist
- [ ] Every criterion row shows its source and data vintage
- [ ] Structural bias notice is present and not dismissible on first view
- [ ] "Send to Advisor" produces a candidate reference, not a recommendation

### Test requirements (strict TDD)

- `investment_screener/frontend/tests/` — vitest component coverage asserting `NOT_EVALUABLE` never renders with the pass treatment

### Review workload forecast

| Field | Value |
|---|---|
| Estimated changed lines | 350–450 |
| 400-line budget risk | Medium |
| Chained PRs recommended | No |
| Decision needed before apply | No |

---

## CHANGE-06 — `screen-backtest-validation`

**Depends on:** CHANGE-04

### Intent

Factors **F3, F22**. A screen that has never been validated against history is an opinion.
`backtest_harness.py`, `harvest_predictions.py` and `grade_predictions.py` already exist and are
not applied to this.

### In Scope

- Backtest harness integration running the screen over historical universe snapshots
- **F3 enforcement** — the backtest must consume point-in-time data. EDGAR-covered tickers only for the primary run; restated-data runs are labelled as such and reported separately
- Hit-rate reporting by terminal state: how often did `PRIORITY_BUY` outperform, how often did `DISCARD` avoid a loss
- Sensitivity analysis on the thresholds that survived the F7 decision

### Out of Scope

- A track-record UI page (identified as a separate gap in [`docs/modules.md`](./modules.md))

### Acceptance

- [ ] The backtest refuses to run on restated data without an explicit flag, and labels the output when the flag is used
- [ ] Hit rate reported per terminal state and per sector
- [ ] Results persist to `intelligence.sqlite` alongside existing prediction grades
- [ ] Look-ahead bias check documented and testable

### Review workload forecast

| Field | Value |
|---|---|
| Estimated changed lines | 400–500 |
| 400-line budget risk | Medium-high |
| Chained PRs recommended | Possibly |
| Decision needed before apply | No |

---

## CHANGE-07 — `component-split-prerequisite` (enabling work)

**Independent.** Can run in parallel with CHANGE-00 through CHANGE-03.

### Intent

Six frontend components exceed 40 KB: `ValuationModeler.tsx` (60 KB), `ScreenerTable.tsx` (60 KB),
`TradePrepModal.tsx` (48 KB), `PortfolioTable.tsx` (41 KB), `TradeLog.tsx` (38 KB),
`MetricsGrid.tsx` (34 KB). CHANGE-05 and any subsequent screener surface must edit these. Splitting
is a velocity prerequisite, not cosmetic cleanup.

### In Scope

- Split `ScreenerTable.tsx` only, as the component most directly on the opportunity-screener path
- Behavior-preserving refactor. No feature change

### Acceptance

- [ ] Existing frontend tests pass unchanged
- [ ] No single resulting file exceeds 20 KB
- [ ] Zero behavioral diff verifiable by test

### Review workload forecast

| Field | Value |
|---|---|
| Estimated changed lines | Large but mechanical |
| Chained PRs recommended | **Yes** — one component per PR |
| Decision needed before apply | No |

---

## Out of scope for this program

Recorded so they are not silently absorbed.

| Item | Reason |
|---|---|
| **PyIndicators adoption** | Contributes nothing to fundamentals. Real but separate value: local technical indicator computation replacing TV CDP batch sweeps ([pitfall #7](../AGENTS.md)). Propose independently |
| **F17 snapshot accumulation** | Deferred. Alpha Architect's evidence is that relative-to-own-history value does not outperform absolute value |
| **Scheduler / automation** | No scheduler exists in the repository. Introducing one is a standalone architectural decision |
| **Track-record page** | Separate gap from `docs/modules.md`. The data already exists in `intelligence.sqlite` |
| **Orphaned AI endpoints** | `POST /api/theses/:id/strategic-review` and `/optimize` are implemented, call Gemini, and have zero frontend call sites. Cheapest available win, unrelated to this program |

---

## Sequencing recommendation

1. **CHANGE-00** — spike first. Every downstream scope depends on its answer.
2. **Answer the six open decisions** in [`docs/oportunity.md` §8](./oportunity.md).
3. **CHANGE-01** — foundation.
4. **CHANGE-02** and **CHANGE-03** in parallel; both depend only on CHANGE-01.
5. **CHANGE-04** — integration.
6. **CHANGE-05** and **CHANGE-06** in parallel.
7. **CHANGE-07** as needed, before CHANGE-05 if `ScreenerTable.tsx` blocks it.
