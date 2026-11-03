#!/usr/bin/env python3
"""portfolio_optimizer.py — THE portfolio risk reading and weight optimizer of the Portafolio page.

Purpose:
    Read-only service over ``domain_model.sqlite`` (never writes; the file is opened with
    SQLite's read-only mode). Two modes:

    ``--risk``: per-holding risk table from the latest ``stock_risk_metrics`` row of each
    symbol (computed by ``risk_metrics`` through ``price_risk``; no formula is repeated here).
    ``risk_contribution_pct`` is weight x volatility normalised to 100 across holdings, so it
    IGNORES CORRELATIONS, and ``portfolio.volatility_ann`` is the same naive weighted sum.
    A holding with no stored volatility takes the median volatility of the others and is
    flagged ``estimated: true``.

    ``--optimize <objective>`` (``min_volatility`` | ``risk_parity`` | ``max_sharpe``): three
    years of daily closes through ``price_risk.yfinance_closes`` (injectable downloader) feed
    PyPortfolioOpt: Ledoit-Wolf covariance, historical mean return, ``EfficientFrontier``
    (min_volatility / max_sharpe) or ``HRPOpt`` (risk_parity), weights cleaned. Holdings with
    less than ``MIN_OBSERVATIONS`` closes are excluded, named in ``warnings``, keep their
    current value, and the targets of the rest are scaled to the value they hold. Orders are
    target minus current value at the stored price, sells before buys, skipping amounts under
    ``MIN_ORDER_USD``.

    The two volatility figures DIFFER ON PURPOSE: ``effect.volatility_before/after`` are the
    true portfolio volatility sqrt(w'Sw) from the same Ledoit-Wolf covariance matrix, applied to
    the current and to the target weights of the optimized holdings (renormalised to 1), while
    ``--risk`` reports the naive figure. ``effect.top_risk_*`` use the naive contribution of
    ``--risk`` over all holdings (target weights after, current before) so they match the table.

Layer:
    Backend / Python Services

Usage Examples:
    python3 portfolio_optimizer.py --risk --json
    python3 portfolio_optimizer.py --optimize risk_parity --json

Key Functions (Index):
    - load_holdings(conn) / load_metrics(conn): the stored positions and risk rows
    - risk_contributions(weights, vols): the naive weight x volatility shares
    - risk_report(db_path): the --risk payload
    - optimize(db_path, objective, downloader, min_order_usd): the --optimize payload
    - main(argv): CLI

Key Input Dependencies:
    - domain_model.sqlite (account_investment, investment, investment_price, stock_risk_metrics)
    - risk_metrics, investment_sources/price_risk.py, ticker_aliases.py, PyPortfolioOpt

Key Output Dependencies:
    - src/routes/portfolioRisk.ts (spawns this script and returns its JSON)
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import sys
from datetime import date
from pathlib import Path
from typing import Callable, Sequence

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from investment_sources.price_risk import DEFAULT_PERIOD, yfinance_closes  # noqa: E402
from investment_sources.yfinance_enrichment import yfinance_symbol  # noqa: E402
from risk_metrics import MIN_OBSERVATIONS, RISK_FREE_ANNUAL  # noqa: E402
from ticker_aliases import is_cash, normalize_ticker  # noqa: E402

OBJECTIVES = ("min_volatility", "risk_parity", "max_sharpe")
#: Orders smaller than this are noise (USD).
MIN_ORDER_USD = 25.0
_DB_PATH = str(Path(__file__).resolve().parent.parent / "data" / "domain_model.sqlite")

Downloader = Callable[[Sequence[str], str], pd.DataFrame]


def _connect_readonly(db_path: str) -> sqlite3.Connection:
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def load_holdings(conn: sqlite3.Connection) -> list[dict]:
    """Priced, non-cash positions aggregated across accounts: ticker, shares, price, value."""
    rows = conn.execute(
        """
        SELECT i.symbol AS ticker, SUM(ai.quantity) AS shares, MAX(ip.price) AS price
        FROM account_investment ai
        JOIN investment i ON i.investment_id = ai.investment_id
        JOIN investment_price ip ON ip.investment_id = ai.investment_id
        GROUP BY i.symbol HAVING SUM(ai.quantity) > 0
        ORDER BY i.symbol
        """
    ).fetchall()
    return [{"ticker": r["ticker"], "shares": r["shares"], "price": r["price"],
             "value": r["shares"] * r["price"]} for r in rows if not is_cash(r["ticker"])]


def _cash_usd(conn: sqlite3.Connection) -> float:
    row = conn.execute("SELECT SUM(quantity) FROM account_investment WHERE investment_id = 'CASH_USD'").fetchone()
    return float(row[0] or 0.0)


def load_metrics(conn: sqlite3.Connection) -> dict[str, sqlite3.Row]:
    """Latest stored risk row per normalized symbol (stock_risk_metrics keeps one per symbol)."""
    return {r["symbol"]: r for r in conn.execute("SELECT * FROM stock_risk_metrics")}


def risk_contributions(weights: dict[str, float], vols: dict[str, float]) -> dict[str, float]:
    """Naive risk shares in percent: weight x volatility normalised to 100 (no correlations)."""
    raw = {t: weights[t] * vols[t] for t in weights}
    total = sum(raw.values())
    return {t: (100 * v / total if total else 0.0) for t, v in raw.items()}


def _rounded(value, digits: int):
    return None if value is None else round(float(value), digits)


def _risk_inputs(conn: sqlite3.Connection):
    holdings = load_holdings(conn)
    metrics = load_metrics(conn)
    total = sum(h["value"] for h in holdings)
    stored = {h["ticker"]: metrics.get(normalize_ticker(h["ticker"])) for h in holdings}
    known = [m["volatility_ann"] for m in stored.values() if m is not None and m["volatility_ann"] is not None]
    median_vol = statistics.median(known) if known else None
    vols, estimated = {}, {}
    for h in holdings:
        m = stored[h["ticker"]]
        has = m is not None and m["volatility_ann"] is not None
        vols[h["ticker"]] = m["volatility_ann"] if has else median_vol
        estimated[h["ticker"]] = not has
    return holdings, stored, total, vols, estimated, median_vol


def risk_report(db_path: str = _DB_PATH) -> dict:
    """The ``--risk`` payload (see the module docstring for the naive-sum convention)."""
    conn = _connect_readonly(db_path)
    try:
        holdings, stored, total, vols, estimated, median_vol = _risk_inputs(conn)
        cash = _cash_usd(conn)
    finally:
        conn.close()
    # Rule 15 / computeWeightsMap: weights are of the whole portfolio, cash included, so this
    # page never disagrees with the Actual % column every other table already shows.
    base = total + cash
    weights = {h["ticker"]: (h["value"] / base if base else 0.0) for h in holdings}
    usable = {t: w for t, w in weights.items() if vols[t] is not None}
    contrib = risk_contributions(usable, vols) if usable else {}
    drawdowns = [m["max_drawdown_3y"] for m in stored.values() if m is not None and m["max_drawdown_3y"] is not None]
    rows = []
    for h in holdings:
        t, m = h["ticker"], stored[h["ticker"]]
        rows.append({
            "ticker": t, "market_value": round(h["value"], 2), "weight_pct": round(100 * weights[t], 2),
            "volatility_ann": _rounded(vols[t], 4),
            "max_drawdown_3y": _rounded(m["max_drawdown_3y"], 4) if m is not None else None,
            "sharpe_3y": _rounded(m["sharpe_3y"], 3) if m is not None else None,
            "sortino_3y": _rounded(m["sortino_3y"], 3) if m is not None else None,
            "downside_beta_3y": _rounded(m["downside_beta_3y"], 3) if m is not None else None,
            "risk_contribution_pct": round(contrib[t], 2) if t in contrib else None,
            "estimated": estimated[t],
        })
    naive = sum(weights[t] * vols[t] for t in usable)
    return {
        "as_of": date.today().isoformat(),
        "portfolio": {"volatility_ann": round(naive, 4),
                      "holdings_with_history": sum(1 for e in estimated.values() if not e),
                      "holdings_total": len(holdings), "market_value_usd": round(total, 2),
                      "cash_usd": round(cash, 2)},
        "medians": {"volatility_ann": _rounded(median_vol, 4),
                    "max_drawdown_3y": _rounded(statistics.median(drawdowns), 4) if drawdowns else None},
        "rows": rows,
    }


def _target_weights(objective: str, prices: pd.DataFrame, cov: pd.DataFrame) -> dict[str, float]:
    from pypfopt import EfficientFrontier, HRPOpt, expected_returns

    try:
        if objective == "risk_parity":
            opt = HRPOpt(prices.pct_change().dropna(), cov_matrix=cov)
            opt.optimize()
            return dict(opt.clean_weights())
        mu = expected_returns.mean_historical_return(prices)
        ef = EfficientFrontier(mu, cov)
        ef.min_volatility() if objective == "min_volatility" else ef.max_sharpe(risk_free_rate=RISK_FREE_ANNUAL)
        return dict(ef.clean_weights())
    except Exception as exc:  # pypfopt raises OptimizationError / ValueError on infeasible inputs
        raise ValueError(f"{objective}: no se pudo optimizar ({exc})") from exc


def optimize(db_path: str, objective: str, downloader: Downloader | None = None,
             min_order_usd: float = MIN_ORDER_USD) -> dict:
    """The ``--optimize`` payload; ValueError on an unknown objective or an infeasible problem."""
    if objective not in OBJECTIVES:
        raise ValueError(f"objective must be one of {', '.join(OBJECTIVES)}")
    from pypfopt import risk_models

    conn = _connect_readonly(db_path)
    try:
        holdings, _stored, total, vols, _est, _median = _risk_inputs(conn)
        cash = _cash_usd(conn)
    finally:
        conn.close()
    base = total + cash  # same denominator as risk_report: holdings plus cash
    if not holdings:
        raise ValueError("el portafolio no tiene posiciones con precio")

    lookups = {h["ticker"]: yfinance_symbol(h["ticker"]) for h in holdings}
    frame = pd.DataFrame((downloader or yfinance_closes)(list(lookups.values()), DEFAULT_PERIOD))
    eligible, warnings = [], []
    for t, lookup in lookups.items():
        n = int(pd.to_numeric(frame[lookup], errors="coerce").notna().sum()) if lookup in frame.columns else 0
        if n >= MIN_OBSERVATIONS:
            eligible.append(t)
        else:
            warnings.append(f"{t}: sin historia suficiente, excluida de la optimización")
    if len(eligible) < 2:
        raise ValueError("menos de dos posiciones con historia suficiente para optimizar")

    prices = frame[[lookups[t] for t in eligible]].apply(pd.to_numeric, errors="coerce").dropna()
    prices.columns = eligible
    cov = risk_models.CovarianceShrinkage(prices).ledoit_wolf()
    raw_weights = _target_weights(objective, prices, cov)

    by_ticker = {h["ticker"]: h for h in holdings}
    eligible_value = sum(by_ticker[t]["value"] for t in eligible)
    target_value = {h["ticker"]: h["value"] for h in holdings}
    for t in eligible:
        target_value[t] = raw_weights.get(t, 0.0) * eligible_value

    def vol_of(weights: dict[str, float]) -> float:
        w = np.array([weights[t] for t in eligible])
        return float(np.sqrt(w @ cov.loc[eligible, eligible].values @ w))

    cur_w = np.array([by_ticker[t]["value"] / eligible_value for t in eligible])
    cur = dict(zip(eligible, cur_w))
    tgt = {t: raw_weights.get(t, 0.0) for t in eligible}

    def top_risk(values: dict[str, float]) -> dict:
        shares = risk_contributions({t: v / base for t, v in values.items()}, vols)
        ticker = max(shares, key=shares.get)
        return {"ticker": ticker, "pct": round(shares[ticker], 1)}

    orders = []
    for t in eligible:
        diff = target_value[t] - by_ticker[t]["value"]
        if abs(diff) >= min_order_usd:
            orders.append({"action": "BUY" if diff > 0 else "SELL", "ticker": t,
                           "shares": round(abs(diff) / by_ticker[t]["price"], 4),
                           "amount_usd": round(abs(diff), 2)})
    orders.sort(key=lambda o: (o["action"] != "SELL", o["ticker"]))
    flow = sum(o["amount_usd"] * (1 if o["action"] == "SELL" else -1) for o in orders)

    return {
        "objective": objective, "as_of": date.today().isoformat(),
        "weights": [{"ticker": h["ticker"], "current_pct": round(100 * h["value"] / base, 2),
                     "target_pct": round(100 * target_value[h["ticker"]] / base, 2)} for h in holdings],
        "orders": orders,
        "effect": {"volatility_before": round(vol_of(cur), 4), "volatility_after": round(vol_of(tgt), 4),
                   "top_risk_before": top_risk({h["ticker"]: h["value"] for h in holdings}),
                   "top_risk_after": top_risk(target_value)},
        "cash_after_usd": round(cash + flow, 2),
        "warnings": warnings,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Portfolio risk reading and weight optimizer (read-only).")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--risk", action="store_true")
    mode.add_argument("--optimize", choices=OBJECTIVES, metavar="OBJECTIVE")
    parser.add_argument("--json", action="store_true", help="print JSON (the only output format)")
    parser.add_argument("--db", default=_DB_PATH)
    args = parser.parse_args(argv)
    try:
        payload = risk_report(args.db) if args.risk else optimize(args.db, args.optimize)
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}))
        return 1
    print(json.dumps(payload))
    return 0


if __name__ == "__main__":
    sys.exit(main())
