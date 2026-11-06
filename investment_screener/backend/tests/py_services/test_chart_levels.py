"""
test_chart_levels.py - chart_levels.py guards used by the Analysis page chart (S6 rewrite):
the 200-day EMA is only a level with a full 200 sessions, and levels can carry a short UI label.
No network: synthetic bars only.
"""
import sys
from pathlib import Path

import pandas as pd

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from chart_levels import compute_chart_levels, resistances_above, supports_below  # noqa: E402


def _bars(n):
    idx = pd.bdate_range("2023-01-02", periods=n)
    close = [100 + (i % 40) for i in range(n)]
    return pd.DataFrame({"open": close, "high": [c + 1 for c in close], "low": [c - 1 for c in close],
                         "close": close, "volume": [1000.0] * n}, index=idx)


def test_ema200_is_not_a_level_with_fewer_than_200_sessions():
    chart = compute_chart_levels(_bars(120))
    assert chart["ema200"] is None
    labels = [b for _, b in supports_below(chart, 1e9) + resistances_above(chart, 0)]
    assert not any("200-day EMA" in b for b in labels)
    assert any("50-day EMA" in b for b in labels)


def test_ema200_is_a_level_with_200_sessions():
    chart = compute_chart_levels(_bars(260))
    assert chart["ema200"] is not None
    assert any("200-day EMA" in b for _, b in supports_below(chart, 1e9))


def test_short_labels_for_ui():
    chart = compute_chart_levels(_bars(260))
    short = [b for _, b in supports_below(chart, 1e9, short=True)]
    assert any(b.startswith("Fibonacci 0.") for b in short)
    assert "EMA 200 días" in short and "EMA 50 días" in short
    assert any(b.startswith("Zona de volumen $") for b in short)
    assert supports_below(chart, 1e9) == supports_below(chart, 1e9, short=False)   # default labels unchanged
