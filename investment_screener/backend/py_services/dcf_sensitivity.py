#!/usr/bin/env python3
"""
dcf_sensitivity.py (Python Service)
=====================================

Purpose:
    Two views of DCF fair-value uncertainty: a 2D sensitivity grid across
    (growthRate x exitPE), and a Monte Carlo simulation sampling growth/
    margin/exitPE from triangular distributions anchored on the existing
    bear/base/bull scenario params, producing P10/P50/P90 fair value and
    P(fairValue < currentPrice), plus the full
    distribution (24-bin histogram, mean, min, max, P25, P75, P(undervalued)).

Layer: Backend / Python Services / Valuation Math

Usage:
    python3 dcf_sensitivity.py --scenarios scenarios.json --revenue 1000000000 \
        --shares 100000000 --price 45.00 --mode grid --pretty
    python3 dcf_sensitivity.py --scenarios scenarios.json --revenue 1000000000 \
        --shares 100000000 --price 45.00 --mode montecarlo --n 5000 --seed 42 --pretty

Key Functions:
    - sensitivity_grid() - Fair value across (growthRate +/- step*points) x (exitPE +/- step*points)
    - monte_carlo() - Triangular-distribution sampling -> P10/P50/P90 + P(overvalued)

Key Input Dependencies:
    - The scenarios JSON passed with --scenarios (bear/base/bull keys), plus the --revenue and --shares arguments
"""

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from dcf_scenarios import compute_scenario  # noqa: E402

HISTOGRAM_BINS = 24


def sensitivity_grid(
    base_scenario: dict,
    discount_rate: float,
    horizon: int,
    base_revenue: float,
    base_shares: float,
    growth_step: float = 5.0,
    growth_points: int = 3,
    pe_step: float = 4.0,
    pe_points: int = 3,
) -> dict:
    """2D grid of fair value across (growthRate +/- growth_step*growth_points)
    x (exitPE +/- pe_step*pe_points), holding margin/qualityMultiplier/
    shareChange fixed at base_scenario's values.

    Args:
        base_scenario: dict with at least growthRate, netMargin, exitPE,
            qualityMultiplier, shareChange (the DCF `base` case).
        discount_rate: Annual discount rate (decimal).
        horizon: Years to project.
        base_revenue: TTM base revenue in dollars.
        base_shares: Base share count.
        growth_step: pp step size for the growth axis.
        growth_points: Number of steps on each side of center for growth.
        pe_step: Step size (PE turns) for the exit-PE axis.
        pe_points: Number of steps on each side of center for exit PE.

    Returns:
        {"grid": [{"growthRate": float, "exitPE": float, "fairValue": float}, ...]}
    """
    center_growth = base_scenario["growthRate"]
    center_pe = base_scenario["exitPE"]
    growths = [center_growth + i * growth_step for i in range(-growth_points, growth_points + 1)]
    pes = [center_pe + i * pe_step for i in range(-pe_points, pe_points + 1)]

    grid = []
    for g in growths:
        for pe in pes:
            if pe <= 0:
                continue
            trial = {**base_scenario, "growthRate": g, "exitPE": pe}
            fair_value = compute_scenario(base_revenue, base_shares, discount_rate, horizon, trial)[
                "presentValue"
            ]
            grid.append({"growthRate": round(g, 2), "exitPE": round(pe, 2), "fairValue": fair_value})

    return {"grid": grid}


def monte_carlo(
    bear: dict,
    base: dict,
    bull: dict,
    discount_rate: float,
    horizon: int,
    base_revenue: float,
    base_shares: float,
    current_price: float,
    n: int = 5000,
    seed: int | None = None,
) -> dict:
    """Monte Carlo fair-value distribution: growth/margin/exitPE sampled
    independently from triangular(bear, base, bull) distributions, holding
    qualityMultiplier and shareChange fixed at `base`'s values.

    Args:
        bear: Bear-case scenario params (min of each triangular distribution).
        base: Base-case scenario params (mode of each triangular distribution).
        bull: Bull-case scenario params (max of each triangular distribution).
        discount_rate: Annual discount rate (decimal).
        horizon: Years to project.
        base_revenue: TTM base revenue in dollars.
        base_shares: Base share count.
        current_price: Current market price, for the P(overvalued) calc.
        n: Number of Monte Carlo samples.
        seed: RNG seed for reproducibility (None = nondeterministic).

    Returns:
        {"p10", "p50", "p90", "probabilityOvervalued", "n", "seed",
         "histogram": {"bins": [24 + 1 edges], "counts": [24 ints]},
         "mean", "min", "max", "p25", "p75", "probabilityUndervalued"}
    """
    rng = np.random.default_rng(seed)
    fair_values = []
    for _ in range(n):
        growth = rng.triangular(bear["growthRate"], base["growthRate"], bull["growthRate"])
        margin = rng.triangular(bear["netMargin"], base["netMargin"], bull["netMargin"])
        exit_pe = rng.triangular(bear["exitPE"], base["exitPE"], bull["exitPE"])
        trial = {
            "weight": 1.0, "growthRate": growth, "netMargin": margin, "exitPE": exit_pe,
            "qualityMultiplier": base["qualityMultiplier"], "shareChange": base["shareChange"],
        }
        fair_values.append(
            compute_scenario(base_revenue, base_shares, discount_rate, horizon, trial)["presentValue"]
        )

    p10 = float(np.percentile(fair_values, 10))
    p50 = float(np.percentile(fair_values, 50))
    p90 = float(np.percentile(fair_values, 90))
    probability_overvalued = sum(1 for fv in fair_values if fv < current_price) / n

    counts, edges = np.histogram(fair_values, bins=HISTOGRAM_BINS)
    probability_overvalued = round(probability_overvalued, 4)

    return {
        "p10": round(p10, 2), "p50": round(p50, 2), "p90": round(p90, 2),
        "probabilityOvervalued": probability_overvalued,
        "n": n, "seed": seed,
        "histogram": {"bins": [round(float(e), 2) for e in edges], "counts": [int(c) for c in counts]},
        "mean": round(float(np.mean(fair_values)), 2),
        "min": round(float(np.min(fair_values)), 2),
        "max": round(float(np.max(fair_values)), 2),
        "p25": round(float(np.percentile(fair_values, 25)), 2),
        "p75": round(float(np.percentile(fair_values, 75)), 2),
        "probabilityUndervalued": round(1 - probability_overvalued, 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="DCF sensitivity grid + Monte Carlo")
    parser.add_argument("--scenarios", required=True, help="Path to scenarios JSON (bear/base/bull keys)")
    parser.add_argument("--revenue", type=float, required=True)
    parser.add_argument("--shares", type=float, required=True)
    parser.add_argument("--price", type=float, required=True)
    parser.add_argument("--discount-rate", type=float, default=0.10)
    parser.add_argument("--horizon", type=int, default=5)
    parser.add_argument("--mode", choices=["grid", "montecarlo"], required=True)
    parser.add_argument("--n", type=int, default=5000)
    parser.add_argument("--seed", type=int, default=None)
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()

    with open(args.scenarios) as f:
        scenarios = json.load(f)

    if args.mode == "grid":
        result = sensitivity_grid(
            scenarios["base"], args.discount_rate, args.horizon, args.revenue, args.shares
        )
    else:
        result = monte_carlo(
            scenarios["bear"], scenarios["base"], scenarios["bull"],
            args.discount_rate, args.horizon, args.revenue, args.shares,
            args.price, n=args.n, seed=args.seed,
        )

    print(json.dumps(result, indent=2 if args.pretty else None))


if __name__ == "__main__":
    main()
