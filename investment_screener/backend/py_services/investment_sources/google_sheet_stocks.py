#!/usr/bin/env python3
"""google_sheet_stocks.py — Racional's "Stocks disponibles" Google Sheet as an investment source.

Purpose:
    Reads the published CSV export of the Racional sheet (S3) and turns it into
    ``stocks_origin`` rows under source_code ``racional_gsheet``. pandas is used only
    here, inside the connector: everything that leaves this module is a ``StockRecord``.

    The sheet is read with ``dtype=str, keep_default_na=False`` so the ticker "NA" is the
    string "NA" and not a missing value, and symbols keep their share class (BRK.A stays
    distinct from BRK.B).

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    from investment_sources.google_sheet_stocks import GoogleSheetStocksSource
    GoogleSheetStocksSource().sync(conn, trigger="manual")

Key Classes / Functions (Index):
    - GoogleSheetStocksSource: fetch/normalize/validate for the Racional sheet
    - GoogleSheetStocksSource.url: the gviz CSV export URL (document id + encoded tab)
    - DEFAULT_DOCUMENT_ID / DEFAULT_TAB_NAME: the S3 coordinates, overridable by env

Key Input Dependencies:
    - env RACIONAL_SHEET_DOCUMENT_ID, RACIONAL_SHEET_TAB_NAME (optional overrides)
    - the published sheet columns: Simbolo, Nombre, Tipo, URL
    - ticker_aliases.normalize_ticker (the only alias map in the repo)

Key Output Dependencies:
    - StockRecord DTOs consumed by StocksOriginUpsert (stocks_origin rows)
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path
from typing import Sequence
from urllib.parse import parse_qs, quote, urlparse

from .base import FetchError, HttpFetcher, SourceError, StockRecord, StocksOriginSource, log_event

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ticker_aliases import normalize_ticker  # noqa: E402

DEFAULT_DOCUMENT_ID = "1Xm3AtWMAlIeGgSXFgmNBBuT5-nCZOA3-oUIPKEvs7t0"
DEFAULT_TAB_NAME = "Stocks disponibles"
REQUIRED_COLUMNS = ("Simbolo", "Nombre", "Tipo", "URL")
#: Racional deep links look like https://app.racional.cl/app/<code>?assetId=<SYMBOL>
PLATFORM_PATH_PREFIX = "/app/"


class GoogleSheetStocksSource(StocksOriginSource):
    """The Racional "Stocks disponibles" sheet, published as CSV through the gviz endpoint."""

    source_code = "racional_gsheet"
    display_name = "Racional – Stocks disponibles"

    def __init__(
        self,
        *,
        fetcher: object | None = None,
        document_id: str | None = None,
        tab_name: str | None = None,
    ) -> None:
        self.fetcher = fetcher or HttpFetcher()
        self.document_id = document_id or os.environ.get("RACIONAL_SHEET_DOCUMENT_ID") or DEFAULT_DOCUMENT_ID
        self.tab_name = tab_name or os.environ.get("RACIONAL_SHEET_TAB_NAME") or DEFAULT_TAB_NAME

    @property
    def url(self) -> str:
        """The CSV export URL of the configured document/tab (S3, verbatim shape)."""
        tab_enc = quote(self.tab_name, safe="")
        return f"https://docs.google.com/spreadsheets/d/{self.document_id}/gviz/tq?tqx=out:csv&sheet={tab_enc}"

    def fetch(self) -> str:
        """Return the sheet's CSV text (retries and timeout live in the fetcher)."""
        return self.fetcher.get_text(self.url)  # type: ignore[attr-defined]

    def normalize(self, raw: str) -> list[StockRecord]:
        """Parse the CSV into one DTO per published row; a missing column fails the sync."""
        import pandas as pd  # local import: pandas never leaves this connector

        frame = pd.read_csv(io.StringIO(raw), dtype=str, keep_default_na=False)
        missing = [column for column in REQUIRED_COLUMNS if column not in frame.columns]
        if missing:
            raise SourceError(f"sheet is missing required column(s): {', '.join(missing)}")
        return [self._record(row) for row in frame.to_dict("records")]

    def _record(self, row: dict) -> StockRecord:
        """Build one DTO from a sheet row, keeping the raw symbol and link in the metadata."""
        raw_symbol = (row.get("Simbolo") or "").strip()
        platform_url = (row.get("URL") or "").strip()
        external_id, asset_id = _parse_platform_url(platform_url)
        symbol = raw_symbol.upper()
        normalized = normalize_ticker(symbol)
        if asset_id and asset_id.upper() != symbol:
            log_event("sheet_asset_id_mismatch", symbol=symbol, asset_id=asset_id, url=platform_url)
        return StockRecord(
            source_code=self.source_code,
            symbol=symbol,
            normalized_symbol=normalized,
            exchange="",
            external_id=external_id,
            company_name=(row.get("Nombre") or "").strip() or None,
            asset_type=(row.get("Tipo") or "").strip().upper() or None,
            source_metadata={
                "platform_url": platform_url,
                "asset_id": asset_id,
                "raw_symbol": raw_symbol,
            },
        )

    def validate(self, items: Sequence[StockRecord]) -> tuple[list[StockRecord], list[dict]]:
        """Drop rows without a symbol, with a malformed link, or repeating an earlier symbol."""
        valid: list[StockRecord] = []
        rejected: list[dict] = []
        seen: set[str] = set()
        for item in items:
            reason = self._rejection_reason(item, seen)
            if reason:
                rejected.append({"symbol": item.symbol, "reason": reason, "name": item.company_name})
                continue
            seen.add(item.normalized_symbol)
            valid.append(item)
        return valid, rejected

    def _rejection_reason(self, item: StockRecord, seen: set[str]) -> str | None:
        """Why this row cannot be stored, or None when it is usable (first copy wins)."""
        if not item.symbol:
            return "empty_symbol"
        if item.normalized_symbol in seen:
            return "duplicate_symbol"
        if not _is_http_url(item.source_metadata.get("platform_url", "")):
            return "malformed_url"
        return None


def _parse_platform_url(url: str) -> tuple[str | None, str]:
    """Return (external_id, asset_id): the code after /app/ and the assetId query parameter."""
    if not _is_http_url(url):
        return None, ""
    parsed = urlparse(url)
    external_id = None
    if parsed.path.startswith(PLATFORM_PATH_PREFIX):
        code = parsed.path[len(PLATFORM_PATH_PREFIX):].strip("/")
        external_id = code or None
    asset_id = (parse_qs(parsed.query).get("assetId") or [""])[0]
    return external_id, asset_id


def _is_http_url(url: str) -> bool:
    """True for an http(s) URL with a host; anything else is a malformed platform link."""
    parsed = urlparse(url)
    return parsed.scheme in {"http", "https"} and bool(parsed.netloc)


__all__ = ["GoogleSheetStocksSource", "DEFAULT_DOCUMENT_ID", "DEFAULT_TAB_NAME", "FetchError"]
