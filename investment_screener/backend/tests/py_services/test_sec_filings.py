"""test_sec_filings.py - EDGAR filings list for the Filings tab (S12). No network: fetchers are injected."""
import json
import sys
from pathlib import Path

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))
FIX = Path(__file__).parent / "fixtures" / "edgar"

from ticker_aliases import normalize_ticker  # noqa: E402
from sec_filings import NO_TRANSCRIPTS, build_filings, fiscal_period  # noqa: E402

SUBS = json.loads((FIX / "submissions_msft.json").read_text())


def test_payload_shape_total_and_forms():
    out = build_filings("MSFT", cik_fn=lambda t: "0000789019", submissions_fn=lambda c: SUBS)
    assert out["ticker"] == "MSFT" and out["cik"] == "0000789019"
    assert out["earnings_calls"] == {"available": False, "reason": "Sin fuente gratuita de transcripciones"} 
    sf = out["sec_filings"]
    assert sf["total"] == 5 == len(sf["items"])  # SC 13G is not a tracked form
    assert [i["form"] for i in sf["items"]] == ["10-K", "10-Q", "8-K", "DEF 14A", "10-Q"]
    assert set(sf["items"][0]) == {"form", "title", "filed", "period", "fiscal_year", "fiscal_quarter", "url"}


def test_url_filed_period_and_title():
    first = build_filings("MSFT", cik_fn=lambda t: "0000789019", submissions_fn=lambda c: SUBS)["sec_filings"]["items"][0]
    assert first["url"] == "https://www.sec.gov/Archives/edgar/data/789019/000095017025100001/msft-20250630.htm"
    assert first["filed"] == "2025-07-30" and first["period"] == "2025-06-30"
    assert first["title"] == "10-K"
    eightk = build_filings("MSFT", cik_fn=lambda t: "0000789019", submissions_fn=lambda c: SUBS)["sec_filings"]["items"][2]
    assert eightk["title"] == "8-K — Current report"


def test_fiscal_period_rule_june_year_end():
    assert fiscal_period("2025-06-30", "0630", "10-K") == (2025, None)       # annual form: no quarter
    assert fiscal_period("2025-03-31", "0630", "10-Q") == (2025, 3)
    assert fiscal_period("2024-09-30", "0630", "10-Q") == (2025, 1)          # month after FYE month -> next FY
    assert fiscal_period("2025-04-08", "0630", "8-K") == (2025, 4)


def test_fiscal_period_calendar_year_and_missing_inputs():
    assert fiscal_period("2025-03-31", "1231", "10-Q") == (2025, 1)
    assert fiscal_period("2025-12-31", "1231", "10-Q") == (2025, 4)
    assert fiscal_period("2025-03-31", None, "10-Q") == (2025, 1)            # unknown FYE defaults to December
    assert fiscal_period("", "1231", "10-Q") == (None, None)


def test_missing_report_date_falls_back_to_filing_date():
    item = build_filings("MSFT", cik_fn=lambda t: "0000789019", submissions_fn=lambda c: SUBS)["sec_filings"]["items"][3]
    assert item["form"] == "DEF 14A" and item["period"] is None
    assert (item["fiscal_year"], item["fiscal_quarter"]) == (2025, 2)  # October filing: Jul-Sep is Q1


def test_unknown_ticker_or_failed_submissions_is_empty_not_error():
    empty = {"total": 0, "items": []}
    out = build_filings("SHOP.TO", cik_fn=lambda t: None, submissions_fn=lambda c: SUBS)
    assert out["cik"] is None and out["sec_filings"] == empty and out["earnings_calls"]["available"] is False
    out = build_filings("MSFT", cik_fn=lambda t: "0000789019", submissions_fn=lambda c: None)
    assert out["sec_filings"] == empty and out["cik"] == "0000789019"


def test_ticker_is_normalized_before_lookup():
    seen = []
    build_filings("PSU-U.TO", cik_fn=lambda t: seen.append(t), submissions_fn=lambda c: SUBS)
    assert seen == [normalize_ticker("PSU-U.TO")]
