"""
test_value_history.py - price vs fair value series for the Analysis page chart (S6).
Fair value is a step function over the ticker's projection revisions (same
revision selection rule as recommendation.py); no network, fixture DB only.
"""
import json
import sqlite3
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
PY = REPO_ROOT / "investment_screener/backend/py_services"
sys.path.insert(0, str(PY))

from domain_model.db_client import initialize_db  # noqa: E402
from domain_model.projection_repository import save_projection_version  # noqa: E402
from value_history import build_series, build_value_history, load_revisions  # noqa: E402

CLOSES = [("2024-01-02", 10.0), ("2024-02-01", 11.0), ("2024-03-01", 12.0), ("2024-04-01", 13.0)]
TODAY = date(2024, 4, 15)


def test_fair_value_is_a_step_function_null_before_first_revision():
    pts = build_series(CLOSES, [("2024-02-01", 20.0), ("2024-03-15", 30.0)], "max", TODAY)
    assert [p["fair_value"] for p in pts] == [None, 20.0, 20.0, 30.0]
    assert [p["price"] for p in pts] == [10.0, 11.0, 12.0, 13.0]
    assert pts[0]["date"] == "2024-01-02"


def test_no_revisions_means_null_everywhere():
    pts = build_series(CLOSES, [], "max", TODAY)
    assert all(p["fair_value"] is None for p in pts)


def test_range_cut_drops_old_points_but_keeps_earlier_revision_in_effect():
    pts = build_series(CLOSES, [("2023-06-01", 20.0)], "1y", date(2025, 2, 15))  # window starts 2024-02-16
    assert [p["date"] for p in pts] == ["2024-03-01", "2024-04-01"]
    assert [p["fair_value"] for p in pts] == [20.0, 20.0]


def test_max_range_keeps_every_point():
    assert len(build_series(CLOSES, [], "max", date(2030, 1, 1))) == 4


def _db(tmp_path):
    path = str(tmp_path / "d.sqlite")
    conn = initialize_db(path)
    conn.execute("INSERT INTO investment (investment_id, symbol, name, asset_class, currency, updated_at) "
                 "VALUES ('PSU-U.TO','PSU-U.TO','PSU','ETF','CAD','2024-01-01')")
    conn.commit()
    return path, conn


def test_load_revisions_normalizes_alias_and_prefers_ai_agent(tmp_path):
    path, conn = _db(tmp_path)
    save_projection_version(conn, "PSU-U.TO", 1, "2024-01-10T00:00:00Z", fair_value=5.0, source="MANUAL")
    save_projection_version(conn, "PSU-U.TO", 2, "2024-02-10T00:00:00Z", fair_value=6.0, source="AI_AGENT")
    save_projection_version(conn, "PSU-U.TO", 3, "2024-03-10T00:00:00Z", fair_value=None, source="AI_AGENT")
    save_projection_version(conn, "PSU-U.TO", 4, "2024-04-10T00:00:00Z", fair_value=7.0, source="AI_AGENT")
    conn.close()
    assert load_revisions(path, "PSU.U") == [("2024-02-10", 6.0), ("2024-04-10", 7.0)]


def test_load_revisions_without_ai_agent_uses_all_and_unknown_ticker_is_empty(tmp_path):
    path, conn = _db(tmp_path)
    save_projection_version(conn, "PSU-U.TO", 1, "2024-01-10T00:00:00Z", fair_value=5.0, source="MANUAL")
    conn.close()
    assert load_revisions(path, "PSU-U.TO") == [("2024-01-10", 5.0)]
    assert load_revisions(path, "NOPE") == []


def test_build_value_history_shape_and_current(tmp_path):
    path, conn = _db(tmp_path)
    save_projection_version(conn, "PSU-U.TO", 1, "2024-02-10T00:00:00Z", fair_value=6.0, source="AI_AGENT")
    conn.close()
    out = build_value_history("PSU.U", "max", path, closes=CLOSES, currency="CAD", today=TODAY)
    assert out["ticker"] == "PSU-U.TO" and out["currency"] == "CAD"
    assert {k: out["current"][k] for k in ("price", "fair_value", "date")} == {"price": 13.0, "fair_value": 6.0, "date": "2024-04-01"}
    assert [p["fair_value"] for p in out["points"]] == [None, None, 6.0, 6.0]


def test_build_value_history_without_projection_has_null_fair_value(tmp_path):
    path, conn = _db(tmp_path)
    conn.close()
    out = build_value_history("PSU-U.TO", "max", path, closes=CLOSES, currency="CAD", today=TODAY)
    assert out["current"]["fair_value"] is None
    assert all(p["fair_value"] is None for p in out["points"])


# --- T8 / S6 rewrite: SMA200 zones + chart levels -------------------------------------------------
import pandas as pd  # noqa: E402

from value_history import build_value_history as _bvh, current_block  # noqa: E402


def _daily(n, start=date(2023, 1, 2)):
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append((d.isoformat(), float(len(out) + 1)))
        d += timedelta(days=1)
    return out


from datetime import timedelta  # noqa: E402


def test_sma200_is_null_under_200_sessions_and_a_plain_mean_after():
    daily = _daily(250)
    pts = build_series(daily, [], "max", date(2030, 1, 1))
    assert all(p["sma200"] is None for p in pts[:199])
    assert pts[199]["sma200"] == 100.5          # mean(1..200)
    assert pts[249]["sma200"] == 150.5          # mean(51..250)


def test_fewer_than_200_sessions_gives_null_sma_everywhere():
    pts = build_series(_daily(150), [], "max", date(2030, 1, 1))
    assert all(p["sma200"] is None for p in pts)


def test_range_cut_keeps_sma200_computed_on_full_history():
    daily = _daily(600)
    last = date.fromisoformat(daily[-1][0])
    pts = build_series(daily, [], "1y", last)
    assert len(pts) < 400 and pts[0]["date"] >= (last - timedelta(days=365)).isoformat()
    assert pts[0]["sma200"] is not None          # exists from the first visible point
    assert pts[-1]["sma200"] == sum(c for _, c in daily[-200:]) / 200


def test_weekly_points_take_sma200_from_the_daily_series_at_that_date():
    daily = _daily(400)
    weekly = [daily[i] for i in range(0, 400, 5)]
    pts = build_series(weekly, [], "max", date(2030, 1, 1), daily=daily)
    assert len(pts) == len(weekly)
    w = weekly[60]                                # daily index 300
    assert pts[60]["sma200"] == sum(c for _, c in daily[101:301]) / 200
    assert pts[0]["sma200"] is None


LEVELS = {"supports": [{"price": 88.0, "basis": "Fibonacci 0.618"}, {"price": 80.0, "basis": "EMA 50 días"}],
          "resistances": [{"price": 112.0, "basis": "Zona de volumen $110–$112 (techo)"}, {"price": 120.0, "basis": "EMA 200 días"}]}


def test_infravalorada_zone_distance_and_nearest_support_confirmation():
    cur = current_block(90.0, 100.0, LEVELS)
    assert cur["sma200"] == 100.0 and cur["zone"] == "infravalorada"
    assert cur["distance_pct"] == -10.0
    assert cur["confirmation"] == {"price": 88.0, "basis": "Fibonacci 0.618", "distance_pct": -2.22}


def test_sobrevalorada_zone_uses_nearest_resistance_above():
    cur = current_block(110.0, 100.0, LEVELS)
    assert cur["zone"] == "sobrevalorada" and cur["distance_pct"] == 10.0
    assert cur["confirmation"] == {"price": 112.0, "basis": "Zona de volumen $110–$112 (techo)", "distance_pct": 1.82}


def test_no_sma_or_equal_price_has_no_zone_and_no_confirmation():
    assert current_block(90.0, None, LEVELS) == {"sma200": None, "zone": None, "distance_pct": None, "confirmation": None}
    cur = current_block(100.0, 100.0, LEVELS)
    assert cur["zone"] is None and cur["distance_pct"] == 0.0 and cur["confirmation"] is None


def test_zone_without_a_level_on_that_side_has_null_confirmation():
    assert current_block(90.0, 100.0, {"supports": [], "resistances": LEVELS["resistances"]})["confirmation"] is None
    assert current_block(90.0, 100.0, None)["confirmation"] is None


def _bars(n):
    idx = pd.bdate_range("2023-01-02", periods=n)
    close = [100 + i * 0.5 if i < n - 40 else 100 + (n - 40) * 0.5 - (i - (n - 40)) * 1.5 for i in range(n)]
    return pd.DataFrame({"open": close, "high": [c + 1 for c in close], "low": [c - 1 for c in close],
                         "close": close, "volume": [1000.0] * n}, index=idx)


def test_build_value_history_adds_levels_current_and_keeps_existing_keys(tmp_path):
    path, conn = _db(tmp_path)
    conn.close()
    bars = _bars(300)
    daily = [(i.date().isoformat(), float(c)) for i, c in bars["close"].items()]
    out = _bvh("PSU-U.TO", "max", path, closes=daily, currency="CAD", today=date(2030, 1, 1), bars=bars)
    assert {"ticker", "currency", "points"} <= set(out)
    assert {"price", "fair_value", "date"} <= set(out["current"])
    price, sma = out["current"]["price"], out["current"]["sma200"]
    assert sma == out["points"][-1]["sma200"] and sma is not None
    assert out["current"]["zone"] == ("infravalorada" if price < sma else "sobrevalorada")
    assert out["current"]["distance_pct"] == round((price - sma) / sma * 100, 2)
    lv = out["levels"]
    assert len(lv["supports"]) <= 3 and len(lv["resistances"]) <= 3
    assert all(s["price"] < price and s["basis"] for s in lv["supports"])
    assert all(r["price"] > price and r["basis"] for r in lv["resistances"])
    assert [s["price"] for s in lv["supports"]] == sorted((s["price"] for s in lv["supports"]), reverse=True)


def test_without_bars_levels_are_empty_and_confirmation_null(tmp_path):
    path, conn = _db(tmp_path)
    conn.close()
    out = _bvh("PSU-U.TO", "max", path, closes=CLOSES, currency="CAD", today=TODAY)
    assert out["levels"] == {"supports": [], "resistances": []}
    assert out["current"]["sma200"] is None and out["current"]["zone"] is None
    assert out["current"]["confirmation"] is None
