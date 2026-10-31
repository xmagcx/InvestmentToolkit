"""
test_empty_state_reports.py — a fresh install (no cash flows, no intelligence ledger yet) is an
empty state, not a failure: the scripts the Express backend polls must exit 0 with an explicit
empty payload instead of exiting 1 and flooding the backend log with stack traces.
"""
import json
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
PY_SERVICES = REPO_ROOT / "investment_screener/backend/py_services"
sys.path.insert(0, str(PY_SERVICES))

import ytd_return  # noqa: E402


def test_ytd_json_without_cash_flows_reports_unavailable_and_exits_zero(monkeypatch, capsys):
    monkeypatch.setattr(ytd_return, "load_cash_flows", lambda *a, **k: {})
    monkeypatch.setattr(sys, "argv", ["ytd_return.py", "--json"])
    ytd_return.calculate_twr()  # must not raise SystemExit
    payload = json.loads(capsys.readouterr().out)
    assert payload == {
        "available": False,
        "reason": "cash_flow data is required (none found in domain_model.sqlite).",
    }


def test_ytd_json_with_non_positive_baseline_is_still_an_error(monkeypatch, capsys):
    """Bad data (a baseline <= 0) stays a failure; only 'no data yet' is an empty state."""
    monkeypatch.setattr(ytd_return, "load_cash_flows", lambda *a, **k: {"starting_balance_cad": 0})
    monkeypatch.setattr(ytd_return, "load_current_balance_cad", lambda *a, **k: 0.0)
    monkeypatch.setattr(sys, "argv", ["ytd_return.py", "--json"])
    with pytest.raises(SystemExit) as exc:
        ytd_return.calculate_twr()
    assert exc.value.code == 1
    assert "error" in json.loads(capsys.readouterr().out)


@pytest.mark.parametrize(
    "args, expected",
    [(["--latest"], None), (["--history"], []), (["--conviction", "AAPL"], [])],
)
def test_ledger_brief_without_intelligence_db_returns_empty_and_exits_zero(tmp_path, args, expected):
    missing = tmp_path / "intelligence.sqlite"
    proc = subprocess.run(
        [sys.executable, str(PY_SERVICES / "query_ledger_brief.py"), *args, "--db-path", str(missing)],
        capture_output=True, text=True, timeout=60,
    )
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert json.loads(proc.stdout) == expected
    assert not missing.exists()  # a read never creates the ledger file
