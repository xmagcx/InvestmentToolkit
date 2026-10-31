#!/usr/bin/env python3
"""dataroma_quarterly_buys.py — Dataroma's superinvestor quarter buys as an investment source.

Purpose:
    Reads https://www.dataroma.com/m/g/portfolio_b.php?q=q&o=c (every `&L=n` page) and stores
    one ``recent_buys_q`` row per (quarter, instrument): which quarter the superinvestors
    bought in, how many of them bought, the hold price they are credited with and the quote
    columns Dataroma shows next to it (S6).

    The quarter comes from the page header ("Q3 2026" -> "2026Q3"). It must be present and
    identical on every page: a header that lost the quarter, or pages that disagree, fails
    the sync before anything is written, because a row filed under the wrong quarter would
    silently corrupt the history this table exists for.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    from investment_sources.dataroma_quarterly_buys import DataromaQuarterlyBuysSource
    DataromaQuarterlyBuysSource().sync(conn, trigger="manual")

Key Classes / Functions (Index):
    - DataromaQuarterlyBuysSource: fetch/normalize/validate/upsert for the quarter-buys grid
    - QuarterlyBuyRecord: frozen DTO of one published row
    - COLUMNS: the expected header labels, in published order (strict check)

Key Input Dependencies:
    - the grid header labels Symbol, Stock, %, Buys, Hold Price*, Current Price,
      52 Week Low, % Above 52 Week Low, 52 Week High
    - ticker_aliases.normalize_ticker (the only alias map in the repo)

Key Output Dependencies:
    - recent_buys_q rows (migration 0014) and the source_sync_run ledger
"""
from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .base import SourceError
from .dataroma import (
    DataromaSource,
    body_rows,
    cell_text,
    find_grid,
    header_cells,
    parse_int,
    parse_number,
    parse_quarter,
    require_columns,
    soup_of,
    upsert_rows,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ticker_aliases import normalize_ticker  # noqa: E402

TABLE = "recent_buys_q"
KEY_COLUMNS = ("quarter", "normalized_symbol")
#: Published header labels; the row cells are read at the index of each label.
COLUMNS = (
    "Symbol", "Stock", "%", "Buys", "Hold Price*", "Current Price",
    "52 Week Low", "% Above 52 Week Low", "52 Week High",
)


@dataclass(frozen=True)
class QuarterlyBuyRecord:
    """One instrument bought in one quarter, as Dataroma published it."""

    quarter: str
    symbol: str
    normalized_symbol: str
    company_name: str | None
    portfolio_pct: float | None
    buys_count: int | None
    hold_price: float | None
    current_price: float | None
    low_52w: float | None
    pct_above_low_52w: float | None
    high_52w: float | None
    source_url: str
    raw_row: dict

    def columns(self) -> dict:
        """The recent_buys_q column values of this row (timestamps are the upsert's job)."""
        return {
            "quarter": self.quarter,
            "symbol": self.symbol,
            "normalized_symbol": self.normalized_symbol,
            "company_name": self.company_name,
            "portfolio_pct": self.portfolio_pct,
            "buys_count": self.buys_count,
            "hold_price": self.hold_price,
            "current_price": self.current_price,
            "low_52w": self.low_52w,
            "pct_above_low_52w": self.pct_above_low_52w,
            "high_52w": self.high_52w,
            "source_url": self.source_url,
            "raw_row": json.dumps(self.raw_row, ensure_ascii=False),
        }


class DataromaQuarterlyBuysSource(DataromaSource):
    """Dataroma's "superinvestor buys this quarter" grid, across all its pages."""

    source_code = "dataroma_quarterly_buys"
    display_name = "Dataroma – Superinvestor quarter buys"
    url = "https://www.dataroma.com/m/g/portfolio_b.php?q=q&o=c"

    def normalize(self, raw: Sequence[tuple[str, str]]) -> list[QuarterlyBuyRecord]:
        """Parse every fetched page; fail when the quarter is absent or differs between pages."""
        records: list[QuarterlyBuyRecord] = []
        quarter: str | None = None
        for url, html in raw:
            soup = soup_of(html)
            page_quarter = parse_quarter(cell_text(soup.find(id="p1")))
            if page_quarter is None:
                raise SourceError(f"no quarter in the page header of {url}")
            if quarter is None:
                quarter = page_quarter
            elif page_quarter != quarter:
                raise SourceError(f"quarter mismatch: {quarter} on page 1, {page_quarter} on {url}")
            records.extend(self._page_records(soup, url, quarter))
        return records

    def _page_records(self, soup, url: str, quarter: str) -> list[QuarterlyBuyRecord]:
        """Parse one page's grid into DTOs after a strict header check."""
        grid = find_grid(soup, url)
        labels = [cell_text(cell) for cell in header_cells(grid)]
        require_columns(labels, COLUMNS, "quarterly buys grid")
        index = {label: labels.index(label) for label in COLUMNS}
        records = []
        for row in body_rows(grid):
            cells = row.find_all("td")
            if len(cells) < len(labels):
                continue  # layout rows (pagination, notes) are not data rows
            values = {label: cell_text(cells[position]) for label, position in index.items()}
            records.append(self._record(values, url, quarter))
        return records

    def _record(self, values: dict, url: str, quarter: str) -> QuarterlyBuyRecord:
        """Build one DTO from the cell texts of a published row."""
        symbol = values["Symbol"].upper()
        return QuarterlyBuyRecord(
            quarter=quarter,
            symbol=symbol,
            normalized_symbol=normalize_ticker(symbol) if symbol else "",
            company_name=values["Stock"] or None,
            portfolio_pct=parse_number(values["%"]),
            buys_count=parse_int(values["Buys"]),
            hold_price=parse_number(values["Hold Price*"]),
            current_price=parse_number(values["Current Price"]),
            low_52w=parse_number(values["52 Week Low"]),
            pct_above_low_52w=parse_number(values["% Above 52 Week Low"]),
            high_52w=parse_number(values["52 Week High"]),
            source_url=url,
            raw_row=values,
        )

    def validate(
        self, items: Sequence[QuarterlyBuyRecord]
    ) -> tuple[list[QuarterlyBuyRecord], list[dict]]:
        """Drop rows without a symbol and repeats of a symbol already seen in this quarter."""
        valid: list[QuarterlyBuyRecord] = []
        rejected: list[dict] = []
        seen: set[tuple[str, str]] = set()
        for item in items:
            key = (item.quarter, item.normalized_symbol)
            if not item.symbol:
                rejected.append({"symbol": item.symbol, "reason": "empty_symbol"})
                continue
            if key in seen:
                rejected.append({"symbol": item.symbol, "reason": "duplicate_symbol"})
                continue
            seen.add(key)
            valid.append(item)
        return valid, rejected

    def upsert(self, items: Sequence[QuarterlyBuyRecord], conn: sqlite3.Connection) -> dict:
        """Insert new (quarter, symbol) rows and refresh the ones already stored."""
        return upsert_rows(conn, TABLE, KEY_COLUMNS, [item.columns() for item in items])


__all__ = ["DataromaQuarterlyBuysSource", "QuarterlyBuyRecord", "COLUMNS"]
