"""
test_company_overview.py - build_overview() derives the Analysis page "overview"
block (profile, income breakdown, balance, multiples, profitability, cost of
capital, growth, ownership, yields) from a yfinance Ticker. Fake Ticker, no network.
"""
import sys
from pathlib import Path

import pandas as pd
import pytest

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from company_overview import build_overview  # noqa: E402

Y = [pd.Timestamp("2025-12-31"), pd.Timestamp("2024-12-31"), pd.Timestamp("2023-12-31")]  # newest first, like yfinance
Q = [pd.Timestamp("2026-03-31")]


def _df(rows: dict, cols):
    return pd.DataFrame({c: [r[i] for r in rows.values()] for i, c in enumerate(cols)}, index=list(rows))


INFO = {
    "longName": "Acme Corp", "sector": "Technology", "industry": "Software", "country": "United States",
    "currency": "USD", "marketCap": 2000.0, "sharesOutstanding": 100.0, "beta": 1.2,
    "fullTimeEmployees": 5000, "city": "Austin", "state": "TX", "website": "https://acme.test",
    "lastFiscalYearEnd": 1767139200,  # 2025-12-31
    "longBusinessSummary": "Makes anvils.",
    "companyOfficers": [
        {"name": "Ann Lee", "title": "Chief Executive Officer & Director"},
        {"name": "Bo Chan", "title": "Chief Financial Officer"},
    ],
}


class FakeTicker:
    def __init__(self, info=None, **frames):
        self.info = INFO if info is None else info
        self.isin = "US0000000001"
        self.income_stmt = _df({
            "Total Revenue": [1000, 900, 800], "Cost Of Revenue": [600, 540, 500], "Gross Profit": [400, 360, 300],
            "Research And Development": [100, 90, 80], "Selling General And Administration": [150, 140, 120],
            "Operating Income": [150, 130, 100], "EBIT": [150, 130, 100], "EBITDA": [180, 160, 130],
            "Pretax Income": [125, 110, 90], "Tax Provision": [25, 22, 18], "Net Income": [100, 88, 50],
            "Interest Expense": [10, 9, 8],
        }, Y)
        self.quarterly_income_stmt = _df({
            "Total Revenue": [260], "Cost Of Revenue": [150], "Gross Profit": [110],
            "Research And Development": [25], "Selling General And Administration": [40],
            "Operating Income": [45], "Tax Provision": [7], "Net Income": [30],
        }, Q)
        self.balance_sheet = _df({"Total Assets": [1900, 1800, 1700], "Stockholders Equity": [700, 650, 600],
                                  "Long Term Debt": [250, 250, 250], "Total Debt": [350, 350, 350],
                                  "Cash Cash Equivalents And Short Term Investments": [100, 90, 80]}, Y)
        self.quarterly_balance_sheet = _df({
            "Total Assets": [2000], "Stockholders Equity": [800], "Long Term Debt": [300], "Total Debt": [400],
            "Cash Cash Equivalents And Short Term Investments": [150], "Net PPE": [500], "Working Capital": [100],
        }, Q)
        self.cashflow = _df({
            "Operating Cash Flow": [220, 200, 180], "Capital Expenditure": [-20, -20, -20],
            "Cash Dividends Paid": [-20, -18, -16], "Repurchase Of Capital Stock": [-30, -20, -10],
            "Common Stock Issuance": [5, 5, 5],
        }, Y)
        self.major_holders = pd.DataFrame(
            {"Value": [0.02, 0.70]}, index=["insidersPercentHeld", "institutionsPercentHeld"])
        for k, v in frames.items():
            setattr(self, k, v)


class Boom(FakeTicker):
    @property
    def income_stmt(self):
        raise RuntimeError("yahoo down")

    @income_stmt.setter
    def income_stmt(self, v):
        pass


def test_profile():
    p = build_overview(FakeTicker())["profile"]
    assert p["name"] == "Acme Corp" and p["sector"] == "Technology" and p["industry"] == "Software"
    assert p["country"] == "United States" and p["currency"] == "USD" and p["market_cap"] == 2000.0
    assert p["employees"] == 5000 and p["website"] == "https://acme.test"
    assert p["hq"] == {"city": "Austin", "state": "TX", "country": "United States"}
    assert p["fiscal_year_end"] == 12
    assert p["ceo"] == "Ann Lee" and p["cfo"] == "Bo Chan"
    assert p["description"] == "Makes anvils." and p["isin"] == "US0000000001"


def test_income_breakdown_latest_periods_and_null_segments():
    o = build_overview(FakeTicker())
    q, a = o["income_quarter"], o["income_annual"]
    assert q["period"] == "2026-03-31" and a["period"] == "2025-12-31"
    assert q["segments"] is None and a["segments"] is None
    assert (q["revenue"], q["cost_of_revenue"], q["gross_profit"], q["net_income"]) == (260, 150, 110, 30)
    assert (a["revenue"], a["cost_of_revenue"], a["gross_profit"]) == (1000, 600, 400)
    assert (a["research_development"], a["sga"], a["operating_income"], a["tax"], a["net_income"]) == (100, 150, 150, 25, 100)


def test_balance_prefers_latest_quarter():
    b = build_overview(FakeTicker())["balance"]
    assert b["total_assets"] == 2000 and b["total_equity"] == 800 and b["long_term_debt"] == 300
    assert b["total_debt"] == 400 and b["cash_and_short_term"] == 150
    assert b["net_debt"] == 250 and b["net_debt_per_share"] == pytest.approx(2.5)
    assert b["debt_to_equity"] == pytest.approx(0.5)


def test_multiples_use_ev_market_cap_plus_debt_minus_cash():
    m = build_overview(FakeTicker())["multiples"]  # EV = 2000 + 400 - 150 = 2250
    assert m["pe"] == pytest.approx(20.0) and m["pb"] == pytest.approx(2.5)
    assert m["ev_ebitda"] == pytest.approx(12.5) and m["ev_ebit"] == pytest.approx(15.0)
    assert m["ev_sales"] == pytest.approx(2.25) and m["ev_fcf"] == pytest.approx(11.25)


def test_profitability_percent_numbers():
    p = build_overview(FakeTicker())["profitability"]
    assert p["roe"] == pytest.approx(12.5) and p["roa"] == pytest.approx(5.0)
    assert p["roic"] == pytest.approx(120 / 1050 * 100)  # EBIT*(1-25/125) / (debt+equity-cash)
    assert p["rona"] == pytest.approx(100 / 600 * 100)   # NI / (Net PPE + Working Capital)
    assert p["gross_margin"] == pytest.approx(40) and p["ebitda_margin"] == pytest.approx(18)
    assert p["ebit_margin"] == pytest.approx(15) and p["net_margin"] == pytest.approx(10)
    assert p["fcf_margin"] == pytest.approx(20)


def test_cost_of_capital_capm_and_wacc():
    c = build_overview(FakeTicker())["cost_of_capital"]
    assert c["beta"] == 1.2 and c["levered_beta"] == 1.2
    assert c["cost_of_equity"] == pytest.approx(9.4)  # 4% + 1.2 * 4.5% (wacc.py constants)
    assert c["cost_of_debt"] == pytest.approx(2.5)    # 10 / 400
    assert c["wacc"] == pytest.approx(((2000 / 2400) * 0.094 + (400 / 2400) * 0.025 * 0.8) * 100)
    assert c["discount_rate"] is None


def test_growth_cagr_percent():
    g = build_overview(FakeTicker())["growth"]
    assert g["revenue_hist"] == pytest.approx(((1000 / 800) ** 0.5 - 1) * 100)
    assert g["ebit_hist"] == pytest.approx(((150 / 100) ** 0.5 - 1) * 100)
    assert g["net_income_hist"] == pytest.approx(((100 / 50) ** 0.5 - 1) * 100)
    assert g["terminal"] is None


def test_ownership_and_yields_and_benchmarks():
    o = build_overview(FakeTicker())
    assert o["ownership"] == {"insiders_pct": pytest.approx(2.0), "institutions_pct": pytest.approx(70.0),
                              "public_pct": pytest.approx(28.0)}
    y = o["yields"]
    assert y["fcf_yield"] == pytest.approx(10.0) and y["dividend_yield"] == pytest.approx(1.0)
    assert y["buyback_yield"] == pytest.approx(1.25) and y["augmented_yield"] == pytest.approx(2.25)
    assert o["benchmarks"] == {"sector": None, "industry": None}


def test_missing_statements_give_null_fields_not_errors():
    empty = pd.DataFrame()
    o = build_overview(FakeTicker(
        income_stmt=empty, quarterly_income_stmt=empty, balance_sheet=empty,
        quarterly_balance_sheet=empty, cashflow=empty, major_holders=None))
    assert o["income_quarter"] is None and o["income_annual"] is None and o["balance"] is None
    assert o["multiples"]["ev_ebitda"] is None and o["multiples"]["pe"] is None
    assert o["growth"]["revenue_hist"] is None and o["yields"]["fcf_yield"] is None
    assert o["ownership"]["public_pct"] is None
    assert o["profile"]["name"] == "Acme Corp"


def test_failing_source_nulls_only_that_block():
    o = build_overview(Boom())
    assert o["income_annual"] is None and o["growth"]["revenue_hist"] is None
    assert o["profile"]["name"] == "Acme Corp" and o["balance"]["total_debt"] == 400


def test_non_positive_or_missing_inputs_are_null_never_fabricated():
    t = FakeTicker()
    t.income_stmt.loc["Net Income"] = [-10, 5, 0]
    o = build_overview(t)
    assert o["multiples"]["pe"] is None
    assert o["growth"]["net_income_hist"] is None


def test_overview_keys_complete_when_everything_fails():
    class Dead:
        def __getattr__(self, name):
            raise RuntimeError("down")
    o = build_overview(Dead())
    assert set(o) == {"profile", "income_quarter", "income_annual", "balance", "multiples", "profitability",
                      "cost_of_capital", "growth", "ownership", "yields", "benchmarks"}
    assert o["profile"] is None and o["multiples"] is None
