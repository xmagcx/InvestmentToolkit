#!/usr/bin/env python3
"""dataroma_insider_buys.py — Dataroma's insider purchases as an investment source.

Purpose:
    Reads https://www.dataroma.com/m/ins/ins.php?t=m&po=1&am=0&sym=&o=fd&d=d (every `&L=n`
    page) and stores one ``recent_buys_insider`` row per published Form 4 purchase: who
    bought, in what relationship to the issuer, how many shares at what price, whether the
    holding is direct or indirect, and the SEC document the filing links to (S7).

    Only "Purchase" rows are stored; anything else is rejected with a reason so the ledger
    shows why. Dataroma publishes no filing id, so the stored identity is the published
    tuple (filing_at, symbol, reporting name, transaction date, shares, price) — which is
    why a row whose shares or price cannot be parsed is rejected rather than stored.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    from investment_sources.dataroma_insider_buys import DataromaInsiderBuysSource
    DataromaInsiderBuysSource().sync(conn, trigger="manual")

Key Classes / Functions (Index):
    - DataromaInsiderBuysSource: fetch/normalize/validate/upsert for the insider grid
    - InsiderBuyRecord: frozen DTO of one published filing row
    - CELL_CLASSES: the grid's column classes, all of which must still be present

Key Input Dependencies:
    - the grid's per-cell classes f_date, iss_sym, iss_name, rep_name, rel, t_date,
      tran_code, sh, pr, amt, dir_ind (the <span>A</span> marker means SEC Form 4/A)
    - ticker_aliases.normalize_ticker (the only alias map in the repo)

Key Output Dependencies:
    - recent_buys_insider rows (migration 0014) and the source_sync_run ledger
"""
from __future__ import annotations

import json
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .dataroma import (
    DataromaSource,
    body_rows,
    cell_text,
    find_grid,
    header_cells,
    parse_filing_datetime,
    parse_int,
    parse_number,
    parse_transaction_date,
    require_columns,
    soup_of,
    text_without_spans,
    upsert_rows,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from ticker_aliases import normalize_ticker  # noqa: E402

TABLE = "recent_buys_insider"
KEY_COLUMNS = ("filing_at", "normalized_symbol", "reporting_name", "transaction_date", "shares", "price")
#: Every column class the grid must still publish (the rows are read by class, not position).
CELL_CLASSES = (
    "f_date", "iss_sym", "iss_name", "rep_name", "rel", "t_date",
    "tran_code", "sh", "pr", "amt", "dir_ind",
)
PURCHASE = "Purchase"
_RID_RE = re.compile(r"[?&]rid=(\d+)")


@dataclass(frozen=True)
class InsiderBuyRecord:
    """One insider transaction row as Dataroma published it."""

    filing_at: str | None
    symbol: str
    normalized_symbol: str
    security_name: str | None
    reporting_name: str
    reporting_id: str | None
    relationship: str | None
    transaction_date: str
    transaction_type: str
    shares: int | None
    price: float | None
    amount: float | None
    ownership_type: str | None
    is_ten_pct_owner: int
    is_amendment: int
    filing_url: str | None
    source_url: str
    raw_row: dict

    def columns(self) -> dict:
        """The recent_buys_insider column values of this row (timestamps are the upsert's job)."""
        return {
            "filing_at": self.filing_at,
            "symbol": self.symbol,
            "normalized_symbol": self.normalized_symbol,
            "security_name": self.security_name,
            "reporting_name": self.reporting_name,
            "reporting_id": self.reporting_id,
            "relationship": self.relationship,
            "transaction_date": self.transaction_date,
            "transaction_type": self.transaction_type,
            "shares": self.shares,
            "price": self.price,
            "amount": self.amount,
            "ownership_type": self.ownership_type,
            "is_ten_pct_owner": self.is_ten_pct_owner,
            "is_amendment": self.is_amendment,
            "filing_url": self.filing_url,
            "source_url": self.source_url,
            "raw_row": json.dumps(self.raw_row, ensure_ascii=False),
        }


class DataromaInsiderBuysSource(DataromaSource):
    """Dataroma's insider-purchases grid, across all its pages."""

    source_code = "dataroma_insider_buys"
    display_name = "Dataroma – Insider purchases"
    url = "https://www.dataroma.com/m/ins/ins.php?t=m&po=1&am=0&sym=&o=fd&d=d"

    def normalize(self, raw: Sequence[tuple[str, str]]) -> list[InsiderBuyRecord]:
        """Parse every fetched page's grid into DTOs after a strict header check."""
        records: list[InsiderBuyRecord] = []
        for url, html in raw:
            grid = find_grid(soup_of(html), url)
            classes = [name for cell in header_cells(grid) for name in cell.get("class", [])]
            require_columns(classes, CELL_CLASSES, "insider grid")
            for row in body_rows(grid):
                cells = {name: row.find("td", class_=name) for name in CELL_CLASSES}
                if cells["f_date"] is None:
                    continue  # layout rows (pagination, notes) are not data rows
                records.append(self._record(row, cells, url))
        return records

    def _record(self, row, cells: dict, url: str) -> InsiderBuyRecord:
        """Build one DTO from the cells of a published filing row."""
        texts = {name: cell_text(cell) for name, cell in cells.items()}
        symbol = texts["iss_sym"].upper()
        relationship = texts["rel"]
        link = cells["f_date"].find("a")
        reporter_link = cells["rep_name"].find("a")
        rid = _RID_RE.search(reporter_link.get("href", "")) if reporter_link else None
        return InsiderBuyRecord(
            filing_at=parse_filing_datetime(texts["f_date"]),
            symbol=symbol,
            normalized_symbol=normalize_ticker(symbol) if symbol else "",
            security_name=text_without_spans(cells["iss_name"]) or None,
            reporting_name=texts["rep_name"],
            reporting_id=rid.group(1) if rid else None,
            relationship=relationship or None,
            transaction_date=parse_transaction_date(texts["t_date"]) or "",
            transaction_type=text_without_spans(cells["tran_code"]),
            shares=parse_int(texts["sh"]),
            price=parse_number(texts["pr"]),
            amount=parse_number(texts["amt"]),
            ownership_type=texts["dir_ind"] or None,
            is_ten_pct_owner=int("10%" in relationship),
            is_amendment=int(_has_amendment_marker(row)),
            filing_url=link.get("href") if link else None,
            source_url=url,
            raw_row=texts,
        )

    def validate(self, items: Sequence[InsiderBuyRecord]) -> tuple[list[InsiderBuyRecord], list[dict]]:
        """Keep complete "Purchase" rows only; everything else is rejected with a reason."""
        valid: list[InsiderBuyRecord] = []
        rejected: list[dict] = []
        seen: set[tuple] = set()
        for item in items:
            key = tuple(item.columns()[column] for column in KEY_COLUMNS)
            reason = self._rejection_reason(item, key, seen)
            if reason:
                rejected.append({"symbol": item.symbol, "reason": reason, "filing_at": item.filing_at})
                continue
            seen.add(key)
            valid.append(item)
        return valid, rejected

    def _rejection_reason(self, item: InsiderBuyRecord, key: tuple, seen: set) -> str | None:
        """Why this filing row cannot be stored, or None when it is usable."""
        if item.transaction_type != PURCHASE:
            return "not_a_purchase"
        if not item.symbol:
            return "empty_symbol"
        if not item.filing_at:
            return "unparseable_filing_date"
        if not item.reporting_name:
            return "empty_reporting_name"
        if item.shares is None:
            return "unparseable_shares"
        if item.price is None:
            return "unparseable_price"
        if key in seen:
            return "duplicate_filing"
        return None

    def upsert(self, items: Sequence[InsiderBuyRecord], conn: sqlite3.Connection) -> dict:
        """Insert new filings and refresh the ones already stored; nothing is ever deleted."""
        return upsert_rows(conn, TABLE, KEY_COLUMNS, [item.columns() for item in items])


def _has_amendment_marker(row) -> bool:
    """True when the row carries Dataroma's <span>A</span> marker (SEC Form 4/A)."""
    return any(span.get_text(strip=True) == "A" for span in row.find_all("span"))


__all__ = ["DataromaInsiderBuysSource", "InsiderBuyRecord", "CELL_CLASSES"]
