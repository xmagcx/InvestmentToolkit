"""
test_stock_montecarlo.py - Monte Carlo orchestration for one ticker (S13): latest
projection scenarios + discount rate + horizon + base revenue/shares + stored price
feed dcf_sensitivity.monte_carlo. Never fabricates: no projection / missing params
-> {"error": ...}. Fixture DB only; investment_price is read, never written.
"""
import json
import sys
from pathlib import Path

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from dcf_sensitivity import monte_carlo  # noqa: E402
from domain_model.db_client import initialize_db  # noqa: E402
from domain_model.investment_price_repository import upsert_investment_price  # noqa: E402
from domain_model.projection_repository import add_projection_scenario, save_projection_version  # noqa: E402
from stock_montecarlo import run_montecarlo  # noqa: E402

SCEN = {
    "bear": (10.0, 15.0, 20.0), "base": (22.0, 25.0, 30.0), "bull": (35.0, 32.0, 40.0),
}


def _db(tmp_path, with_price=True, scenarios=("bear", "base", "bull"), snapshot=None, log=None, source="AI_AGENT"):
    path = str(tmp_path / "d.sqlite")
    conn = initialize_db(path)
    conn.execute("INSERT INTO investment (investment_id, symbol, name, asset_class, currency, updated_at) "
                 "VALUES ('ZZZ','ZZZ','Z','EQUITY','USD','2024-01-01')")
    conn.commit()
    snap = snapshot if snapshot is not None else {"revenue": 1e9, "shares": 1e8, "horizon": 5}
    pid = save_projection_version(
        conn, "ZZZ", 1, "2024-02-10T00:00:00Z", fair_value=100.0, source=source,
        snapshot_json=json.dumps(snap),
        analytics_log_json=json.dumps(log if log is not None else {"wacc": 0.10}),
    )
    for name in scenarios:
        g, m, pe = SCEN[name]
        add_projection_scenario(conn, pid, name, weight=0.3, growth_rate=g, net_margin=m, exit_pe=pe,
                                quality_multiplier=1.0, share_change=0.0)
    if with_price:
        upsert_investment_price(conn, "ZZZ", 120.0, "USD", "2024-04-01T00:00:00Z")
    conn.close()
    return path


def test_run_matches_direct_monte_carlo_and_reports_inputs(tmp_path):
    out = run_montecarlo("ZZZ", _db(tmp_path))
    exp = monte_carlo(
        {"growthRate": 10.0, "netMargin": 15.0, "exitPE": 20.0, "qualityMultiplier": 1.0, "shareChange": 0.0},
        {"growthRate": 22.0, "netMargin": 25.0, "exitPE": 30.0, "qualityMultiplier": 1.0, "shareChange": 0.0},
        {"growthRate": 35.0, "netMargin": 32.0, "exitPE": 40.0, "qualityMultiplier": 1.0, "shareChange": 0.0},
        0.10, 5, 1e9, 1e8, 120.0, n=10000, seed=42,
    )
    assert out["result"] == exp
    assert (out["ticker"], out["n"], out["seed"], out["price"]) == ("ZZZ", 10000, 42, 120.0)
    assert set(out["scenarios"]) == {"bear", "base", "bull"}
    base = out["scenarios"]["base"]
    assert (base["growthRate"], base["netMargin"], base["exitPE"]) == (22.0, 25.0, 30.0)
    assert isinstance(base["presentValue"], float)
    assert out["scenarios"]["bear"]["presentValue"] < base["presentValue"] < out["scenarios"]["bull"]["presentValue"]


def test_discount_rate_prefers_audited_rate_and_database_is_not_modified(tmp_path):
    (tmp_path / "a").mkdir()
    (tmp_path / "b").mkdir()
    audited = _db(tmp_path / "a", log={"wacc": 0.10, "valuationModel": {"discountRateAudit": {"selectedRate": 0.08}}})
    plain = _db(tmp_path / "b", log={"wacc": 0.10})
    before = Path(audited).read_bytes()
    pv_audited = run_montecarlo("ZZZ", audited, n=200)["scenarios"]["base"]["presentValue"]
    pv_plain = run_montecarlo("ZZZ", plain, n=200)["scenarios"]["base"]["presentValue"]
    assert pv_audited > pv_plain  # lower discount rate -> higher present value
    assert Path(audited).read_bytes() == before


def test_missing_projection_is_an_error_not_a_result(tmp_path):
    path = _db(tmp_path)
    assert run_montecarlo("NOPE", path)["error"] == "no_projection"


def test_missing_scenario_is_no_projection(tmp_path):
    out = run_montecarlo("ZZZ", _db(tmp_path, scenarios=("bear", "base")))
    assert out["error"] == "no_projection" and "bull" in out["message"]


def test_missing_discount_rate_or_inputs_is_no_projection(tmp_path):
    assert run_montecarlo("ZZZ", _db(tmp_path, log={}))["error"] == "no_projection"


def test_missing_price_is_an_error(tmp_path):
    assert run_montecarlo("ZZZ", _db(tmp_path, with_price=False))["error"] == "no_price"
