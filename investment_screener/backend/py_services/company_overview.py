#!/usr/bin/env python3
"""
company_overview.py - Analysis page "overview" block built from a yfinance Ticker.

Purpose:
    One canonical place that turns Ticker.info, the income / balance / cash-flow
    statements and major_holders into the Descripción, Financieros and Valoración
    tab data: profile, income breakdown, balance, multiples, profitability, cost of
    capital, growth, ownership, yields. Every leaf is a number or None, never
    fabricated; a failing source nulls only the blocks that need it.

Layer:
    Backend / Python Services / Data Retrieval

Usage Examples:
    from company_overview import build_overview
    overview = build_overview(yf.Ticker("MSFT"))

Formulas (all % outputs are percent numbers, ratios are plain numbers):
    EV            = market cap + total debt - cash and short-term investments
    P/E           = info trailingPE, else market cap / latest annual net income (> 0)
    P/B           = market cap / total equity;  EV/X = EV / X for X in EBITDA, EBIT, revenue, FCF (> 0)
    FCF           = operating cash flow + capital expenditure (capex is negative in Yahoo)
    tax rate      = tax provision / pretax income, else wacc.DEFAULT_TAX_RATE
    ROE / ROA     = net income / total equity, / total assets (latest balance)
    ROIC          = EBIT * (1 - tax rate) / (total debt + equity - cash)
    RONA          = net income / (net PPE + working capital); None when either is missing
    cost of equity= wacc.capital_cost_components (CAPM): risk-free + beta * ERP, using
                    wacc.FALLBACK_RISK_FREE_RATE (no live 10Y fetch here) and wacc.DEFAULT_ERP
    cost of debt  = interest expense / total debt (pre-tax); WACC weights market cap and
                    total debt, with after-tax cost of debt. discount_rate is None: the
                    projection discount rate is not known here.
    CAGR          = (last / first) ** (1 / (periods - 1)) - 1 over annual columns, first and last > 0
    yields        = FCF, dividends paid, net buybacks (repurchase less issuance) over market cap
    The latest quarterly balance sheet is preferred, falling back to the annual one.

Key Functions (Index):
    - build_overview(stock) - Full overview dict, one block per key, None on failure

Key Input Dependencies:
    - yfinance Ticker (or any object with the same attributes); wacc.py constants

Key Output Dependencies:
    - fetch_financials.py (payload key `overview`)
"""

import datetime
import math
from typing import Any, Callable, Optional

import pandas as pd


def _num(v: Any) -> Optional[float]:
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return f if math.isfinite(f) else None


def _div(a: Optional[float], b: Optional[float], pct: bool = False) -> Optional[float]:
    if a is None or b is None or b == 0:
        return None
    return a / b * (100 if pct else 1)


def _pos_div(a: Optional[float], b: Optional[float]) -> Optional[float]:
    return _div(a, b) if a is not None and b is not None and a > 0 and b > 0 else None


def _frame(stock: Any, name: str) -> pd.DataFrame:
    """Statement sorted oldest -> newest; empty frame when unavailable or the fetch fails."""
    try:
        df = getattr(stock, name)
        if df is None or df.empty:
            return pd.DataFrame()
        return df.reindex(sorted(df.columns), axis=1)
    except Exception:
        return pd.DataFrame()


def _row(df: pd.DataFrame, aliases: list[str]) -> list[Optional[float]]:
    """Values of the first alias present, oldest -> newest ([] when absent)."""
    for key in aliases:
        if key in df.index:
            return [_num(v) for v in df.loc[key]]
    return []


def _latest(df: pd.DataFrame, aliases: list[str]) -> Optional[float]:
    vals = _row(df, aliases)
    return vals[-1] if vals else None


def _cagr(vals: list[Optional[float]]) -> Optional[float]:
    if len(vals) < 2 or vals[0] is None or vals[-1] is None or vals[0] <= 0 or vals[-1] <= 0:
        return None
    return ((vals[-1] / vals[0]) ** (1 / (len(vals) - 1)) - 1) * 100


def _period(df: pd.DataFrame) -> str:
    c = df.columns[-1]
    return c.date().isoformat() if hasattr(c, "date") else str(c)


def _income(df: pd.DataFrame) -> Optional[dict]:
    if df.empty:
        return None
    pick = {
        "revenue": ["Total Revenue", "Revenue"], "cost_of_revenue": ["Cost Of Revenue"],
        "gross_profit": ["Gross Profit"], "research_development": ["Research And Development"],
        "sga": ["Selling General And Administration"], "operating_income": ["Operating Income"],
        "tax": ["Tax Provision"], "net_income": ["Net Income"],
    }
    out: dict = {"period": _period(df)}
    out.update({k: _latest(df, v) for k, v in pick.items()})
    out["segments"] = None  # yfinance has no segment data; the UI falls back to total revenue
    return out


def _officer(officers: list, needles: tuple) -> Optional[str]:
    for o in officers or []:
        title = str(o.get("title", "")).lower()
        if any(n in title for n in needles):
            return o.get("name")
    return None


def _profile(stock: Any, info: dict) -> dict:
    fye = _num(info.get("lastFiscalYearEnd"))
    isin = getattr(stock, "isin", None)
    officers = info.get("companyOfficers") or []
    return {
        "name": info.get("longName") or info.get("shortName"), "sector": info.get("sector"),
        "industry": info.get("industry"), "country": info.get("country"), "currency": info.get("currency"),
        "market_cap": _num(info.get("marketCap")), "employees": _num(info.get("fullTimeEmployees")),
        "hq": {"city": info.get("city"), "state": info.get("state"), "country": info.get("country")},
        "website": info.get("website"),
        "fiscal_year_end": datetime.datetime.fromtimestamp(fye, datetime.timezone.utc).month if fye else None,
        "ceo": _officer(officers, ("chief executive", "ceo")), "cfo": _officer(officers, ("chief financial", "cfo")),
        "description": info.get("longBusinessSummary"),
        "isin": isin if isinstance(isin, str) and isin not in ("", "-") else None,
    }


def _balance(bs: pd.DataFrame, shares: Optional[float]) -> Optional[dict]:
    if bs.empty:
        return None
    debt = _latest(bs, ["Total Debt"])
    cash = _latest(bs, ["Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents"])
    equity = _latest(bs, ["Stockholders Equity", "Total Equity Gross Minority Interest"])
    net_debt = debt - cash if debt is not None and cash is not None else None
    return {
        "total_assets": _latest(bs, ["Total Assets"]), "total_equity": equity,
        "long_term_debt": _latest(bs, ["Long Term Debt"]), "total_debt": debt,
        "cash_and_short_term": cash, "net_debt": net_debt,
        "net_debt_per_share": _div(net_debt, shares), "debt_to_equity": _div(debt, equity),
    }


def build_overview(stock: Any) -> dict:
    """Overview dict with one block per key; a block is None when its sources fail."""
    inc_a, inc_q = _frame(stock, "income_stmt"), _frame(stock, "quarterly_income_stmt")
    bs_a, bs_q = _frame(stock, "balance_sheet"), _frame(stock, "quarterly_balance_sheet")
    cf = _frame(stock, "cashflow")
    bs = bs_q if not bs_q.empty else bs_a

    cache: dict = {}

    def info() -> dict:
        if "info" not in cache:
            cache["info"] = stock.info or {}
        return cache["info"]

    def block(fn: Callable[[], Any]) -> Any:
        try:
            return fn()
        except Exception:
            return None

    def market_cap() -> Optional[float]:
        return _num(info().get("marketCap"))

    def shares() -> Optional[float]:
        return _num(info().get("sharesOutstanding")) or _div(market_cap(), _num(info().get("currentPrice")))

    def fcf() -> Optional[float]:
        ocf, capex = _latest(cf, ["Operating Cash Flow"]), _latest(cf, ["Capital Expenditure"])
        return None if ocf is None else ocf + (capex or 0)

    def tax_rate() -> float:
        from wacc import DEFAULT_TAX_RATE
        t, pre = _latest(inc_a, ["Tax Provision"]), _latest(inc_a, ["Pretax Income"])
        rate = _div(t, pre)
        return rate if rate is not None and pre > 0 and 0 <= rate < 1 else DEFAULT_TAX_RATE

    ebit = lambda: _latest(inc_a, ["EBIT", "Operating Income"])  # noqa: E731
    revenue = lambda: _latest(inc_a, ["Total Revenue", "Revenue"])  # noqa: E731
    net_income = lambda: _latest(inc_a, ["Net Income"])  # noqa: E731
    bs_val = lambda *a: _latest(bs, list(a))  # noqa: E731
    debt = lambda: bs_val("Total Debt")  # noqa: E731
    cash = lambda: bs_val("Cash Cash Equivalents And Short Term Investments", "Cash And Cash Equivalents")  # noqa: E731
    equity = lambda: bs_val("Stockholders Equity", "Total Equity Gross Minority Interest")  # noqa: E731

    def multiples() -> dict:
        mc, d, c = market_cap(), debt(), cash()
        ev = mc + d - c if mc is not None and d is not None and c is not None else None
        pe = _num(info().get("trailingPE")) or _pos_div(mc, net_income())
        return {
            "pe": pe, "pb": _pos_div(mc, equity()),
            "ev_ebitda": _pos_div(ev, _latest(inc_a, ["EBITDA"])), "ev_ebit": _pos_div(ev, ebit()),
            "ev_sales": _pos_div(ev, revenue()), "ev_fcf": _pos_div(ev, fcf()),
        }

    def profitability() -> dict:
        rev, e, ni = revenue(), ebit(), net_income()
        eq, d, c = equity(), debt(), cash()
        ic = d + eq - c if None not in (d, eq, c) else None
        nopat = e * (1 - tax_rate()) if e is not None else None
        ppe, wc = bs_val("Net PPE"), bs_val("Working Capital")
        nonneg = lambda den: den if den is not None and den > 0 else None  # noqa: E731
        return {
            "roe": _div(ni, nonneg(eq), True), "roic": _div(nopat, nonneg(ic), True),
            "roa": _div(ni, nonneg(bs_val("Total Assets")), True),
            "rona": _div(ni, nonneg(ppe + wc), True) if ppe is not None and wc is not None else None,
            "gross_margin": _div(_latest(inc_a, ["Gross Profit"]), rev, True),
            "ebitda_margin": _div(_latest(inc_a, ["EBITDA"]), rev, True),
            "ebit_margin": _div(e, rev, True), "net_margin": _div(ni, rev, True), "fcf_margin": _div(fcf(), rev, True),
        }

    def cost_of_capital() -> dict:
        from wacc import DEFAULT_ERP, FALLBACK_RISK_FREE_RATE, capital_cost_components
        beta, mc, d = _num(info().get("beta")), market_cap(), debt()
        interest = _latest(inc_a, ["Interest Expense"])
        cod = _div(abs(interest), d) if interest is not None else None
        if d == 0:
            cod = 0.0
        out = {"beta": beta, "levered_beta": beta, "cost_of_equity": None, "cost_of_debt": None,
               "wacc": None, "discount_rate": None}
        if beta is not None:
            out["cost_of_equity"] = (FALLBACK_RISK_FREE_RATE + beta * DEFAULT_ERP) * 100
            if mc is not None and d is not None and cod is not None:
                comp = capital_cost_components(FALLBACK_RISK_FREE_RATE, beta, DEFAULT_ERP, mc, d, cod * (1 - tax_rate()))
                out["wacc"] = comp["rawWacc"] * 100
        if cod is not None:
            out["cost_of_debt"] = cod * 100
        return out

    def growth() -> dict:
        return {
            "revenue_hist": _cagr(_row(inc_a, ["Total Revenue", "Revenue"])),
            "ebit_hist": _cagr(_row(inc_a, ["EBIT", "Operating Income"])),
            "net_income_hist": _cagr(_row(inc_a, ["Net Income"])), "terminal": None,
        }

    def ownership() -> dict:
        ins = inst = None
        mh = getattr(stock, "major_holders", None)
        if mh is not None and not mh.empty:
            col = mh["Value"] if "Value" in mh else mh.iloc[:, 0]
            ins, inst = _num(col.get("insidersPercentHeld")), _num(col.get("institutionsPercentHeld"))
        if ins is None and inst is None:
            ins, inst = _num(info().get("heldPercentInsiders")), _num(info().get("heldPercentInstitutions"))
        ins, inst = (None if v is None else v * 100 for v in (ins, inst))
        both = ins is not None and inst is not None
        return {"insiders_pct": ins, "institutions_pct": inst, "public_pct": 100 - ins - inst if both else None}

    def yields() -> dict:
        mc = market_cap()
        div = _latest(cf, ["Cash Dividends Paid", "Common Stock Dividend Paid"])
        rep = _latest(cf, ["Repurchase Of Capital Stock", "Common Stock Payments"])
        iss = _latest(cf, ["Common Stock Issuance", "Issuance Of Capital Stock"]) or 0
        div_y = _div(abs(div), mc, True) if div is not None else None
        buy_y = _div(-(rep + iss), mc, True) if rep is not None else None
        parts = [y for y in (div_y, buy_y) if y is not None]
        return {"fcf_yield": _div(fcf(), mc, True), "dividend_yield": div_y, "buyback_yield": buy_y,
                "augmented_yield": sum(parts) if parts else None}

    return {
        "profile": block(lambda: _profile(stock, info())),
        "income_quarter": block(lambda: _income(inc_q)),
        "income_annual": block(lambda: _income(inc_a)),
        "balance": block(lambda: _balance(bs, shares())),
        "multiples": block(multiples),
        "profitability": block(profitability),
        "cost_of_capital": block(cost_of_capital),
        "growth": block(growth),
        "ownership": block(ownership),
        "yields": block(yields),
        "benchmarks": {"sector": None, "industry": None},
    }
