"""
test_fetch_financials_overview.py - fetch_financial_data adds `overview` to the
payload and keeps every existing top-level key (fake yfinance Ticker, no network).
"""
import io
import json
import sys
from contextlib import redirect_stdout
from pathlib import Path

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch_financials  # noqa: E402
from test_company_overview import FakeTicker  # noqa: E402

EXISTING = {"symbol", "price", "currency", "profile", "metrics", "performance", "expert_metrics", "financials",
            "analyst_revenue_forecast", "analyst_earnings_forecast", "growth_estimates", "analyst_estimates",
            "periodBasis", "dataQualityFlags"}


def _run(monkeypatch, ticker):
    ticker.financials = ticker.income_stmt
    for name in ("quarterly_financials", "quarterly_cashflow"):
        setattr(ticker, name, getattr(ticker, "quarterly_income_stmt"))
    monkeypatch.setattr(fetch_financials.yf, "Ticker", lambda s: ticker)
    monkeypatch.setattr(fetch_financials, "get_cached_data", lambda s: None)
    monkeypatch.setattr(fetch_financials, "save_to_cache", lambda s, d: None)
    buf = io.StringIO()
    with redirect_stdout(buf):
        fetch_financials.fetch_financial_data("ACME", no_cache=True)
    return json.loads(buf.getvalue())


def test_payload_has_overview_and_keeps_existing_keys(monkeypatch):
    out = _run(monkeypatch, FakeTicker())
    assert EXISTING <= set(out)
    assert out["overview"]["profile"]["name"] == "Acme Corp"
    assert out["overview"]["multiples"]["ev_sales"] is not None


def test_overview_failure_never_breaks_payload(monkeypatch):
    def boom(stock):
        raise RuntimeError("x")
    monkeypatch.setattr(fetch_financials, "build_overview", boom)
    out = _run(monkeypatch, FakeTicker())
    assert EXISTING <= set(out) and out["overview"] is None
