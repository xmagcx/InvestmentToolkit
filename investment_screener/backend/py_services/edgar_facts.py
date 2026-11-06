#!/usr/bin/env python3
"""
edgar_facts.py - Python utility script.

Purpose:
    SEC EDGAR XBRL companyfacts client. Point-in-time-correct fundamentals
    (each datapoint carries its actual filing date) for US filers only —
    yfinance is the fallback/supplement for non-US listings in market_data.py.

Layer:
    Backend / Python Services

Usage Examples:
    TBD

Key Functions (Index):
    - _throttled_get()
    - get_json() / get_text() - throttled GET helpers shared by sec_filings.py and superinvestors.py
    - lookup_cik() / lookup_company_name() - ticker -> CIK / title from SEC company_tickers.json
    - get_submissions() / accession_url() - filings list and archive document URL
    - _extract_metric()
    - get_company_facts()
    - main()

Key Input Dependencies:
    None

Key Output Dependencies:
    None
"""
import os
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cache import cache_get, cache_set  # noqa: E402

# www.sec.gov (company_tickers.json, Archives/) answers 403 to a contact without a
# dotted domain such as "@localhost"; data.sec.gov accepts it. Override with
# SEC_EDGAR_USER_AGENT="Name you@email.com" (same variable the 13F skill reads).
USER_AGENT = os.environ.get("SEC_EDGAR_USER_AGENT", "InvestmentToolkit research@localhost.local")

# revenue tries "Revenues" first; many large issuers (including real recent
# Apple filings) report top-line revenue under
# RevenueFromContractWithCustomerExcludingAssessedTax instead — falling back
# silently to nothing when the primary tag is absent would quietly defeat
# EDGAR for a large fraction of real tickers. netIncome/operatingIncome do
# not have the same well-known alternate-tag problem, so they stay
# single-tag.
_TAG_MAP = {
    "revenue": ("Revenues", "RevenueFromContractWithCustomerExcludingAssessedTax"),
    "netIncome": ("NetIncomeLoss",),
    "operatingIncome": ("OperatingIncomeLoss",),
}

# SEC asks automated clients to stay under 10 requests/second. This is a
# single-process CLI script, not a server under concurrent load — caching
# (see get_company_facts()) is what actually keeps repeat calls off the
# network; this floor is defense-in-depth for genuinely different CIKs
# requested in a tight loop (e.g. a future batch migration).
_MIN_REQUEST_INTERVAL_SECONDS = 0.15
_last_request_time = 0.0


def _throttled_get(url: str):
    """Issue a GET request to SEC EDGAR, enforcing a minimal client-side rate limit.

    Sleeps just long enough to keep at least _MIN_REQUEST_INTERVAL_SECONDS
    between actual network calls. Only ever invoked on a cache miss — cache
    hits never touch this function and are never throttled.

    Args:
        url: Fully-formed request URL.

    Returns:
        The `requests.Response` object.
    """
    global _last_request_time
    elapsed = time.monotonic() - _last_request_time
    if elapsed < _MIN_REQUEST_INTERVAL_SECONDS:
        time.sleep(_MIN_REQUEST_INTERVAL_SECONDS - elapsed)
    resp = requests.get(url, headers={"User-Agent": USER_AGENT})
    _last_request_time = time.monotonic()
    return resp


def get_json(url: str) -> dict | None:
    """Throttled GET returning the parsed JSON body, or None on any non-200 status."""
    resp = _throttled_get(url)
    return resp.json() if resp.status_code == 200 else None


def get_text(url: str) -> str | None:
    """Throttled GET returning the body text, or None on any non-200 status."""
    resp = _throttled_get(url)
    return resp.text if resp.status_code == 200 else None


def _company_row(ticker: str) -> list | None:
    """[zero-padded CIK, company title] for a ticker from SEC company_tickers.json, or None."""
    mapping = cache_get("company-tickers-v2", "edgar")
    if mapping is None:
        payload = get_json("https://www.sec.gov/files/company_tickers.json")
        if payload is None:
            return None
        mapping = {row["ticker"].upper(): [str(row["cik_str"]).zfill(10), row["title"]] for row in payload.values()}
        cache_set("company-tickers-v2", "edgar", mapping)
    return mapping.get(ticker.upper().replace(".", "-"))


def lookup_cik(ticker: str) -> str | None:
    """Zero-padded 10-digit CIK for a US-listed ticker, or None (non-US / unknown).

    EDGAR writes share classes with a dash (BRK-B), so dots are mapped to dashes. The whole
    ticker map is cached with the "edgar" TTL, so a lookup costs one request per week.
    """
    row = _company_row(ticker)
    return row[0] if row else None


def lookup_company_name(ticker: str) -> str | None:
    """EDGAR company title for a US-listed ticker (e.g. "MICROSOFT CORP"), or None."""
    row = _company_row(ticker)
    return row[1] if row else None


def get_submissions(cik: str) -> dict | None:
    """The company's EDGAR submissions payload (recent filings), uncached so new filings show up."""
    return get_json(f"https://data.sec.gov/submissions/CIK{cik.zfill(10)}.json")


def accession_url(cik: str, accession: str, document: str) -> str:
    """EDGAR archive URL of one filing document."""
    return f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/{document}"


def _extract_metric(gaap: dict, tags: tuple) -> dict | None:
    """Try each candidate GAAP tag in order, returning the first usable record.

    For the value: only the latest **10-K** (annual) record is used — this
    function never changes what number is reported. For the `asOf` date:
    the most recent filing of **either** form (10-K or 10-Q) for that same
    tag is used, decoupling "how fresh is our knowledge of this company"
    from "what period the reported figure covers". A company actively
    filing quarterly 10-Qs between annual reports correctly reads as
    fresh via check_staleness(), even though the reported value itself is
    still the annual figure from the last 10-K.

    Args:
        gaap: The 'us-gaap' facts dict from the companyfacts response.
        tags: Candidate GAAP tags to try, in priority order.

    Returns:
        Dict with 'value' (float) and 'asOf' (filing date string), or None
        if no candidate tag yielded a usable 10-K value.
    """
    for tag in tags:
        units = gaap.get(tag, {}).get("units", {}).get("USD", [])
        annual = [u for u in units if u.get("form") == "10-K"]
        if not annual:
            continue
        latest_annual = max(annual, key=lambda u: u.get("end", ""))

        # Skip this candidate tag if 'val' is missing or cannot be converted
        # to float — try the next tag rather than giving up on the metric.
        val = latest_annual.get("val")
        if val is None:
            continue
        try:
            numeric_val = float(val)
        except (TypeError, ValueError):
            continue

        quarterly_and_annual = [u for u in units if u.get("form") in ("10-K", "10-Q")]
        latest_filing = max(quarterly_and_annual, key=lambda u: u.get("filed", ""))
        as_of = (
            latest_filing.get("filed")
            or latest_filing.get("end")
            or latest_annual.get("filed")
            or latest_annual.get("end")
        )

        return {"value": numeric_val, "asOf": as_of}

    return None


def get_company_facts(cik: str) -> dict:
    """Fetch SEC EDGAR XBRL company facts for a given CIK.

    Cache-first (7-day TTL, "edgar" data class in cache.py) — a repeated call
    for the same CIK within 7 days never touches the network. On a cache
    miss, the request is issued through _throttled_get() to stay comfortably
    under SEC's 10 requests/second guidance.

    Args:
        cik: Central Index Key (10-digit CIK string or unpadded integer).

    Returns:
        dict: Mapping of metric keys (e.g., 'revenue', 'netIncome') to dicts with
              'value' (float) and 'asOf' (filing date string). Metrics with missing
              or malformed values are excluded (not zeroed).
    """
    padded_cik = cik.zfill(10)

    cached = cache_get(padded_cik, "edgar")
    if cached is not None:
        return cached

    url = f"https://data.sec.gov/api/xbrl/companyfacts/CIK{padded_cik}.json"
    resp = _throttled_get(url)
    if resp.status_code != 200:
        return {}

    data = resp.json()
    gaap = data.get("facts", {}).get("us-gaap", {})

    result = {}
    for key, tags in _TAG_MAP.items():
        metric = _extract_metric(gaap, tags)
        if metric is not None:
            result[key] = metric

    cache_set(padded_cik, "edgar", result)
    return result


def main():
    """CLI entry point: fetch and print company facts JSON for a given CIK."""
    if len(sys.argv) < 2:
        print('{"error": "cik required"}')
        sys.exit(1)
    import json
    print(json.dumps(get_company_facts(sys.argv[1]), indent=2))


if __name__ == "__main__":
    main()
