# ADR-040: Pluggable investment sources (Racional sheet, Dataroma, yfinance enrichment)

**Status:** Accepted
**Date:** 2026-10-31

## Context

The toolkit needs external catalogues to screen from: the instruments the Racional platform
offers (a public Google Sheet), superinvestor quarter buys and insider purchases (Dataroma),
and sector/industry for those instruments. These features are informational only. They never
buy, sell, connect brokers or log in to TradingView.

## Decision

1. **One contract, many sources.** `py_services/investment_sources/base.py` defines
   `InvestmentSource` (`source_code`, `display_name`, `fetch`, `normalize`, `validate`,
   `upsert`, `sync`). `sync()` is shared. It takes a lock (a fresh `running` row in
   `source_sync_run`), fetches, normalizes into typed DTOs, validates, then writes everything in
   one `BEGIN IMMEDIATE` transaction and records the metrics. pandas stays inside the connectors.
   `HttpFetcher` owns the timeout (15 s), the retries (3 attempts, exponential backoff), the
   identifiable User-Agent and an optional minimum interval between requests.
2. **SQLite, not PostgreSQL.** Tables come from migrations `0013_investment_sources.sql`
   (`stocks_origin`, `source_sync_run`) and `0014_dataroma_recent_buys.sql` (`recent_buys_q`,
   `recent_buys_insider`), in line with ADR-038.
3. **`stocks_origin` identity** is `UNIQUE(source_code, normalized_symbol, exchange)`, with
   `exchange NOT NULL DEFAULT ''`, because SQLite never treats two NULLs as equal in a UNIQUE
   index. Racional publishes no exchange, so its effective key is the normalized symbol. The
   exchange that yfinance reports is kept in `source_metadata.yf_exchange` / `tv_exchange` and
   never written to the key column. Rows are never deleted. Absent rows go inactive only after a
   complete successful sync.
4. **Dataroma** is scraped politely: sequentially, at least 2 s between pages, all `&L=n` pages
   with a cap of 30. A strict header check runs first, and a quarter that is missing or differs
   between pages fails the sync with no writes. Quarter buys keep their history per quarter.
   Insider rows that have no ticker, are exact duplicates or are not purchases are rejected and
   the reason is recorded.
5. **Enrichment is a source too** (`yfinance_enrichment`). Each run takes a batch of the oldest
   un-enriched symbols. It never overwrites a value with an empty one, retries errors after
   1 day and refreshes rows after 90 days.
6. **Execution.** `sync_cli.py --source CODE` prints one JSON `SyncResult`. Express runs it with
   `runPythonScriptFresh` (no stale cache) behind a per-source lock: `POST /api/sources/:code/sync`
   answers 409 while a sync of that source runs. The in-process `SourceScheduler` reuses the same
   lock.
7. **TradingView without an account.** The UI embeds only TradingView's public widgets. The CDP
   engine reports `tv_authenticated` / `session_mode`, and session-only commands (watchlists,
   alerts, broker reads, trading) fail fast with `TV_SESSION_REQUIRED` when the page is logged
   out.

## Configuration (environment)

| Variable | Default | Purpose |
|---|---|---|
| `RACIONAL_SHEET_DOCUMENT_ID` | `1Xm3AtWMAlIeGgSXFgmNBBuT5-nCZOA3-oUIPKEvs7t0` | Racional sheet id |
| `RACIONAL_SHEET_TAB_NAME` | `Stocks disponibles` | Sheet tab |
| `YF_ENRICH_BATCH` | `150` | Symbols enriched per run |
| `SOURCE_SYNC_SCHEDULER` | `on` | `off` disables automatic syncs |
| `SOURCE_SYNC_INTERVALS` | `racional_gsheet=24h,dataroma_quarterly_buys=24h,dataroma_insider_buys=6h,yfinance_enrichment=1h` | Minimum age of the last successful run before the next one |

## Consequences

- Adding a source means one class, one registry line and its migration. Nothing else changes.
- Dataroma has no API, so an HTML change fails loudly instead of corrupting data. Fixtures in
  `tests/py_services/fixtures/investment_sources/` pin the expected markup.
- Merging needs one deliberate migration of the real database:
  `python3 investment_screener/backend/py_services/domain_model/schema_migrator.py`.
  Until it runs, the Node schema gate refuses a database that is behind.
