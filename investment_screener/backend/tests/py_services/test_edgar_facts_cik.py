"""test_edgar_facts_cik.py - edgar_facts CIK lookup, submissions, JSON/text fetch helpers (T5/T6). No network."""
import json
import sys
from pathlib import Path
from unittest.mock import MagicMock, patch

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))
FIX = Path(__file__).parent / "fixtures" / "edgar"

import edgar_facts  # noqa: E402
from edgar_facts import accession_url, get_json, get_text, lookup_cik, lookup_company_name  # noqa: E402


def resp(status=200, payload=None, text=""):
    r = MagicMock()
    r.status_code = status
    r.json.return_value = payload
    r.text = text
    return r


def test_lookup_cik_pads_and_maps_dot_to_dash(tmp_path, monkeypatch):
    monkeypatch.setattr("cache.DB_PATH", tmp_path / "c.sqlite")
    payload = json.loads((FIX / "company_tickers.json").read_text())
    with patch("edgar_facts.requests.get", return_value=resp(payload=payload)) as g:
        assert lookup_cik("msft") == "0000789019"
        assert lookup_cik("BRK.B") == "0001067983"
    assert g.call_count == 1  # the ticker map is cached after the first fetch


def test_lookup_company_name(tmp_path, monkeypatch):
    monkeypatch.setattr("cache.DB_PATH", tmp_path / "c.sqlite")
    payload = json.loads((FIX / "company_tickers.json").read_text())
    with patch("edgar_facts.requests.get", return_value=resp(payload=payload)):
        assert lookup_company_name("MSFT") == "MICROSOFT CORP"
        assert lookup_company_name("ZZZZ") is None


def test_lookup_cik_unknown_or_non_us_is_none(tmp_path, monkeypatch):
    monkeypatch.setattr("cache.DB_PATH", tmp_path / "c.sqlite")
    payload = json.loads((FIX / "company_tickers.json").read_text())
    with patch("edgar_facts.requests.get", return_value=resp(payload=payload)):
        assert lookup_cik("SHOP.TO") is None
        assert lookup_cik("ZZZZ") is None


def test_get_json_and_text_return_none_on_non_200():
    with patch("edgar_facts.requests.get", return_value=resp(404)):
        assert get_json("https://x") is None
        assert get_text("https://x") is None
    with patch("edgar_facts.requests.get", return_value=resp(200, {"a": 1}, "<x/>")):
        assert get_json("https://x") == {"a": 1}
        assert get_text("https://x") == "<x/>"


def test_user_agent_is_declared_for_www_and_overridable(monkeypatch):
    assert "@" in edgar_facts.USER_AGENT and "localhost" != edgar_facts.USER_AGENT.split("@")[-1]
    monkeypatch.setenv("SEC_EDGAR_USER_AGENT", "Me me@example.org")
    import importlib
    try:
        assert importlib.reload(edgar_facts).USER_AGENT == "Me me@example.org"
    finally:
        monkeypatch.delenv("SEC_EDGAR_USER_AGENT")
        importlib.reload(edgar_facts)


def test_accession_url():
    assert accession_url("0000789019", "0000950170-25-100001", "msft.htm") == \
        "https://www.sec.gov/Archives/edgar/data/789019/000095017025100001/msft.htm"
