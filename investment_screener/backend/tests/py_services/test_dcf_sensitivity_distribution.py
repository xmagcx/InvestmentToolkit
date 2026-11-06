"""
test_dcf_sensitivity_distribution.py - monte_carlo() also returns the simulated
distribution (histogram, mean, min, max, p25, p75, probabilityUndervalued) for the
Analysis page Monte Carlo tab (S13) while every earlier key stays byte-identical.
"""
import sys
from pathlib import Path

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from dcf_sensitivity import monte_carlo  # noqa: E402

BEAR = {"growthRate": 10.0, "netMargin": 15.0, "exitPE": 20.0, "qualityMultiplier": 1.0, "shareChange": 0.0}
BASE = {"growthRate": 22.0, "netMargin": 25.0, "exitPE": 30.0, "qualityMultiplier": 1.0, "shareChange": 0.0}
BULL = {"growthRate": 35.0, "netMargin": 32.0, "exitPE": 40.0, "qualityMultiplier": 1.0, "shareChange": 0.0}


def _run(price=120.0, n=2000, seed=7):
    return monte_carlo(BEAR, BASE, BULL, 0.10, 5, 1e9, 1e8, price, n=n, seed=seed)


def test_existing_keys_unchanged_for_fixed_seed():
    # Values captured from monte_carlo() before the distribution keys were added.
    r = _run()
    assert (r["p10"], r["p50"], r["p90"]) == (81.46, 119.5, 171.98)
    assert r["probabilityOvervalued"] == 0.5065
    assert (r["n"], r["seed"]) == (2000, 7)


def test_histogram_has_24_bins_and_counts_sum_to_n():
    h = _run()["histogram"]
    assert len(h["counts"]) == 24
    assert len(h["bins"]) == len(h["counts"]) + 1
    assert sum(h["counts"]) == 2000
    assert h["bins"] == sorted(h["bins"])


def test_stats_are_ordered_and_consistent():
    r = _run()
    assert r["min"] <= r["p10"] <= r["p25"] <= r["p50"] <= r["p75"] <= r["p90"] <= r["max"]
    assert r["min"] <= r["mean"] <= r["max"]
    assert r["probabilityUndervalued"] == round(1 - r["probabilityOvervalued"], 4)
    assert r["histogram"]["bins"][0] == r["min"]
    assert r["histogram"]["bins"][-1] == r["max"]
