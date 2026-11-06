#!/usr/bin/env python3
"""
superinvestors.py - Which curated value managers hold a ticker, from SEC 13F-HR (Inversores tab, S11).

Purpose:
    For each manager in data/superinvestors.json (CIKs verified against EDGAR submissions), reads
    the two latest 13F-HR filings, sums the shares of the ticker's CUSIP and classifies the
    quarter-over-quarter move. Output feeds the Super Investors table.

    CUSIP source, in order: (1) yfinance `Ticker.isin`; a US or CA ISIN embeds the CUSIP in
    characters 3-11 (cusip_from_isin). Yahoo often answers "-", so (2) fallback: EDGAR publishes
    no ticker->CUSIP map, but the company title from company_tickers.json (e.g. "MICROSOFT
    CORP") is matched against the nameOfIssuer of the managers' latest information tables
    (resolve_cusip_by_name: same name after dropping punctuation and a trailing INC/CORP/CO/
    LTD/PLC...). Exactly one CUSIP must match: several (share classes such as GOOG/GOOGL) or none
    give cusip null and an empty result.

    Information-table rules (parse_info_table):
      - rows with putCall (options) and with sshPrnamtType other than SH (bonds) are NOT
        counted as shares, but every row counts toward the filing's total value, so
        portfolio_pct = ticker value / total filing value * 100.
      - several rows of one CUSIP (split by sub-manager) are summed.
      - <value> is in US dollars for filings filed on/after 2023-01-03 and in thousands before;
        values are normalised to dollars.

    Action (classify_action), from shares now vs the previous 13F-HR:
      new = absent before, held now; sold_out = held before, absent now (shares 0, change -100);
      add / reduce when |change| >= 0.5%; hold when |change| < 0.5%. A manager with only one
      13F-HR on file has no previous quarter: hold, change_pct null.
    holders = managers holding now; buying = add + new; selling = reduce + sold_out.

    A manager whose fetch fails is skipped and listed in `errors`, never fatal.

Persistence:
    Parsed holdings per manager+accession are immutable, so they go into the shared fetch_cache
    (cache.py, data class "edgar", 7-day TTL; no new DDL, key "13f-<cik>-<accession>"). Submissions
    are always fetched fresh (one request per manager) so a new 13F shows up. All requests go
    through edgar_facts (single client: User-Agent, >=0.15 s spacing, so <=10 req/s). The route
    caches the whole payload for 24h.

Layer:
    Backend / Python Services / SEC EDGAR

Usage Examples:
    python3 superinvestors.py MSFT

Key Functions (Index):
    - cusip_from_isin(isin)
    - parse_info_table(xml, filed) - {"holdings": {cusip: {shares, value}}, "total_value"}
    - resolve_cusip_by_name(company, tables) - CUSIP from issuer names, None unless unique
    - classify_action(now, prev, has_previous) - (action, change_pct)
    - load_managers()
    - build_superinvestors(ticker, managers, isin_fn, get_json, get_text)

Key Input Dependencies:
    - edgar_facts (get_json, get_text), cache, ticker_aliases, data/superinvestors.json

Key Output Dependencies:
    - routes/stock.ts (GET /api/stock/:ticker/superinvestors)
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from cache import cache_get, cache_set  # noqa: E402
from edgar_facts import accession_url, get_json as edgar_get_json, get_text as edgar_get_text, lookup_company_name  # noqa: E402
from ticker_aliases import normalize_ticker  # noqa: E402

MANAGERS_PATH = Path(__file__).resolve().parent / "data" / "superinvestors.json"
DELAY_NOTE = "Los formularios 13F se publican hasta 45 días después del cierre del trimestre."
HOLD_BAND_PCT = 0.5
DOLLAR_VALUES_FROM = "2023-01-03"
_CORP_SUFFIXES = {"INC", "INCORPORATED", "CORP", "CORPORATION", "CO", "COMPANY", "LTD", "LIMITED", "PLC", "LLC", "LP", "NV", "SA", "AG", "HOLDINGS"}


def cusip_from_isin(isin: str | None) -> str | None:
    """CUSIP embedded in a US/CA ISIN (chars 3-11), else None."""
    if not isin or len(isin) != 12 or isin[:2] not in ("US", "CA"):
        return None
    return isin[2:11].upper()


def get_isin(ticker: str) -> str | None:
    """ISIN from yfinance, None when it has none or the lookup fails."""
    try:
        import yfinance as yf
        isin = yf.Ticker(normalize_ticker(ticker)).isin
    except Exception:
        return None
    return isin if isin and isin != "-" else None


def _local(tag: str) -> str:
    return tag.rsplit("}", 1)[-1]


def parse_info_table(xml_text: str, filed: str) -> dict:
    """Aggregate a 13F information table per CUSIP; see the module docstring for the rules."""
    scale = 1 if filed >= DOLLAR_VALUES_FROM else 1000
    holdings: dict[str, dict] = {}
    issuers: dict[str, str] = {}
    total = 0.0
    for row in ET.fromstring(xml_text).iter():
        if _local(row.tag) != "infoTable":
            continue
        f = {_local(e.tag): (e.text or "").strip() for e in row.iter()}
        value = float(f.get("value") or 0) * scale
        total += value
        if f.get("putCall") or f.get("sshPrnamtType", "SH") != "SH":
            continue
        cusip = f.get("cusip", "").upper()
        if not cusip:
            continue
        issuers.setdefault(cusip, f.get("nameOfIssuer", ""))
        entry = holdings.setdefault(cusip, {"shares": 0, "value": 0})
        entry["shares"] += int(float(f.get("sshPrnamt") or 0))
        entry["value"] += value
    return {"holdings": holdings, "issuers": issuers, "total_value": total}


def _name_key(name: str) -> str:
    tokens = re.sub(r"[^A-Z0-9]+", " ", name.upper()).split()
    while tokens and tokens[-1] in _CORP_SUFFIXES:
        tokens.pop()
    return " ".join(tokens)


def resolve_cusip_by_name(company: str, tables: list[dict]) -> str | None:
    """The one CUSIP whose issuer name equals the company name in any table, else None."""
    key = _name_key(company or "")
    if not key:
        return None
    found = {c for t in tables for c, n in t.get("issuers", {}).items() if _name_key(n) == key}
    return found.pop() if len(found) == 1 else None


def classify_action(now: int, prev: int | None, has_previous: bool = True) -> tuple[str, float | None]:
    """(action, change_pct) from shares now vs the previous 13F-HR."""
    if not has_previous:
        return "hold", None
    if not prev:
        return "new", None
    if not now:
        return "sold_out", -100.0
    change = (now - prev) / prev * 100
    if abs(change) < HOLD_BAND_PCT:
        return "hold", change
    return ("add" if change > 0 else "reduce"), change


def load_managers() -> list[dict]:
    return json.loads(MANAGERS_PATH.read_text(encoding="utf-8"))


def quarter_label(report_date: str) -> str:
    return f"{report_date[:4]}-Q{(int(report_date[5:7]) - 1) // 3 + 1}"


def _filing_holdings(cik: str, accession: str, filed: str, get_json, get_text) -> dict:
    key = f"13f-{cik}-{accession}"
    cached = cache_get(key, "edgar")
    if cached is not None:
        return cached
    index = get_json(f"https://www.sec.gov/Archives/edgar/data/{int(cik)}/{accession.replace('-', '')}/index.json")
    names = [i["name"] for i in (index or {}).get("directory", {}).get("item", [])
             if i["name"].lower().endswith(".xml") and i["name"] != "primary_doc.xml"]
    if not names:
        raise RuntimeError(f"no information table in {accession}")
    names.sort(key=lambda n: not re.search(r"info|table", n, re.I))
    xml = get_text(accession_url(cik, accession, names[0]))
    if xml is None:
        raise RuntimeError(f"information table not downloadable for {accession}")
    parsed = parse_info_table(xml, filed)
    cache_set(key, "edgar", parsed)
    return parsed


def _load_manager(m: dict, get_json, get_text) -> dict | None:
    """The manager's two latest 13F-HR as parsed tables (newest first), or None without any."""
    subs = get_json(f"https://data.sec.gov/submissions/CIK{int(m['cik']):010d}.json")
    if subs is None:
        raise RuntimeError("submissions unavailable")
    recent = subs["filings"]["recent"]
    filings = [(recent["accessionNumber"][i], recent["reportDate"][i], recent["filingDate"][i])
               for i, form in enumerate(recent["form"]) if form == "13F-HR"][:2]
    if not filings:
        return None
    return {"m": m, "report": filings[0][1],
            "tables": [_filing_holdings(m["cik"], acc, filed, get_json, get_text) for acc, _r, filed in filings]}


def _manager_row(loaded: dict, cusip: str) -> dict | None:
    m, latest = loaded["m"], loaded["tables"][0]
    now = latest["holdings"].get(cusip)
    has_previous = len(loaded["tables"]) > 1
    previous = loaded["tables"][1]["holdings"].get(cusip) if has_previous else None
    if not now and not previous:
        return None
    shares = now["shares"] if now else 0
    action, change = classify_action(shares, previous["shares"] if previous else 0, has_previous)
    total = latest["total_value"]
    return {
        "manager": m["manager"], "fund": m["fund"], "cik": m["cik"],
        "portfolio_pct": round(now["value"] / total * 100, 4) if now and total else 0,
        "shares": shares, "quarter": quarter_label(loaded["report"]),
        "change_pct": None if change is None else round(change, 2), "action": action,
    }


def build_superinvestors(ticker: str, managers=None, isin_fn=get_isin, name_fn=lookup_company_name,
                         get_json=edgar_get_json, get_text=edgar_get_text) -> dict:
    """Endpoint payload for one ticker; every network seam is injectable for offline tests."""
    symbol = normalize_ticker(ticker.upper())
    cusip = cusip_from_isin(isin_fn(symbol))
    company = None if cusip else name_fn(symbol)
    out = {"ticker": symbol, "cusip": cusip, "holders": 0, "buying": 0, "selling": 0,
           "quarter_latest": None, "items": [], "errors": [], "delay_note": DELAY_NOTE}
    if cusip is None and not company:
        return out
    loaded = []
    for m in managers if managers is not None else load_managers():
        try:
            entry = _load_manager(m, get_json, get_text)
        except Exception as e:
            out["errors"].append({"manager": m["manager"], "error": str(e)})
            continue
        if entry:
            loaded.append(entry)
    if cusip is None:
        cusip = out["cusip"] = resolve_cusip_by_name(company, [e["tables"][0] for e in loaded])
        if cusip is None:
            return out
    out["items"] = sorted(filter(None, (_manager_row(e, cusip) for e in loaded)),
                          key=lambda r: r["portfolio_pct"], reverse=True)
    items = out["items"]
    out["holders"] = sum(1 for r in items if r["shares"] > 0)
    out["buying"] = sum(1 for r in items if r["action"] in ("add", "new"))
    out["selling"] = sum(1 for r in items if r["action"] in ("reduce", "sold_out"))
    out["quarter_latest"] = max((r["quarter"] for r in items), default=None)
    return out


def main() -> None:
    if len(sys.argv) < 2:
        print(json.dumps({"error": "ticker required"}))
        sys.exit(1)
    try:
        print(json.dumps(build_superinvestors(sys.argv[1])))
    except Exception as e:
        print(json.dumps({"error": "failed", "message": str(e)}))


if __name__ == "__main__":
    main()
