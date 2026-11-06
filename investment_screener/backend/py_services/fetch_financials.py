#!/usr/bin/env python3
"""
fetch_financials.py - Scraping and financial metrics compiler.

Purpose:
    Retrieves comprehensive financial data for a stock using yfinance. 
    Aggregates income statements, balance sheets, cash flows, analyst estimates, and performance history.
    Includes advanced calculations for Rule of 40 and Piotroski F-Score.

Layer:
    Backend / Python Services / Data Retrieval

Usage Examples:
    python3 fetch_financials.py AAPL

Key Functions (Index):
    - get_cached_data(ticker) - Retrieve cached data if valid
    - save_to_cache(ticker, data) - Save data to cache
    - sanitize_json_data(val) - Clean floats/nans for valid JSON serialization
    - compute_performance(hist) - 1D..5Y % changes via shared price_changes.period_changes
    - build_overview(stock) - (company_overview.py) adds the `overview` block to the payload
    - overlay_ttm(annual, quarterly, kind) - Appends a TTM column when quarterly data is newer than the last fiscal year
    - fetch_financial_data(ticker_symbol, no_cache) - Primary orchestrator for data retrieval, caching, and transformation
    - main() - Main CLI entry point

Key Input Dependencies:
    - Ticker symbol argument; yfinance (network)
    - investment_screener/backend/py_services/cache/ (cached quote responses)

Key Output Dependencies:
    - investment_screener/backend/py_services/cache/ (cache folder containing JSON quote metrics)
"""

import sys
import json
import os
import time
import hashlib
import datetime
from typing import Any, Optional
import yfinance as yf
import pandas as pd
import numpy as np

from price_changes import PERIODS, period_changes
from company_overview import build_overview

# --- Caching Configuration ---
# Cache lives in SQLite (cache.py -> fetch_cache), never in JSON files next to the script.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.realpath(__file__)), "..", "..", "..", "investment_screener", "backend", "py_services"))
CACHE_DURATION = 3600  # 1 hour in seconds

# --- Custom Encoder for Numpy Types (Global) ---
class NpEncoder(json.JSONEncoder):
    """Custom JSON encoder converting numpy data types to native python formats."""

    def default(self, o: Any) -> Any:
        """Encodes numpy data types into JSON-serializable native python types.

        Args:
            o: Object to serialize.

        Returns:
            Native python serializable type.
        """
        if isinstance(o, np.integer):
            return int(o)
        if isinstance(o, np.floating):
            return float(o)
        if isinstance(o, np.ndarray):
            return o.tolist()
        if isinstance(o, np.bool_):
            return bool(o)
        return super().default(o)

# --- Caching Functions ---

# Retrieve cached data if valid
def get_cached_data(ticker: str) -> Optional[dict[str, Any]]:
    """Cached financial data for ticker if younger than CACHE_DURATION (cache.py, SQLite), else None."""
    try:
        from cache import cache_get
        return cache_get(ticker, "financials")
    except Exception:
        return None

# Save data to cache
def save_to_cache(ticker: str, data: dict[str, Any]) -> None:
    """Save compiled financial data to the shared SQLite cache (numpy values normalised first)."""
    try:
        from cache import cache_set
        cache_set(ticker, "financials", json.loads(json.dumps(data, cls=NpEncoder)))
    except Exception:
        # A cache write failure must not break the main output flow
        pass

# Clean floats/nans for valid JSON serialization
def sanitize_json_data(val: Any) -> Any:
    """Recursively converts nan/inf floats to None for valid JSON serialization.

    Args:
        val: Input data (dicts, lists, values).

    Returns:
        Sanitized version of the input.
    """
    if isinstance(val, dict):
        return {k: sanitize_json_data(v) for k, v in val.items()}
    elif isinstance(val, list):
        return [sanitize_json_data(v) for v in val]
    elif isinstance(val, float):
        if np.isnan(val) or np.isinf(val):
            return None
    return val

def check_margin_consistency(
    profit_margin_pct: float, historical_net_margin_ttm_pct: float, threshold_pp: float = 10.0
) -> list[str]:
    """Flag when metrics.profit_margin (yfinance info['profitMargins']) disagrees
    materially with financials.historical_net_margin's TTM entry (computed locally
    from historical_revenue/historical_net_income) -- two different Yahoo Finance
    data endpoints that can disagree due to fiscal-period/restatement differences.

    Caught live 2026-08-29 across three tickers in one session (BE, BTDR, CBRS),
    each requiring a manual eyeball catch of a double-digit-to-100+ percentage-point
    gap between these two fields. Neither value is "wrong" per se; this just makes
    the disagreement an automatic, machine-readable flag instead of something an
    agent has to notice by chance on every single ticker.

    Args:
        profit_margin_pct: metrics.profit_margin, already in percentage units.
        historical_net_margin_ttm_pct: financials.historical_net_margin[-1],
            already in percentage units.
        threshold_pp: Minimum absolute percentage-point gap to flag.

    Returns:
        A single-item list with a descriptive flag if the two disagree by more
        than `threshold_pp` percentage points, else an empty list. A value of
        exactly 0.0 on either side is treated as "missing/unavailable" (common
        for newly-listed or thinly-covered tickers) rather than compared, to
        avoid a spurious flag against a real zero.
    """
    if profit_margin_pct == 0.0 or historical_net_margin_ttm_pct == 0.0:
        return []
    gap = abs(profit_margin_pct - historical_net_margin_ttm_pct)
    if gap <= threshold_pp:
        return []
    return [
        f"metrics.profit_margin ({profit_margin_pct:.2f}%) disagrees with "
        f"financials.historical_net_margin's TTM entry ({historical_net_margin_ttm_pct:.2f}%) "
        f"by {gap:.2f} percentage points -- two different Yahoo Finance data sources, "
        "not reconciled; do not silently pick one when building DCF margin assumptions"
    ]


# Retrieve comprehensive financial data for a stock
# Stock Analysis "performance" chips: delegates to the shared calculation used
# by the heatmap and tables (AGENTS.md rule 22) instead of a local copy.
def compute_performance(hist: pd.DataFrame) -> dict[str, Optional[float]]:
    """% change for each period in price_changes.PERIODS from a yfinance history frame.

    Args:
        hist: DataFrame with a 'Close' column indexed by (tz-aware) timestamps.

    Returns:
        {period: percent change or None where the history doesn't reach}.
    """
    if hist is None or hist.empty or "Close" not in hist:
        return {p: None for p in PERIODS}
    closes = hist["Close"].dropna()
    dates = [ts.date().isoformat() for ts in closes.index]
    return period_changes(dates, [float(c) for c in closes])


# Minimum gap between the newest quarter-end and the newest fiscal-year-end before a
# TTM overlay is worth applying (avoids churning when the annual report is current).
TTM_MIN_GAP_DAYS = 45
MAX_STATEMENT_COLUMNS = 5


def overlay_ttm(
    annual: Optional[pd.DataFrame], quarterly: Optional[pd.DataFrame], kind: str
) -> tuple[Optional[pd.DataFrame], bool]:
    """Appends a trailing-twelve-month column when the quarterly statement is newer.

    yfinance's annual statements stop at the last fiscal year-end, so mid-year the
    "latest year" is stale (MU on 2026-10-01: FY25 labelled as TTM). When the newest
    reported quarter is more than TTM_MIN_GAP_DAYS past the newest annual column, a
    new newest column dated at that quarter is added: flow items (income / cash flow)
    become the sum of the last four quarters, point-in-time items (balance sheet) take
    the latest quarter. A flow row with any missing quarter stays NaN rather than a
    partial sum. Columns end up ascending and trimmed to MAX_STATEMENT_COLUMNS.

    Args:
        annual: Annual statement (line items x period-end dates), any column order.
        quarterly: Quarterly statement in the same shape, any column order.
        kind: "flow" (sum last four quarters) or "point" (latest quarter).

    Returns:
        Tuple of (statement, applied). When not applied, the annual frame is returned
        unchanged (same object) so callers keep their existing behavior.
    """
    if annual is None or annual.empty or quarterly is None or quarterly.empty:
        return annual, False
    q_cols = sorted(quarterly.columns)
    if kind == "flow" and len(q_cols) < 4:
        return annual, False
    newest_q, newest_a = q_cols[-1], max(annual.columns)
    if (pd.Timestamp(newest_q) - pd.Timestamp(newest_a)).days <= TTM_MIN_GAP_DAYS:
        return annual, False
    if kind == "flow":
        window = quarterly[q_cols[-4:]]
        col = window.sum(axis=1, min_count=4)
    else:
        col = quarterly[newest_q]
    out = annual.reindex(sorted(annual.columns), axis=1).copy()
    out[newest_q] = col.reindex(out.index)
    return out.iloc[:, -MAX_STATEMENT_COLUMNS:], True


def fetch_financial_data(ticker_symbol: str, no_cache: bool = False) -> None:
    """Retrieves and compiles financial statements, analyst targets, and key metrics for a given ticker.

    Args:
        ticker_symbol: The target stock ticker.
        no_cache: If True, bypasses local disk cache checks.
    """
    # 1. Try Cache First
    cached = None if no_cache else get_cached_data(ticker_symbol)
    if cached:
        cached = sanitize_json_data(cached)
        print(json.dumps(cached, indent=2))
        return

    try:
        stock = yf.Ticker(ticker_symbol)
        
        # --- Helper for Metrics ---
        def get_metric(info_dict, key, default=0):
            val = info_dict.get(key)
            if val is None: return default
            return val

        # 2. Fetch Basic Info
        info = stock.info
        
        revenue_growth = get_metric(info, 'revenueGrowth')
        profit_margin = get_metric(info, 'profitMargins')
        forward_pe = get_metric(info, 'forwardPE')
        trailing_pe = get_metric(info, 'trailingPE')
        if forward_pe == 0 and trailing_pe != 0:
            forward_pe = trailing_pe

        # --- Analyst Forecast Extraction ---
        analyst_revenue_forecast = []
        analyst_earnings_forecast = []
        
        try:
            current_year = datetime.datetime.now().year
            
            # Revenue Estimates
            rev_est = stock.revenue_estimate
            if rev_est is not None and not rev_est.empty:
                for i, period, year_offset in [(0, '0y', 0), (1, '+1y', 1)]:
                    if period in rev_est.index:
                        row = rev_est.loc[period]
                        analyst_revenue_forecast.append({
                            "year": current_year + year_offset,
                            "avg": row.get('avg', 0),
                            "low": row.get('low', 0),
                            "high": row.get('high', 0),
                            "period": period
                        })
            
            # Earnings Estimates
            earn_est = stock.earnings_estimate
            if earn_est is not None and not earn_est.empty:
                for i, period, year_offset in [(0, '0y', 0), (1, '+1y', 1)]:
                    if period in earn_est.index:
                        row = earn_est.loc[period]
                        analyst_earnings_forecast.append({
                            "year": current_year + year_offset,
                            "avg": row.get('avg', 0),
                            "low": row.get('low', 0),
                            "high": row.get('high', 0),
                            "period": period
                        })


        except Exception as e:
            print(json.dumps({"warning": f"Forecast fetch failed: {str(e)}", "partial": True}), file=sys.stderr)

        # --- Growth Estimates Extraction ---
        growth_estimates = None
        try:
            ge = stock.growth_estimates
            if ge is not None and not ge.empty:
                stock_trend = {}
                if 'stockTrend' in ge.columns:
                    for period in ['0q', '+1q', '0y', '+1y']:
                        if period in ge.index:
                            val = ge.loc[period, 'stockTrend']
                            if pd.notna(val):
                                stock_trend[period] = float(val)
                    
                    if stock_trend:
                        growth_estimates = {"stockTrend": stock_trend}
        except Exception as e:
            print(f"Growth estimates fetch failed: {e}", file=sys.stderr)

        # --- Performance Metrics (shared price_changes definition) ---
        performance = {p: None for p in PERIODS}
        try:
            # 5y lookback needs a close on/before today - 5 years; fetch a little extra.
            performance = compute_performance(stock.history(period="6y"))
        except Exception as e:
            print(f"Error fetching history: {e}", file=sys.stderr)


        # --- Financial Statements ---
        financials = stock.financials
        balance_sheet = stock.balance_sheet
        cashflow = stock.cashflow
        
        if financials.empty:
            print(json.dumps({"error": "Insufficient financial data"}), file=sys.stderr)
            sys.exit(1)

        # TTM overlay: swap the stale "latest fiscal year" for four reported quarters
        # when the quarterly statements are newer (see overlay_ttm).
        financials, ttm_applied = overlay_ttm(financials, stock.quarterly_financials, "flow")
        cashflow, _ = overlay_ttm(cashflow, stock.quarterly_cashflow, "flow") if ttm_applied else (cashflow, False)
        balance_sheet, _ = overlay_ttm(balance_sheet, stock.quarterly_balance_sheet, "point") if ttm_applied else (balance_sheet, False)

        # SORT FINANCIALS BY DATE (Oldest -> Newest)
        financials = financials.reindex(sorted(financials.columns), axis=1)
        if not balance_sheet.empty:
            balance_sheet = balance_sheet.reindex(sorted(balance_sheet.columns), axis=1)
        if not cashflow.empty:
            cashflow = cashflow.reindex(sorted(cashflow.columns), axis=1)

        # Helper to safely get value for a year index (0 = oldest after sort)
        def get_value(df, key_aliases, index):
            try:
                if isinstance(key_aliases, str):
                    key_aliases = [key_aliases]
                
                for key in key_aliases:
                    if key in df.index:
                        val = df.loc[key].iloc[index]
                        return float(val) if not pd.isna(val) else 0
                return 0
            except (KeyError, IndexError):
                return 0

        # Extract last 5 years (or fewer if not available)
        years_count = min(5, len(financials.columns))
        
        # Historical Lists (ordered Oldest -> Newest)
        hist_revenue = [get_value(financials, ['Total Revenue', 'Revenue', 'TotalRevenue'], i) for i in range(years_count)]
        hist_net_income = [get_value(financials, ['Net Income', 'NetIncome'], i) for i in range(years_count)]
        hist_eps = [get_value(financials, ['Basic EPS', 'EPS', 'BasicEPS'], i) for i in range(years_count)]
        
        # Margins Logic
        gross_profit = [get_value(financials, ['Gross Profit', 'GrossProfit'], i) for i in range(years_count)]
        operating_income = [get_value(financials, ['Operating Income', 'OperatingIncome', 'EBIT'], i) for i in range(years_count)]
        
        hist_gross_margin = []
        hist_operating_margin = []
        hist_net_margin = []

        for i in range(years_count):
            rev = hist_revenue[i]
            if rev != 0:
                hist_gross_margin.append(float(gross_profit[i] / rev * 100))
                hist_operating_margin.append(float(operating_income[i] / rev * 100))
                hist_net_margin.append(float(hist_net_income[i] / rev * 100))
            else:
                hist_gross_margin.append(0)
                hist_operating_margin.append(0)
                hist_net_margin.append(0)

        # FCF Logic
        hist_fcf = []
        if not cashflow.empty:
             for i in range(years_count):
                ocf = get_value(cashflow, ['Operating Cash Flow', 'Total Cash From Operating Activities'], i)
                capex = get_value(cashflow, ['Capital Expenditure', 'Capital Expenditures'], i)
                # CapEx negative in Yahoo, so Add it to OCF to subtract
                fcf = ocf + capex 
                hist_fcf.append(fcf)
        else:
            hist_fcf = [0] * years_count
            

        # --- Rule of 40 & Piotroski Calculations (using latest year) ---
        latest_idx = years_count - 1
        prev_idx = years_count - 2 if years_count > 1 else latest_idx

        # Rule of 40
        current_revenue = hist_revenue[latest_idx]
        previous_revenue = hist_revenue[prev_idx]
        
        calc_rev_growth = 0
        if previous_revenue != 0:
             calc_rev_growth = (current_revenue - previous_revenue) / previous_revenue
        
        final_rev_growth = revenue_growth if revenue_growth != 0 else calc_rev_growth
        
        ubiq_ebitda = get_value(financials, 'EBITDA', latest_idx)
        if ubiq_ebitda == 0: ubiq_ebitda = get_value(financials, 'Operating Income', latest_idx)
        
        ebitda_margin = (ubiq_ebitda / current_revenue) if current_revenue != 0 else 0
        rule_of_40_score = (final_rev_growth * 100) + (ebitda_margin * 100)

        # Piotroski F-Score (Full 9-point methodology)
        piotroski_score = 0
        piotroski_details = {}

        # Data Points (Latest & Previous Year)
        net_inc = hist_net_income[latest_idx]
        prev_net_inc = hist_net_income[prev_idx]
        op_cash = get_value(cashflow, ['Operating Cash Flow', 'Total Cash From Operating Activities'], latest_idx)

        total_assets = get_value(balance_sheet, ['Total Assets', 'TotalAssets'], latest_idx)
        prev_total_assets = get_value(balance_sheet, ['Total Assets', 'TotalAssets'], prev_idx)
        avg_assets = (total_assets + prev_total_assets) / 2 if (total_assets and prev_total_assets) else total_assets

        roa = net_inc / avg_assets if avg_assets else 0
        prev_roa = prev_net_inc / prev_total_assets if prev_total_assets else 0

        # --- Profitability (4 points) ---
        # 1. ROA > 0
        piotroski_details['roa_positive'] = roa > 0
        if roa > 0: piotroski_score += 1

        # 2. Operating Cash Flow > 0
        piotroski_details['cfo_positive'] = op_cash > 0
        if op_cash > 0: piotroski_score += 1

        # 3. ROA improving
        piotroski_details['roa_improving'] = roa > prev_roa
        if roa > prev_roa: piotroski_score += 1

        # 4. Accruals
        piotroski_details['accruals_ok'] = op_cash > net_inc
        if op_cash > net_inc: piotroski_score += 1

        # --- Leverage/Liquidity (3 points) ---
        # 5. Leverage decreasing
        long_term_debt = get_value(balance_sheet, ['Long Term Debt', 'LongTermDebt'], latest_idx)
        prev_long_term_debt = get_value(balance_sheet, ['Long Term Debt', 'LongTermDebt'], prev_idx)
        leverage = long_term_debt / avg_assets if avg_assets else 0
        prev_leverage = prev_long_term_debt / prev_total_assets if prev_total_assets else 0
        piotroski_details['leverage_decreasing'] = leverage < prev_leverage
        if leverage < prev_leverage: piotroski_score += 1

        # 6. Current ratio improving
        current_assets = get_value(balance_sheet, ['Current Assets', 'CurrentAssets'], latest_idx)
        current_liabilities = get_value(balance_sheet, ['Current Liabilities', 'CurrentLiabilities'], latest_idx)
        prev_current_assets = get_value(balance_sheet, ['Current Assets', 'CurrentAssets'], prev_idx)
        prev_current_liabilities = get_value(balance_sheet, ['Current Liabilities', 'CurrentLiabilities'], prev_idx)
        current_ratio = current_assets / current_liabilities if current_liabilities else 0
        prev_current_ratio = prev_current_assets / prev_current_liabilities if prev_current_liabilities else 0
        piotroski_details['current_ratio_improving'] = current_ratio > prev_current_ratio
        if current_ratio > prev_current_ratio: piotroski_score += 1

        # 7. No new shares issued
        shares = get_metric(info, 'sharesOutstanding', 0)
        prev_shares = get_value(balance_sheet, ['Share Issued', 'CommonStockSharesOutstanding', 'Ordinary Shares Number'], prev_idx)
        no_dilution = shares <= prev_shares if (shares and prev_shares) else True
        piotroski_details['no_dilution'] = no_dilution
        if no_dilution: piotroski_score += 1

        # --- Operating Efficiency (2 points) ---
        # 8. Gross margin improving
        gross_margin_improving = hist_gross_margin[latest_idx] > hist_gross_margin[prev_idx] if years_count > 1 else False
        piotroski_details['gross_margin_improving'] = gross_margin_improving
        if gross_margin_improving: piotroski_score += 1

        # 9. Asset turnover improving
        asset_turnover = current_revenue / avg_assets if avg_assets else 0
        prev_avg_assets = prev_total_assets
        prev_asset_turnover = previous_revenue / prev_avg_assets if prev_avg_assets else 0
        piotroski_details['asset_turnover_improving'] = asset_turnover > prev_asset_turnover
        if asset_turnover > prev_asset_turnover: piotroski_score += 1

        # --- Derive effective diluted share count from reported EPS + Net Income ---
        # shares_outstanding (from yfinance) returns only the primary share class for
        # multi-class structures (e.g. GOOG Class C = 5.4B vs actual diluted 12.1B).
        # Using net_income / basic_eps gives the true diluted count used in reported EPS.
        shares_primary = info.get('sharesOutstanding', 0)
        shares_diluted = shares_primary  # default
        latest_eps = hist_eps[latest_idx] if hist_eps and hist_eps[latest_idx] != 0 else 0
        latest_ni = hist_net_income[latest_idx] if hist_net_income else 0
        if latest_eps != 0 and latest_ni != 0:
            derived_shares = abs(latest_ni / latest_eps)
            # Use derived if it differs materially (>15%) from the API value
            if shares_primary == 0 or abs(derived_shares - shares_primary) / max(shares_primary, derived_shares) > 0.15:
                shares_diluted = derived_shares

        market_cap = info.get('marketCap', 0)
        current_price = info.get('currentPrice', 0)
        last_actual_ps = market_cap / current_revenue if current_revenue else 0
        result = {
            "symbol": ticker_symbol,
            "price": current_price,
            "currency": info.get('currency', 'USD'),
            "profile": {
                "sector": info.get('sector', 'Unknown'),
                "industry": info.get('industry', 'Unknown'),
                "description": info.get('longBusinessSummary', '')
            },
            "metrics": {
                "price": current_price,
                "pe_ratio": trailing_pe,
                "forward_pe": forward_pe,
                "market_cap": market_cap,
                "beta": info.get('beta', 0),
                "revenue": current_revenue,
                "shares_outstanding": shares_primary,
                "shares_diluted": shares_diluted,
                "last_actual_ps": round(last_actual_ps, 2),
                "revenue_growth": round(final_rev_growth * 100, 2),
                "profit_margin": round(profit_margin * 100, 2)
            },
            "performance": performance,
            "expert_metrics": {
                "rule_of_40": {
                    "score": round(rule_of_40_score, 2),
                    "revenue_growth": round(final_rev_growth * 100, 2),
                    "ebitda_margin": round(ebitda_margin * 100, 2),
                    "is_saas": info.get('industry', '') in (
                        'Software—Application', 'Software—Infrastructure'
                    )
                },
                "piotroski_f_score": {
                    "score": piotroski_score,
                    "max": 9,
                    "details": piotroski_details
                }
            },
            "financials": {
                 "historical_revenue": hist_revenue,
                 "historical_net_income": hist_net_income,
                 "historical_fcf": hist_fcf,
                 "historical_gross_margin": hist_gross_margin,
                 "historical_operating_margin": hist_operating_margin,
                 "historical_net_margin": hist_net_margin,
                 "historical_eps": hist_eps
            },
            "analyst_revenue_forecast": analyst_revenue_forecast,
            "analyst_earnings_forecast": analyst_earnings_forecast,
            "growth_estimates": growth_estimates,
            "analyst_estimates": {
                "target_high_price": get_metric(info, 'targetHighPrice', 0),
                "target_low_price": get_metric(info, 'targetLowPrice', 0),
                "target_mean_price": get_metric(info, 'targetMeanPrice', 0),
                "target_median_price": get_metric(info, 'targetMedianPrice', 0),
                "recommendation": info.get('recommendationKey', '').replace('_', ' ').title() if info.get('recommendationKey') else '',
                "number_of_analysts": get_metric(info, 'numberOfAnalystOpinions', 0),
                "revenue_growth": round(final_rev_growth * 100, 2),
                "profit_margin": round(profit_margin * 100, 2),
                "forward_pe": forward_pe
            },
            "periodBasis": (
                f"TTM through {max(financials.columns).date()}" if ttm_applied
                else f"FY ending {max(financials.columns).date()}"
            ),
            "dataQualityFlags": check_margin_consistency(
                round(profit_margin * 100, 2),
                hist_net_margin[-1] if hist_net_margin else 0.0,
            ) + ([
                "financials.historical_* final entry is a TTM built from the last four "
                "reported quarters (annual statement was stale); prior entries are fiscal "
                "years, so Piotroski year-over-year comparisons overlap by ~9 months."
            ] if ttm_applied else [])
        }

        # Analysis page overview (company_overview.py); never allowed to break the payload
        try:
            result["overview"] = build_overview(stock)
        except Exception as e:
            print(f"Overview build failed: {e}", file=sys.stderr)
            result["overview"] = None

        # 3. Save to Cache
        result = sanitize_json_data(result)
        save_to_cache(ticker_symbol, result)

        print(json.dumps(result, indent=2, cls=NpEncoder))

    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("ticker")
    parser.add_argument("--no-cache", action="store_true", help="Skip cache and fetch fresh data")
    args = parser.parse_args()
    fetch_financial_data(args.ticker, no_cache=args.no_cache)