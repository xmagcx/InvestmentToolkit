"""
test_launcher_daily_brief.py — the launcher starts daily_brief.py in the background on every
start ("En cada inicio, en segundo plano"): it never blocks or supervises the services, it logs
to a file, and the owner can opt out with --no-daily-brief.
"""
import importlib
import os
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]


def _launcher():
    cwd = os.getcwd()
    sys.path.insert(0, str(REPO_ROOT))
    try:
        return importlib.import_module("run_investment_toolkit")
    finally:
        os.chdir(cwd)  # the launcher chdirs into investment_screener/ at import


class _FakePopen:
    calls: list = []

    def __init__(self, cmd, **kwargs):
        _FakePopen.calls.append((cmd, kwargs))
        self.pid = 4242

    def poll(self):
        return None


def test_daily_brief_is_spawned_in_background_with_a_log_file(tmp_path):
    launcher = _launcher()
    _FakePopen.calls = []
    log = tmp_path / "daily_brief.log"
    proc = launcher.start_daily_brief({"PATH": "/usr/bin"}, log_path=str(log), popen=_FakePopen)
    assert proc is not None and proc.pid == 4242
    (cmd, kwargs), = _FakePopen.calls
    assert cmd[-1].endswith("investment_screener/backend/py_services/daily_brief.py")
    assert kwargs["stdout"].name == str(log)
    assert kwargs["env"] == {"PATH": "/usr/bin"}
    assert log.exists()


def test_daily_brief_uses_the_project_venv_python_when_present(tmp_path):
    launcher = _launcher()
    _FakePopen.calls = []
    launcher.start_daily_brief({}, log_path=str(tmp_path / "b.log"), popen=_FakePopen)
    (cmd, _), = _FakePopen.calls
    venv_python = REPO_ROOT / "venv" / "bin" / "python"
    expected = str(venv_python) if venv_python.exists() else "python3"
    assert cmd[0] == expected


def test_a_spawn_failure_never_stops_the_launch(tmp_path):
    launcher = _launcher()

    def broken(*_a, **_k):
        raise OSError("no python")

    assert launcher.start_daily_brief({}, log_path=str(tmp_path / "c.log"), popen=broken) is None


def test_no_daily_brief_flag_is_accepted():
    launcher = _launcher()
    assert launcher.build_arg_parser().parse_args(["--no-daily-brief"]).no_daily_brief is True
    assert launcher.build_arg_parser().parse_args([]).no_daily_brief is False
