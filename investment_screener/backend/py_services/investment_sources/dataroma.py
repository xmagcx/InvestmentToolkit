#!/usr/bin/env python3
"""dataroma.py — what the two Dataroma connectors share: paging, parsing and the row upsert.

Purpose:
    Dataroma publishes two grids this toolkit reads (S6 superinvestor quarter buys, S7
    insider purchases). Both are plain HTML tables spread over `&L=n` pages, both use the
    same number/date formats, and both land in an insert-or-update table that is never
    pruned. That common ground lives here so each connector only describes its own columns.

    Scraping etiquette (S11) is a property of this module: the default fetcher is built with
    an identifiable User-Agent and at least ``MIN_REQUEST_INTERVAL_SECONDS`` between
    requests, pages are fetched one after another, and a grid whose header lost a column
    raises ``SourceError`` so the sync fails before it writes anything.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    from investment_sources.dataroma import DataromaSource, parse_number, page_url
    page_url("https://www.dataroma.com/m/g/portfolio_b.php?q=q&o=c", 2)  # ...&L=2

Key Classes / Functions (Index):
    - MIN_REQUEST_INTERVAL_SECONDS / MAX_PAGES: the politeness and safety bounds
    - parse_number / parse_int: "$521.83", "245,898" -> 521.83, 245898 ("" / "-" -> None)
    - parse_filing_datetime / parse_transaction_date: "30 Oct 2026 18:06" -> "2026-10-30T18:06"
    - parse_quarter: a header containing "Q3 2026" -> "2026Q3"
    - page_url / discover_page_count: the `&L=n` paging of both grids
    - require_columns: strict header check (raises SourceError naming the missing columns)
    - find_grid / row_cells / cell_text / text_without_spans: html.parser-based table reading
    - upsert_rows: insert-or-update by a key tuple, never delete, never deactivate
    - DataromaSource: InvestmentSource that fetches every page of one Dataroma grid

Key Input Dependencies:
    - bs4 with the stdlib "html.parser" (lxml is not installed and no dependency is added)
    - investment_sources.base (HttpFetcher, InvestmentSource, SourceError, utc_now)

Key Output Dependencies:
    - recent_buys_q / recent_buys_insider rows (migration 0014), via upsert_rows
"""
from __future__ import annotations

import re
import sqlite3
from typing import Any, Sequence

from .base import HttpFetcher, InvestmentSource, SourceError, log_event, utc_now

#: S11: never hit dataroma.com more often than this, and never in parallel.
MIN_REQUEST_INTERVAL_SECONDS = 2.0
#: Safety bound: a pagination block claiming more pages than this is clamped.
MAX_PAGES = 30

_MONTHS = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
}
_PAGE_LINK_RE = re.compile(r'href="[^"]*[?&]L=(\d+)', re.IGNORECASE)
_DATE_RE = re.compile(r"(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\s+(\d{4})")
_TIME_RE = re.compile(r"(\d{1,2}):(\d{2})")
_QUARTER_RE = re.compile(r"\bQ([1-4])\s+(\d{4})\b")
_NUMBER_RE = re.compile(r"^-?\d+(\.\d+)?$")


# --- parsing ---------------------------------------------------------------------------


def parse_number(text: str | None) -> float | None:
    """Parse a published number ("$521.83", "8,671,495", "59.79"); return None when unusable."""
    cleaned = re.sub(r"[$,%\s]", "", text or "")
    if not _NUMBER_RE.match(cleaned):
        return None
    return float(cleaned)


def parse_int(text: str | None) -> int | None:
    """Parse a published whole number ("245,898" -> 245898); return None when unusable."""
    value = parse_number(text)
    if value is None or value != int(value):
        return None
    return int(value)


def parse_transaction_date(text: str | None) -> str | None:
    """Parse "29 Oct 2026" into "2026-10-29"; return None when no date is present."""
    match = _DATE_RE.search(text or "")
    if not match:
        return None
    day, month_name, year = match.groups()
    month = _MONTHS.get(month_name.lower())
    if month is None:
        return None
    return f"{year}-{month:02d}-{int(day):02d}"


def parse_filing_datetime(text: str | None) -> str | None:
    """Parse "30 Oct 2026 18:06" into "2026-10-30T18:06" (US/Eastern, as published)."""
    date = parse_transaction_date(text)
    if date is None:
        return None
    time_match = _TIME_RE.search(text or "")
    if not time_match:
        return None
    hour, minute = time_match.groups()
    return f"{date}T{int(hour):02d}:{minute}"


def parse_quarter(text: str | None) -> str | None:
    """Parse the grid header ("... Q3 2026") into "2026Q3"; return None when absent."""
    match = _QUARTER_RE.search(text or "")
    if not match:
        return None
    quarter, year = match.groups()
    return f"{year}Q{quarter}"


# --- paging ----------------------------------------------------------------------------


def page_url(base_url: str, page: int) -> str:
    """Return the URL of page ``page`` of a Dataroma grid (the site's own `&L=n` form)."""
    return f"{base_url}&L={page}"


def discover_page_count(html: str) -> int:
    """Return how many pages the pagination links announce (at least 1, at most MAX_PAGES)."""
    pages = [int(value) for value in _PAGE_LINK_RE.findall(html)]
    return min(max(pages or [1]), MAX_PAGES)


# --- HTML reading ----------------------------------------------------------------------


def soup_of(html: str):
    """Parse a Dataroma page with the stdlib html.parser (lxml is not installed)."""
    from bs4 import BeautifulSoup  # local import: bs4 only loads where HTML is parsed

    return BeautifulSoup(html, "html.parser")


def find_grid(soup: Any, url: str):
    """Return the <table id="grid"> of a Dataroma page; a page without it is unexpected HTML."""
    grid = soup.find("table", id="grid")
    if grid is None:
        raise SourceError(f"no <table id='grid'> on {url}")
    return grid


def header_cells(grid: Any) -> list:
    """Return the <td> cells of the grid's header row."""
    head = grid.find("thead")
    if head is None or head.find("tr") is None:
        raise SourceError("grid has no header row")
    return head.find("tr").find_all("td")


def body_rows(grid: Any) -> list:
    """Return the data <tr> rows of the grid (the paging row inside <tfoot> is not one)."""
    body = grid.find("tbody") or grid
    return [row for row in body.find_all("tr") if row.find_parent("tfoot") is None]


def cell_text(cell: Any) -> str:
    """Collapsed text of a cell, with the sort arrows Dataroma puts in its headers removed."""
    text = cell.get_text(" ", strip=True) if cell is not None else ""
    return re.sub(r"\s+", " ", text.replace("\u25b2", "").replace("\u25bc", "")).strip()


def text_without_spans(cell: Any) -> str:
    """Collapsed text of a cell ignoring its <span> children (footnote markers, flags)."""
    if cell is None:
        return ""
    parts = [str(node) for node in cell.children if getattr(node, "name", None) != "span"]
    return cell_text(soup_of("".join(parts)))


def require_columns(found: Sequence[str], expected: Sequence[str], label: str) -> None:
    """Raise SourceError naming every expected column the grid header no longer carries."""
    missing = [column for column in expected if column not in found]
    if missing:
        raise SourceError(f"{label} is missing required column(s): {', '.join(missing)}")


# --- writing ---------------------------------------------------------------------------


def upsert_rows(
    conn: sqlite3.Connection, table: str, key_columns: Sequence[str], rows: Sequence[dict]
) -> dict:
    """Insert new rows and refresh existing ones (matched on ``key_columns``); never delete.

    Dataroma history is cumulative: a quarter that rolled over or a filing that fell off
    page 1 keeps its row, so this upsert reports only inserted/updated.
    """
    now = utc_now()
    counts = {"inserted": 0, "updated": 0, "reactivated": 0, "deactivated": 0}
    where = " AND ".join(f"{column} = ?" for column in key_columns)
    for row in rows:
        existing = conn.execute(
            f"SELECT id FROM {table} WHERE {where}", [row[column] for column in key_columns]
        ).fetchone()
        if existing is None:
            columns = [*row.keys(), "first_seen_at", "last_synced_at"]
            placeholders = ", ".join("?" for _ in columns)
            conn.execute(
                f"INSERT INTO {table} ({', '.join(columns)}) VALUES ({placeholders})",
                [*row.values(), now, now],
            )
            counts["inserted"] += 1
            continue
        changeable = [column for column in row if column not in key_columns]
        assignments = ", ".join(f"{column} = ?" for column in changeable)
        conn.execute(
            f"UPDATE {table} SET {assignments}, last_synced_at = ? WHERE id = ?",
            [*(row[column] for column in changeable), now, existing[0]],
        )
        counts["updated"] += 1
    return counts


class DataromaSource(InvestmentSource):
    """An InvestmentSource that reads every `&L=n` page of one Dataroma grid, sequentially."""

    #: The grid's first-page URL, without the `&L=n` parameter.
    url: str = ""

    def __init__(self, *, fetcher: object | None = None) -> None:
        self.fetcher = fetcher or HttpFetcher(min_interval=MIN_REQUEST_INTERVAL_SECONDS)

    def fetch(self) -> list[tuple[str, str]]:
        """Return [(url, html)] for every page, requested one at a time (S11)."""
        first_url = page_url(self.url, 1)
        first_html = self.fetcher.get_text(first_url)  # type: ignore[attr-defined]
        pages = [(first_url, first_html)]
        total = discover_page_count(first_html)
        for number in range(2, total + 1):
            url = page_url(self.url, number)
            pages.append((url, self.fetcher.get_text(url)))  # type: ignore[attr-defined]
        log_event("dataroma_pages_fetched", source=self.source_code, pages=len(pages), announced=total)
        return pages


__all__ = [
    "MIN_REQUEST_INTERVAL_SECONDS", "MAX_PAGES", "DataromaSource", "body_rows", "cell_text",
    "discover_page_count", "find_grid", "header_cells", "page_url", "parse_filing_datetime",
    "parse_int", "parse_number", "parse_quarter", "parse_transaction_date", "require_columns",
    "soup_of", "text_without_spans", "upsert_rows",
]
