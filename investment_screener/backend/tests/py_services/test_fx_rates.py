"""
test_fx_rates.py — fx_rates.py resolution order, fallback and unavailability.

Purpose:
    The portfolio summary converts each profile's base currency to USD. A rate is
    either read (TradingView first, yfinance second) or the currency is reported as
    unavailable — it is never invented, and never silently 1.0.
Layer: Backend / Tests / Python services (no network: both fetchers are injected).
Usage: /usr/bin/python3.10 -m pytest investment_screener/backend/tests/py_services/test_fx_rates.py -q
"""
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
SCRIPT_DIR = REPO_ROOT / "investment_screener/backend/py_services"
sys.path.insert(0, str(SCRIPT_DIR))

import fx_rates  # noqa: E402


def test_usd_needs_no_fetch_and_is_rate_one():
    calls = []
    result = fx_rates.fx_rates(
        ["USD"],
        tv_fetcher=lambda cur: calls.append(cur),
        yf_fetcher=lambda cur: calls.append(cur),
    )
    assert calls == []
    assert result["rates"]["USD"]["usd_to"] == 1.0
    assert result["rates"]["USD"]["source"] == "identity"
    assert result["unavailable"] == []


def test_tradingview_rate_is_preferred_and_yfinance_not_called():
    yf_calls = []
    result = fx_rates.fx_rates(
        ["CLP"],
        tv_fetcher=lambda cur: 948.2,
        yf_fetcher=lambda cur: yf_calls.append(cur),
    )
    assert result["rates"]["CLP"]["usd_to"] == 948.2
    assert result["rates"]["CLP"]["source"] == "tradingview"
    assert result["rates"]["CLP"]["as_of"]
    assert yf_calls == []
    assert result["unavailable"] == []


def test_yfinance_fallback_when_tradingview_has_no_quote():
    result = fx_rates.fx_rates(["CLP"], tv_fetcher=lambda cur: None, yf_fetcher=lambda cur: 950.0)
    assert result["rates"]["CLP"]["usd_to"] == 950.0
    assert result["rates"]["CLP"]["source"] == "yfinance"


def test_tradingview_exception_falls_back_instead_of_failing():
    def boom(cur):
        raise RuntimeError("CDP down")

    result = fx_rates.fx_rates(["CLP"], tv_fetcher=boom, yf_fetcher=lambda cur: 951.5)
    assert result["rates"]["CLP"]["usd_to"] == 951.5
    assert result["rates"]["CLP"]["source"] == "yfinance"


def test_currency_without_any_quote_is_unavailable_never_invented():
    result = fx_rates.fx_rates(
        ["CLP", "EUR"],
        tv_fetcher=lambda cur: None if cur == "EUR" else 948.2,
        yf_fetcher=lambda cur: None,
    )
    assert "EUR" not in result["rates"]
    assert result["unavailable"] == ["EUR"]
    assert result["rates"]["CLP"]["usd_to"] == 948.2


def test_non_positive_rate_is_rejected_as_unavailable():
    result = fx_rates.fx_rates(["CLP"], tv_fetcher=lambda cur: 0, yf_fetcher=lambda cur: -3)
    assert result["rates"] == {}
    assert result["unavailable"] == ["CLP"]


def test_currencies_are_normalized_and_deduplicated():
    seen = []

    def tv(cur):
        seen.append(cur)
        return 948.2

    result = fx_rates.fx_rates([" clp ", "CLP", "usd"], tv_fetcher=tv, yf_fetcher=lambda cur: None)
    assert seen == ["CLP"]
    assert sorted(result["rates"]) == ["CLP", "USD"]


def test_parse_currencies_splits_the_cli_argument():
    assert fx_rates.parse_currencies("CLP,EUR , usd") == ["CLP", "EUR", "USD"]
    assert fx_rates.parse_currencies("") == []
