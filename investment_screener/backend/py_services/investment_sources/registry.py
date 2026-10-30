#!/usr/bin/env python3
"""registry.py — the catalogue of installed investment sources.

Purpose:
    One place that maps a source_code to its connector class, so the CLI, the Express
    sync route and the scheduler all speak the same codes. A new connector is added by
    appending an entry to SOURCES; nothing else changes.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    from investment_sources.registry import get_source, list_sources
    source = get_source("racional_gsheet")()
    list_sources()  # [{"source_code": ..., "display_name": ...}, ...]

Key Functions (Index):
    - SOURCES: dict source_code -> InvestmentSource subclass
    - get_source(code): the class for a code (KeyError when unknown)
    - list_sources(): codes + display names, for the UI's source picker

Key Input Dependencies:
    - investment_sources.google_sheet_stocks.GoogleSheetStocksSource
    - investment_sources.dataroma_quarterly_buys.DataromaQuarterlyBuysSource (S6)
    - investment_sources.dataroma_insider_buys.DataromaInsiderBuysSource (S7)
    - investment_sources.yfinance_enrichment.YFinanceProfileEnrichment (S10, enriches stocks_origin)

Key Output Dependencies:
    - consumed by sync_cli.py and (later) the Express /api/sources routes
"""
from __future__ import annotations

from .base import InvestmentSource
from .dataroma_insider_buys import DataromaInsiderBuysSource
from .dataroma_quarterly_buys import DataromaQuarterlyBuysSource
from .google_sheet_stocks import GoogleSheetStocksSource
from .yfinance_enrichment import YFinanceProfileEnrichment

SOURCES: dict[str, type[InvestmentSource]] = {
    GoogleSheetStocksSource.source_code: GoogleSheetStocksSource,
    DataromaQuarterlyBuysSource.source_code: DataromaQuarterlyBuysSource,
    DataromaInsiderBuysSource.source_code: DataromaInsiderBuysSource,
    YFinanceProfileEnrichment.source_code: YFinanceProfileEnrichment,
}


def get_source(code: str) -> type[InvestmentSource]:
    """Return the connector class registered under ``code``.

    Raises:
        KeyError: when no source is registered under that code (callers report it).
    """
    if code not in SOURCES:
        raise KeyError(f"unknown source '{code}'; known: {', '.join(sorted(SOURCES))}")
    return SOURCES[code]


def list_sources() -> list[dict]:
    """Return every registered source as {source_code, display_name}, sorted by code."""
    return [
        {"source_code": code, "display_name": cls.display_name}
        for code, cls in sorted(SOURCES.items())
    ]
