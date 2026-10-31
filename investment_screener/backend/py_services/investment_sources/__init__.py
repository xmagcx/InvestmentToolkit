"""investment_sources — pluggable connectors that fill stocks_origin from external catalogues.

Purpose:
    Package root for the investment-source framework (S1-S3): ``base`` holds the DTOs,
    the HTTP fetcher and the sync contract, ``google_sheet_stocks`` is the first
    connector, ``registry`` maps source codes to classes and ``sync_cli`` runs one sync.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    from investment_sources.registry import get_source
    get_source("racional_gsheet")().sync(conn, trigger="manual")

Key Modules (Index):
    - base: SourceError/FetchError, StockRecord, SyncResult, HttpFetcher,
      InvestmentSource, StocksOriginUpsert, StocksOriginSource
    - google_sheet_stocks: GoogleSheetStocksSource ("racional_gsheet")
    - registry: SOURCES, get_source(), list_sources()
    - sync_cli: main() / command-line entry point

Key Input Dependencies:
    - domain_model.sqlite tables stocks_origin and source_sync_run (migration 0013)
"""
