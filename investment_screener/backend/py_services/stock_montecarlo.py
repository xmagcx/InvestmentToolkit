#!/usr/bin/env python3
"""
stock_montecarlo.py - Monte Carlo fair-value distribution for one ticker (S13).

Purpose:
    Orchestrates dcf_sensitivity.monte_carlo() on the ticker's latest projection:
    bear/base/bull scenario params, discount rate, horizon, base revenue and shares
    come from domain_model.sqlite, the current price is the stored investment_price.
    Read-only (the database is opened with mode=ro). Never fabricates: a missing
    projection, scenario, input or price returns {"error": ...} instead of a result.

Layer:
    Backend / Python Services / Valuation Math

Usage Examples:
    python3 stock_montecarlo.py MSFT
    python3 stock_montecarlo.py MSFT --db /path/to/domain_model.sqlite --n 10000 --seed 42

Input mapping (mirrors ProjectionRepository.projectionMetadata in the Express side):
    projection        value_history.preferred_projection (the one recommendation.py uses)
    scenarios         projection_scenario rows bear/base/bull (growth_rate, net_margin,
                      exit_pe, plus quality_multiplier and share_change on base)
    discount rate     analytics_log valuationModel.discountRateAudit.selectedRate,
                      else snapshot.discountRate, else analytics_log.wacc (decimal)
    horizon           snapshot.horizon, default 5
    revenue / shares  snapshot.revenue|baseRevenue, snapshot.shares|baseShares
    price             investment_price.price

Key Functions (Index):
    - run_montecarlo(ticker, db_path, n, seed) - payload dict, or {"error", "message"}

Key Input Dependencies:
    - domain_model.sqlite (projection_version, projection_scenario, investment_price)

Key Output Dependencies:
    - routes/stock.ts (GET /api/stock/:ticker/montecarlo)
"""

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dcf_scenarios import compute_scenario  # noqa: E402
from dcf_sensitivity import monte_carlo  # noqa: E402
from domain_model.investment_price_repository import get_investment_price  # noqa: E402
from domain_model.projection_repository import get_projection_scenarios  # noqa: E402
from ticker_aliases import normalize_ticker  # noqa: E402
from value_history import DEFAULT_DB, find_investment_id, open_readonly, preferred_projection  # noqa: E402

SCENARIO_NAMES = ("bear", "base", "bull")
_COLUMNS = {"growthRate": "growth_rate", "netMargin": "net_margin", "exitPE": "exit_pe",
            "qualityMultiplier": "quality_multiplier", "shareChange": "share_change"}


def _no_projection(message: str) -> dict:
    return {"error": "no_projection", "message": message}


def _scenario_params(rows: list[dict]) -> tuple[dict | None, str]:
    by_name = {r["scenario_name"]: r for r in rows}
    params = {}
    for name in SCENARIO_NAMES:
        row = by_name.get(name)
        if row is None:
            return None, f"missing scenario '{name}'"
        values = {key: row[col] for key, col in _COLUMNS.items()}
        required = list(_COLUMNS) if name == "base" else ["growthRate", "netMargin", "exitPE"]
        missing = [k for k in required if values[k] is None]
        if missing:
            return None, f"scenario '{name}' missing {', '.join(missing)}"
        params[name] = {"weight": row["weight"] if row["weight"] is not None else 1.0,
                        **{k: v for k, v in values.items() if v is not None}}
    return params, ""


def run_montecarlo(ticker: str, db_path: str, n: int = 10000, seed: int = 42) -> dict:
    symbol = normalize_ticker(ticker.upper())
    conn = open_readonly(db_path)
    try:
        inv_id = find_investment_id(conn, symbol)
        entry = preferred_projection(conn, inv_id) if inv_id else None
        if not entry:
            return _no_projection(f"no saved projection for {symbol}")
        rows = get_projection_scenarios(conn, entry["projection_id"])
        price_row = get_investment_price(conn, inv_id)
    finally:
        conn.close()

    params, why = _scenario_params(rows)
    if params is None:
        return _no_projection(f"projection for {symbol} is incomplete: {why}")

    snap = json.loads(entry.get("snapshot_json") or "{}")
    log = json.loads(entry.get("analytics_log_json") or "{}")
    log = log if isinstance(log, dict) else {}
    rate = ((log.get("valuationModel") or {}).get("discountRateAudit") or {}).get("selectedRate")
    if rate is None:
        rate = snap.get("discountRate", log.get("wacc"))
    revenue = snap.get("revenue", snap.get("baseRevenue"))
    shares = snap.get("shares", snap.get("baseShares"))
    missing = [k for k, v in (("discount rate", rate), ("revenue", revenue), ("shares", shares)) if not v]
    if missing:
        return _no_projection(f"projection for {symbol} is incomplete: missing {', '.join(missing)}")
    horizon = int(snap.get("horizon") or 5)

    price = price_row.get("price") if price_row else None
    if not price or price <= 0:
        return {"error": "no_price", "message": f"no stored price for {symbol}"}

    scenarios = {}
    for name in SCENARIO_NAMES:
        p = params[name]
        full = {**params["base"], **p} if name != "base" else p
        pv = compute_scenario(revenue, shares, rate, horizon, full)["presentValue"]
        scenarios[name] = {"growthRate": p["growthRate"], "netMargin": p["netMargin"],
                           "exitPE": p["exitPE"], "presentValue": pv}
    result = monte_carlo(params["bear"], params["base"], params["bull"], rate, horizon,
                         revenue, shares, price, n=n, seed=seed)
    return {"ticker": symbol, "n": n, "seed": seed, "price": price, "scenarios": scenarios, "result": result}


def main() -> None:
    parser = argparse.ArgumentParser(description="Monte Carlo fair value for one ticker")
    parser.add_argument("ticker")
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--n", type=int, default=10000)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()
    try:
        print(json.dumps(run_montecarlo(args.ticker, args.db, args.n, args.seed)))
    except Exception as e:
        print(json.dumps({"error": "failed", "message": str(e)}))


if __name__ == "__main__":
    main()
