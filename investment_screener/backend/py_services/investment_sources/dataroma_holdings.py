#!/usr/bin/env python3
"""dataroma_holdings.py — superinvestor ownership of one stock, read from Dataroma (S12/S14).

Purpose:
    Step 6 of the Oportunidades funnel ("¿lo compran los expertos?") used to know only how
    many superinvestors bought this quarter. S12 adds the context the owner asked for: how
    many of them hold the stock at all, how concentrated the largest position is, at what
    price they are credited with holding it, and whether the quarter's activity was net
    buying or net selling. All of it comes from one page per symbol,
    https://www.dataroma.com/m/stock.php?sym=XXX, which publishes:

      - "Ownership count" (the holders number) and "Ownership rank" in the #t1 stats block;
      - "Hold Price *" (only when at least two investors own it) in the same block;
      - a holders grid: Portfolio Manager, % of portfolio, Recent activity ("Add 12.5%",
        "Buy", "Reduce 16.64%", or blank when the position did not move), Shares, Value.

    It does NOT publish the previous quarter's holder count, so ``holders_prev`` stays NULL
    until another source fills it — an invented trend would be worse than no trend.
    ``net_activity`` is derived from the "Recent activity" column of that latest quarter:
    (buys + adds) - (reduces + sells).

    Etiquette (S11/S14): symbols are fetched one at a time, at least
    ``MIN_REQUEST_INTERVAL_SECONDS`` apart, and at most ``MAX_SYMBOLS_PER_RUN`` per sync.
    Parsing is strict per symbol: a page whose stats block or grid changed shape is rejected
    with a reason and the remaining symbols still sync.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    from investment_sources.dataroma_holdings import DataromaHoldingsSource
    DataromaHoldingsSource().sync(conn, trigger="manual")          # the screened symbols
    DataromaHoldingsSource(symbols=["TMO"]).sync(conn)             # an explicit short list

Key Classes / Functions (Index):
    - MAX_SYMBOLS_PER_RUN / TOP_HOLDERS / TABLE / COLUMNS: the bounds and the grid contract
    - stock_url(symbol): the per-stock page URL
    - select_symbols(conn): step-4 survivors of the latest snapshot + the latest quarter buys
    - activity_sign(text): "Add 12.5%" -> +1, "Reduce 16.64%" -> -1, blank -> 0
    - parse_ownership_count(soup, url) / parse_hold_price(soup): the #t1 stats block
    - parse_holders(soup, url): the holders grid as [{manager, pct, activity}]
    - HoldingsRecord: frozen DTO of one symbol (or of the page that could not be read)
    - DataromaHoldingsSource: fetch/normalize/validate/upsert for stock_superinvestor_holdings

Key Input Dependencies:
    - the stock page labels "Ownership count" and the grid columns in ``COLUMNS``
    - opportunity_screener (the canonical step-4 evaluation; never re-implemented here)
    - recent_buys_q (migration 0014), stock_screen_snapshot (0015)

Key Output Dependencies:
    - stock_superinvestor_holdings rows (migration 0016) and the source_sync_run ledger
"""
from __future__ import annotations

import json
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Sequence

from .base import SourceError, utc_now
from .dataroma import (
    MIN_REQUEST_INTERVAL_SECONDS,
    DataromaSource,
    body_rows,
    cell_text,
    find_grid,
    header_cells,
    parse_int,
    parse_number,
    require_columns,
    soup_of,
)

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from opportunity_screener import (  # noqa: E402
    evaluate_row,
    load_aaa_yield,
    load_dataroma,
    load_snapshot,
    resolve_params,
    sector_median_pe,
)
from ticker_aliases import normalize_ticker  # noqa: E402

TABLE = "stock_superinvestor_holdings"
#: One page per symbol: fetching the whole universe would be neither polite nor useful.
MAX_SYMBOLS_PER_RUN = 600
#: How many holders the detail panel shows.
TOP_HOLDERS = 5
#: Published header labels of the holders grid (the first column holds the history link).
COLUMNS = ("Portfolio Manager", "% of portfolio", "Recent activity", "Shares", "Value")
STOCK_URL = "https://www.dataroma.com/m/stock.php?sym={symbol}"
#: The step of the funnel whose survivors are worth a page view ("¿cayó por causas externas?").
STEP_CAIDA = 4


def stock_url(symbol: str) -> str:
    """Return the Dataroma ownership page of one symbol."""
    return STOCK_URL.format(symbol=symbol.upper())


def activity_sign(text: str | None) -> int:
    """Score the "Recent activity" cell: a buy/add is +1, a reduce/sell -1, no move 0."""
    value = (text or "").strip().lower()
    if value.startswith(("buy", "add")):
        return 1
    if value.startswith(("reduce", "sell")):
        return -1
    return 0


# --- parsing ---------------------------------------------------------------------------


def parse_ownership_count(soup, url: str) -> int:
    """Return the published "Ownership count"; a page without it is unexpected HTML."""
    stats = soup.find("table", id="t1")
    if stats is None:
        raise SourceError(f"no <table id='t1'> stats block on {url}")
    for row in stats.find_all("tr"):
        cells = row.find_all("td")
        if len(cells) >= 2 and cell_text(cells[0]).lower().startswith("ownership count"):
            count = parse_int(cell_text(cells[1]))
            if count is None:
                raise SourceError(f"unreadable ownership count on {url}")
            return count
    raise SourceError(f"no ownership count on {url}")


def parse_hold_price(soup) -> float | None:
    """Return the "Hold Price *" the page publishes, or None (it needs two investors)."""
    return parse_number(cell_text(soup.find(id="price")))


def parse_holders(soup, url: str) -> list[dict]:
    """Return every published holder as {manager, pct, activity}, after a strict header check."""
    grid = find_grid(soup, url)
    labels = [cell_text(cell) for cell in header_cells(grid)]
    require_columns(labels, COLUMNS, "holders grid")
    index = {label: labels.index(label) for label in COLUMNS}
    holders = []
    for row in body_rows(grid):
        cells = row.find_all("td")
        if len(cells) < len(labels):
            continue  # layout rows (notes, spacers) are not data rows
        holders.append({
            "manager": cell_text(cells[index["Portfolio Manager"]]),
            "pct": parse_number(cell_text(cells[index["% of portfolio"]])),
            "activity": cell_text(cells[index["Recent activity"]]),
        })
    return holders


# --- the symbol selection ----------------------------------------------------------------


def select_symbols(conn: sqlite3.Connection) -> list[str]:
    """The symbols worth a page view: step-4 survivors of the latest snapshot + quarter buys.

    Step 4 is evaluated by the canonical screening engine (rule 19), never re-implemented
    here; the quarter buys come from the newest ``recent_buys_q`` quarter.
    """
    symbols = set(_step_four_symbols(conn))
    quarter = conn.execute("SELECT MAX(quarter) FROM recent_buys_q").fetchone()[0]
    if quarter:
        symbols.update(
            row[0] for row in conn.execute(
                "SELECT DISTINCT normalized_symbol FROM recent_buys_q WHERE quarter = ?", (quarter,)
            ) if row[0]
        )
    return sorted(symbols)[:MAX_SYMBOLS_PER_RUN]


def _step_four_symbols(conn: sqlite3.Connection) -> list[str]:
    """The snapshot symbols that answer the funnel's fourth question ("¿cayó?")."""
    rows = load_snapshot(conn)
    if not rows:
        return []
    params = resolve_params(None)
    context = {
        "sectorPe": sector_median_pe(rows),
        "dataroma": load_dataroma(conn),
        "aaa": load_aaa_yield(conn)[0],
    }
    return [
        row["symbol"] for row in rows
        if evaluate_row(row, params, context)["_passes"][STEP_CAIDA]
    ]


# --- the DTO -----------------------------------------------------------------------------


@dataclass(frozen=True)
class HoldingsRecord:
    """One symbol's superinvestor ownership, or the page that could not be read (``error``)."""

    symbol: str
    normalized_symbol: str
    holders: int = 0
    holders_prev: int | None = None
    max_portfolio_pct: float | None = None
    avg_hold_price: float | None = None
    net_activity: int = 0
    top_holders: tuple[dict, ...] = ()
    error: str | None = None

    def columns(self) -> dict:
        """The stock_superinvestor_holdings column values of this symbol."""
        return {
            "symbol": self.normalized_symbol,
            "holders": self.holders,
            "holders_prev": self.holders_prev,
            "max_portfolio_pct": self.max_portfolio_pct,
            "avg_hold_price": self.avg_hold_price,
            "net_activity": self.net_activity,
            "top_holders": json.dumps(list(self.top_holders), ensure_ascii=False),
            "fetched_at": utc_now(),
        }


class DataromaHoldingsSource(DataromaSource):
    """Dataroma's per-stock ownership page, for the symbols the funnel cares about."""

    source_code = "dataroma_holdings"
    display_name = "Dataroma – tenencia de superinversores"
    url = STOCK_URL

    def __init__(self, *, symbols: Sequence[str] | None = None, fetcher: object | None = None) -> None:
        super().__init__(fetcher=fetcher)
        self._symbols = list(symbols) if symbols is not None else None
        self._conn: sqlite3.Connection | None = None

    def sync(self, conn: sqlite3.Connection, trigger: str = "cli"):
        """Keep the connection the selection needs, then run the shared sync contract."""
        self._conn = conn
        return super().sync(conn, trigger)

    def fetch(self) -> list[tuple[str, str, str]]:
        """Return [(symbol, url, html)] for each selected symbol, one request at a time (S11)."""
        symbols = self._symbols
        if symbols is None:
            if self._conn is None:
                raise SourceError("no symbols given and no connection to select them from")
            symbols = select_symbols(self._conn)
        pages = []
        for symbol in symbols[:MAX_SYMBOLS_PER_RUN]:
            url = stock_url(symbol)
            pages.append((symbol, url, self.fetcher.get_text(url)))  # type: ignore[attr-defined]
        return pages

    def normalize(self, raw: Sequence[tuple[str, str, str]]) -> list[HoldingsRecord]:
        """Parse every fetched page; a page that changed shape becomes a rejected record."""
        records = []
        for symbol, url, html in raw:
            try:
                records.append(self._record(symbol, url, html))
            except SourceError as exc:
                records.append(HoldingsRecord(symbol, normalize_ticker(symbol.upper()), error=str(exc)))
        return records

    def _record(self, symbol: str, url: str, html: str) -> HoldingsRecord:
        """Build one DTO from a stock page (raises SourceError on unexpected HTML)."""
        soup = soup_of(html)
        holders = parse_holders(soup, url)
        percentages = [entry["pct"] for entry in holders if entry["pct"] is not None]
        ranked = sorted(holders, key=lambda entry: entry["pct"] or -1.0, reverse=True)
        return HoldingsRecord(
            symbol=symbol.upper(),
            normalized_symbol=normalize_ticker(symbol.upper()),
            holders=parse_ownership_count(soup, url),
            holders_prev=None,  # the page does not publish the previous quarter's count
            max_portfolio_pct=max(percentages) if percentages else None,
            avg_hold_price=parse_hold_price(soup),
            net_activity=sum(activity_sign(entry["activity"]) for entry in holders),
            top_holders=tuple(ranked[:TOP_HOLDERS]),
        )

    def validate(self, items: Sequence[HoldingsRecord]) -> tuple[list[HoldingsRecord], list[dict]]:
        """Drop the pages that could not be read and any repeated symbol."""
        valid: list[HoldingsRecord] = []
        rejected: list[dict] = []
        seen: set[str] = set()
        for item in items:
            if item.error:
                rejected.append({"symbol": item.symbol, "reason": item.error})
                continue
            if item.normalized_symbol in seen:
                rejected.append({"symbol": item.symbol, "reason": "duplicate_symbol"})
                continue
            seen.add(item.normalized_symbol)
            valid.append(item)
        return valid, rejected

    def upsert(self, items: Sequence[HoldingsRecord], conn: sqlite3.Connection) -> dict:
        """Insert or refresh one row per symbol (PK symbol); never delete, never deactivate."""
        counts = {"inserted": 0, "updated": 0, "reactivated": 0, "deactivated": 0}
        for item in items:
            values = item.columns()
            changeable = [column for column in values if column != "symbol"]
            cursor = conn.execute(
                f"UPDATE {TABLE} SET {', '.join(f'{c} = ?' for c in changeable)} WHERE symbol = ?",
                [*(values[column] for column in changeable), values["symbol"]],
            )
            if cursor.rowcount:
                counts["updated"] += 1
                continue
            conn.execute(
                f"INSERT INTO {TABLE} ({', '.join(values)}) "
                f"VALUES ({', '.join('?' for _ in values)})",
                list(values.values()),
            )
            counts["inserted"] += 1
        return counts


__all__ = [
    "COLUMNS", "MAX_SYMBOLS_PER_RUN", "MIN_REQUEST_INTERVAL_SECONDS", "TABLE", "TOP_HOLDERS",
    "DataromaHoldingsSource", "HoldingsRecord", "activity_sign", "parse_holders",
    "parse_hold_price", "parse_ownership_count", "select_symbols", "stock_url",
]
