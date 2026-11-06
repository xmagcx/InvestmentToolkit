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
    assert out["current"] == {"price": 13.0, "fair_value": 6.0, "date": "2024-04-01"}
    assert [p["fair_value"] for p in out["points"]] == [None, None, 6.0, 6.0]


def test_build_value_history_without_projection_has_null_fair_value(tmp_path):
    path, conn = _db(tmp_path)
    conn.close()
    out = build_value_history("PSU-U.TO", "max", path, closes=CLOSES, currency="CAD", today=TODAY)
    assert out["current"]["fair_value"] is None
    assert all(p["fair_value"] is None for p in out["points"])
