#!/usr/bin/env python3
"""
sec_filings.py - SEC filings list for one ticker (Filings tab, S12).

Purpose:
    Lists the company's recent EDGAR filings (10-K, 10-Q, 8-K, DEF 14A, 20-F, 6-K, 40-F) from
    the submissions payload, newest first. `total` is the count of those forms in EDGAR's
    "recent" list (about the last 1000 filings), not the company's lifetime total. A ticker
    without a CIK (non-US, unknown) or a failed EDGAR call returns empty data, never an error.
    There is no free source of earnings-call transcripts: `earnings_calls` says so.

    Fiscal period rule (fiscal_period): the report date (reportDate, else the filing date) and
    the company's fiscalYearEnd (MMDD, default December). A fiscal year is named for the
    calendar year in which it ends: fiscal_year = year, +1 when the report month is after the
    fiscal-year-end month. fiscal_quarter = ((month - fye_month - 1) mod 12) // 3 + 1, i.e.
    the three months after the year-end month are Q1. Annual forms (10-K, 20-F, 40-F) get
    quarter None. Months are used, not days, so 52/53-week calendars land in the right quarter.

Layer:
    Backend / Python Services / SEC EDGAR

Usage Examples:
    python3 sec_filings.py MSFT

Key Functions (Index):
    - fiscal_period(report_date, fiscal_year_end, form) - (fiscal_year, fiscal_quarter)
    - build_filings(ticker, cik_fn, submissions_fn) - the endpoint payload

Key Input Dependencies:
    - edgar_facts.lookup_cik / get_submissions / accession_url (the one EDGAR client)

Key Output Dependencies:
    - routes/stock.ts (GET /api/stock/:ticker/filings, cached 12h)
"""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from edgar_facts import accession_url, get_submissions, lookup_cik  # noqa: E402
from ticker_aliases import normalize_ticker  # noqa: E402

FORMS = ("10-K", "10-Q", "8-K", "DEF 14A", "20-F", "6-K", "40-F")
ANNUAL_FORMS = ("10-K", "20-F", "40-F")
NO_TRANSCRIPTS = {"available": False, "reason": "Sin fuente gratuita de transcripciones"}


def fiscal_period(report_date: str, fiscal_year_end: str | None, form: str) -> tuple[int | None, int | None]:
    """(fiscal_year, fiscal_quarter) for a report date; see the module docstring for the rule."""
    if not report_date:
        return None, None
    year, month = int(report_date[:4]), int(report_date[5:7])
    fye_month = int(fiscal_year_end[:2]) if fiscal_year_end and len(fiscal_year_end) >= 2 and fiscal_year_end[:2].isdigit() else 12
    fiscal_year = year + (1 if month > fye_month else 0)
    quarter = None if form in ANNUAL_FORMS else ((month - fye_month - 1) % 12) // 3 + 1
    return fiscal_year, quarter


def build_filings(ticker: str, cik_fn=lookup_cik, submissions_fn=get_submissions) -> dict:
    """Endpoint payload for one ticker; fetchers are injectable for offline tests."""
    symbol = normalize_ticker(ticker.upper())
    empty = {"ticker": symbol, "cik": None, "sec_filings": {"total": 0, "items": []}, "earnings_calls": dict(NO_TRANSCRIPTS)}
    cik = cik_fn(symbol)
    if not cik:
        return empty
    empty["cik"] = cik
    subs = submissions_fn(cik)
    if not subs:
        return empty
    recent = subs.get("filings", {}).get("recent", {})
    fye = subs.get("fiscalYearEnd")
    items = []
    for i, form in enumerate(recent.get("form", [])):
        if form not in FORMS:
            continue
        filed = recent["filingDate"][i]
        period = recent["reportDate"][i] or None
        desc = recent["primaryDocDescription"][i] if i < len(recent.get("primaryDocDescription", [])) else ""
        fiscal_year, fiscal_quarter = fiscal_period(period or filed, fye, form)
        items.append({
            "form": form,
            "title": f"{form} — {desc}" if desc and desc != form else form,
            "filed": filed,
            "period": period,
            "fiscal_year": fiscal_year,
            "fiscal_quarter": fiscal_quarter,
            "url": accession_url(cik, recent["accessionNumber"][i], recent["primaryDocument"][i]),
        })
    empty["sec_filings"] = {"total": len(items), "items": items}
    return empty


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "ticker required"}))
        sys.exit(1)
    try:
        print(json.dumps(build_filings(sys.argv[1])))
    except Exception as e:
        print(json.dumps({"error": "failed", "message": str(e)}))


if __name__ == "__main__":
    main()
