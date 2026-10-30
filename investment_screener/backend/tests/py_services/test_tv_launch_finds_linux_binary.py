#!/usr/bin/env python3
"""
test_tv_launch_finds_linux_binary.py - Tests for Linux binary discovery in tv_launch.

Purpose:
    The launcher skipped TradingView on Linux because find_binary() only knew
    macOS bundle paths, so a snap/flatpak install was never detected and the
    toolkit fell back to yfinance even when TradingView Desktop was running.
    Verifies Linux discovery covers PATH, snap and flatpak exports, returns the
    first candidate that exists, and never reaches for macOS Spotlight.

Layer:
    Testing / Backend / Python Services
"""

import sys
from pathlib import Path
from unittest.mock import patch

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

import tv_launch  # noqa: E402


def _fake_binary(tmp_path: Path, name: str = "tradingview") -> Path:
    """Create an executable-looking file standing in for the TradingView binary."""
    binary = tmp_path / name
    binary.write_text("#!/bin/sh\n", encoding="utf-8")
    binary.chmod(0o755)
    return binary


def test_linux_candidates_include_path_lookup():
    """A tradingview binary on PATH must be the first Linux candidate."""
    found = _fake_binary(Path("/tmp") / "tv-launch-test")
    with patch.object(tv_launch.shutil, "which", return_value=str(found)):
        candidates = tv_launch.linux_candidates()
    assert candidates[0] == found


def test_linux_candidates_cover_snap_and_flatpak():
    """Snap and flatpak exports are searched even when nothing is on PATH."""
    with patch.object(tv_launch.shutil, "which", return_value=None):
        candidates = [str(p) for p in tv_launch.linux_candidates()]
    assert "/snap/bin/tradingview" in candidates
    assert any("flatpak" in c and "com.tradingview" in c for c in candidates)


def test_find_binary_returns_existing_linux_candidate(tmp_path):
    """On Linux the first existing candidate wins."""
    binary = _fake_binary(tmp_path)
    with patch.object(tv_launch.platform, "system", return_value="Linux"), \
            patch.object(tv_launch, "linux_candidates", return_value=[tmp_path / "missing", binary]):
        assert tv_launch.find_binary() == binary


def test_find_binary_does_not_use_spotlight_on_linux(tmp_path):
    """mdfind is macOS-only; Linux discovery must not shell out to it."""
    calls = []

    def _record(args, **kwargs):
        calls.append(args)
        raise AssertionError(f"unexpected subprocess call on Linux: {args}")

    with patch.object(tv_launch.platform, "system", return_value="Linux"), \
            patch.object(tv_launch, "linux_candidates", return_value=[tmp_path / "missing"]), \
            patch.object(tv_launch.subprocess, "run", side_effect=_record):
        assert tv_launch.find_binary() is None
    assert calls == []
