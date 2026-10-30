#!/usr/bin/env python3
"""registry.py — the catalogue of installed investment sources.

Purpose:
    One place that maps a source_code to its connector class, so the CLI, the Express
    sync route and the scheduler all speak the same codes. Dataroma connectors (S6, S7)
    are added by appending an entry to SOURCES; nothing else changes.

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

Key Output Dependencies:
    - consumed by sync_cli.py and (later) the Express /api/sources routes
"""
from __future__ import annotations

from .base import InvestmentSource
from .google_sheet_stocks import GoogleSheetStocksSource

SOURCES: dict[str, type[InvestmentSource]] = {
    GoogleSheetStocksSource.source_code: GoogleSheetStocksSource,
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
