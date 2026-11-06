"""test_superinvestors.py - 13F superinvestors for the Inversores tab (S11). No network: fetchers are injected."""
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
PY = REPO_ROOT / "investment_screener/backend/py_services"
sys.path.insert(0, str(PY))
FIX = Path(__file__).parent / "fixtures" / "edgar"

import superinvestors as si  # noqa: E402
from superinvestors import (  # noqa: E402
    DELAY_NOTE, build_superinvestors, classify_action, cusip_from_isin, load_managers, parse_info_table,
    resolve_cusip_by_name,
)

CURRENT = (FIX / "infotable_current.xml").read_text()
PREVIOUS = (FIX / "infotable_previous.xml").read_text()
MSFT = "594918104"


def test_cusip_from_isin_us_and_ca_only():
    assert cusip_from_isin("US5949181045") == "594918104"
    assert cusip_from_isin("CA82509L1076") == "82509L107"
    assert cusip_from_isin("IE00B4BNMY34") is None
    assert cusip_from_isin("-") is None and cusip_from_isin(None) is None and cusip_from_isin("US123") is None


def test_parse_info_table_sums_rows_ignores_options_and_bonds():
    t = parse_info_table(CURRENT, filed="2025-05-01")
    assert t["holdings"][MSFT]["shares"] == 2000          # 1000+500+500, call and PRN rows excluded
    assert t["holdings"][MSFT]["value"] == 800000
    assert t["total_value"] == 2800000                    # every row counts toward the portfolio, options and bonds included
    assert t["holdings"]["037833100"]["shares"] == 4000


def test_parse_info_table_value_units_thousands_before_2023():
    t = parse_info_table(PREVIOUS, filed="2022-11-14")
    assert t["holdings"][MSFT]["value"] == 160000 * 1000
    assert t["total_value"] == 1000000 * 1000
    assert parse_info_table(PREVIOUS, filed="2023-01-03")["total_value"] == 1000000


@pytest.mark.parametrize("now,prev,action,pct", [
    (1005, 1000, "add", 0.5),       # +0.5% is the boundary: already an add
    (1004, 1000, "hold", 0.4),
    (996, 1000, "hold", -0.4),
    (995, 1000, "reduce", -0.5),    # -0.5% is the boundary: already a reduce
    (1500, 1000, "add", 50.0),
    (500, 1000, "reduce", -50.0),
    (0, 1000, "sold_out", -100.0),
    (1000, 0, "new", None),
])
def test_classify_action_boundaries(now, prev, action, pct):
    got_action, got_pct = classify_action(now, prev)
    assert got_action == action
    assert got_pct == (pytest.approx(pct) if pct is not None else None)


def test_classify_action_without_previous_filing_is_hold():
    assert classify_action(1000, None, has_previous=False) == ("hold", None)


def make_fetch(managers_data):
    """managers_data: cik -> list of (accession, report_date, filed, xml) newest first, or Exception."""
    def get_json(url):
        for cik, data in managers_data.items():
            if f"CIK{int(cik):010d}.json" in url:
                if isinstance(data, Exception):
                    raise data
                return {"filings": {"recent": {
                    "form": ["13F-HR"] * len(data) + ["8-K"],
                    "accessionNumber": [d[0] for d in data] + ["x"],
                    "reportDate": [d[1] for d in data] + [""],
                    "filingDate": [d[2] for d in data] + ["2025-01-01"],
                }}}
            if "index.json" in url and f"/data/{int(cik)}/" in url:
                return json.loads((FIX / "filing_index.json").read_text())
        return None

    def get_text(url):
        for cik, data in managers_data.items():
            for acc, _r, _f, xml in data if not isinstance(data, Exception) else []:
                if f"/data/{int(cik)}/{acc.replace('-', '')}/56757.xml" in url:
                    return xml
        return None
    return get_json, get_text


MANAGERS = [
    {"manager": "Ann A", "fund": "Alpha Fund", "cik": "1"},
    {"manager": "Bob B", "fund": "Beta Fund", "cik": "2"},
    {"manager": "Cy C", "fund": "Gamma Fund", "cik": "3"},
    {"manager": "Di D", "fund": "Delta Fund", "cik": "4"},
]
EMPTY_NOW = CURRENT.replace(MSFT, "000000000")


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr("cache.DB_PATH", tmp_path / "c.sqlite")


def run(data, **kw):
    gj, gt = make_fetch(data)
    return build_superinvestors("MSFT", managers=MANAGERS, isin_fn=lambda t: "US5949181045", get_json=gj, get_text=gt, **kw)


def test_holders_buying_selling_and_items():
    data = {
        1: [("0000000001-25-000002", "2025-03-31", "2025-05-01", CURRENT), ("0000000001-25-000001", "2024-12-31", "2025-02-01", PREVIOUS)],   # 1600 -> 2000: add
        2: [("0000000002-25-000002", "2025-03-31", "2025-05-01", EMPTY_NOW), ("0000000002-25-000001", "2024-12-31", "2025-02-01", PREVIOUS)],   # sold out
        3: [("0000000003-25-000002", "2025-03-31", "2025-05-01", CURRENT), ("0000000003-25-000001", "2024-12-31", "2025-02-01", EMPTY_NOW)],   # new
        4: [("0000000004-25-000002", "2025-03-31", "2025-05-01", EMPTY_NOW), ("0000000004-25-000001", "2024-12-31", "2025-02-01", EMPTY_NOW)], # never held
    }
    out = run(data)
    assert out["ticker"] == "MSFT" and out["cusip"] == MSFT and out["delay_note"] == DELAY_NOTE
    assert (out["holders"], out["buying"], out["selling"]) == (2, 2, 1)
    assert out["quarter_latest"] == "2025-Q1"
    by = {i["manager"]: i for i in out["items"]}
    assert set(by) == {"Ann A", "Cy C", "Bob B"}
    assert by["Ann A"]["action"] == "add" and by["Ann A"]["change_pct"] == pytest.approx(25.0)
    assert by["Ann A"]["shares"] == 2000 and by["Ann A"]["portfolio_pct"] == pytest.approx(800000 / 2800000 * 100)
    assert by["Ann A"]["fund"] == "Alpha Fund" and by["Ann A"]["cik"] == "1" and by["Ann A"]["quarter"] == "2025-Q1"
    assert by["Cy C"]["action"] == "new" and by["Cy C"]["change_pct"] is None
    assert by["Bob B"]["action"] == "sold_out" and by["Bob B"]["shares"] == 0 and by["Bob B"]["portfolio_pct"] == 0
    assert [i["manager"] for i in out["items"]][0] in ("Ann A", "Cy C")  # sorted by portfolio_pct desc
    assert out["errors"] == []


def test_unknown_cusip_is_empty_and_fetches_nothing():
    gj, gt = make_fetch({})
    calls = []
    out = build_superinvestors("ZZZZ", managers=MANAGERS, isin_fn=lambda t: None, name_fn=lambda t: None,
                               get_json=lambda u: calls.append(u), get_text=lambda u: calls.append(u))
    assert out["cusip"] is None and out["items"] == [] and (out["holders"], out["buying"], out["selling"]) == (0, 0, 0)
    assert out["quarter_latest"] is None and out["delay_note"] == DELAY_NOTE and calls == []


def test_manager_failure_is_skipped_and_reported():
    data = {
        1: [("0000000001-25-000002", "2025-03-31", "2025-05-01", CURRENT), ("0000000001-25-000001", "2024-12-31", "2025-02-01", PREVIOUS)],
        2: RuntimeError("EDGAR down"),
    }
    out = run(data)
    assert [i["manager"] for i in out["items"]] == ["Ann A"]
    assert out["holders"] == 1
    assert {e["manager"] for e in out["errors"]} >= {"Bob B"}
    assert "EDGAR down" in [e for e in out["errors"] if e["manager"] == "Bob B"][0]["error"]


def test_single_filing_manager_is_hold_without_change():
    out = run({1: [("0000000001-25-000002", "2025-03-31", "2025-05-01", CURRENT)]})
    item = out["items"][0]
    assert item["action"] == "hold" and item["change_pct"] is None


def test_holdings_cached_per_accession_no_refetch():
    data = {1: [("0000000001-25-000002", "2025-03-31", "2025-05-01", CURRENT), ("0000000001-25-000001", "2024-12-31", "2025-02-01", PREVIOUS)]}
    gj, gt = make_fetch(data)
    texts = []
    def counting(url):
        texts.append(url)
        return gt(url)
    args = dict(managers=MANAGERS[:1], isin_fn=lambda t: "US5949181045", get_json=gj, get_text=counting)
    build_superinvestors("MSFT", **args)
    n = len(texts)
    assert n == 2
    build_superinvestors("MSFT", **args)
    assert len(texts) == n


def test_cusip_resolved_from_issuer_name_when_isin_missing():
    data = {1: [("0000000001-25-000002", "2025-03-31", "2025-05-01", CURRENT), ("0000000001-25-000001", "2024-12-31", "2025-02-01", PREVIOUS)]}
    gj, gt = make_fetch(data)
    out = build_superinvestors("MSFT", managers=MANAGERS[:1], isin_fn=lambda t: None,
                               name_fn=lambda t: "Microsoft Corp.", get_json=gj, get_text=gt)
    assert out["cusip"] == MSFT and out["holders"] == 1 and out["buying"] == 1


def test_name_match_must_be_unique():
    t = {"issuers": {"111111111": "ALPHABET INC", "222222222": "ALPHABET INC"}}
    assert resolve_cusip_by_name("Alphabet Inc.", [t]) is None          # two share classes
    assert resolve_cusip_by_name("Nobody Inc", [t]) is None
    assert resolve_cusip_by_name("", [t]) is None
    assert resolve_cusip_by_name("APPLE INC", [{"issuers": {"037833100": "APPLE INC"}}, {"issuers": {"037833100": "APPLE INC."}}]) == "037833100"


def test_curated_list_is_valid():
    managers = load_managers()
    assert 20 <= len(managers) <= 40
    for m in managers:
        assert set(m) >= {"manager", "fund", "cik"} and str(m["cik"]).isdigit()
    assert len({m["cik"] for m in managers}) == len(managers)
