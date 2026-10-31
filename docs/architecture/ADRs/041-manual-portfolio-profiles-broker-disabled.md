# ADR-041: Manual portfolio profiles; broker integration disabled by default

**Status:** Accepted
**Date:** 2026-10-31

## Context

The owner decided the platform is a screener and recommendation tool only: "deshabilitemos el
broker, solo queremos que sea una herramienta de screener y de recomendaciones de inversion".
Holdings were synced from the broker panel through TradingView CDP, which needs a logged-in
session and a broker account. A manual portfolio maintainer already existed on `dev`
(`openspec/specs/portfolio-maintainer/spec.md`).

## Decision

1. **Portfolio profiles = `account` rows.** Profiles have a free name, an optional type
   (`PROFILE` is the default) and a base currency (USD by default). Each profile has a wallet,
   which is its `CASH_<CCY>` `account_investment` row. Positions change only through maintainer
   transactions. A buy recomputes the weighted-average cost. A sell lowers the quantity and leaves
   the average cost unchanged. Wallet deposits and withdrawals are transactions too. Every
   transaction writes one `trade_log_entry`. Oversell, overspend and overdraw are rejected and
   leave no trace. A profile can be deleted only when it is empty: deleting one that still holds
   cash needs `?force=true`.
   API: `/api/portfolio-maintainer/*`. UI: the "Portafolio" page. No schema change.
2. **Broker kill switch.** `BROKER_INTEGRATION` is off unless it is set to `on`. While off:
   - `/api/trading/*` (except the stored-data reads `GET /log` and `GET /audit/today`) and the
     broker sync routes (`/api/portfolio/sync-tv*`, `/api/portfolio/sync`) answer 410
     `BROKER_DISABLED`;
   - the UI hides the trade and sync controls (`useFeatureFlags`, fed by
     `GET /api/portfolio/features`);
   - `tv_price_refresh.py` skips the broker-backed USD→CAD refresh.

   The broker code stays in the repository, disabled rather than deleted.
3. **Prices.** `tv_price_refresh.py` is still the only price writer (rule 25). It prices held
   tickers from every profile, plus the watchlist, using TradingView quotes, which also work
   without a login.

## Consequences

- AGENTS.md rules 10, 14, 17 and 25 now describe the manual, screener-only model.
- Broker-only CLI scripts (`fetch_broker_data.py`, `place_order.py`, `refresh_all.py`, …) remain
  for the day the owner opts back in. No HTTP route reaches them while the switch is off.
- The USD→CAD rate is no longer refreshed from the broker. Totals that need CAD use the last
  stored rate.
