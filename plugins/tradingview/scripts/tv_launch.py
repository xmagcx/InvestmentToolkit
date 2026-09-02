#!/usr/bin/env python3
"""
tv_launch.py — Launch TradingView Desktop with CDP remote debugging enabled.

Purpose:
    Ensures TradingView Desktop is running with --remote-debugging-port=9222
    so the Investment Toolkit can connect to it for real-time price quotes.
    Called automatically by run_investment_toolkit.py at suite startup, and
    Available standalone via: python3 plugins/tradingview/scripts/tv_launch.py

What it does (in order):
    1. Checks if CDP port 9222 is already reachable.
       → If yes: exits immediately — no restart needed.
    2. Locates the TradingView Desktop binary
       (checks /Applications, ~/Applications, then Spotlight).
       → If not found: prints install instructions and exits.
    3. Kills any existing TradingView process.
       A running instance without the debug port ignores the flag on reopen;
       it must be stopped and relaunched.
    4. Launches the binary directly with --remote-debugging-port=9222.
       (Direct binary launch is more reliable than `open --args` on macOS.)
    5. Waits up to 20 s for port 9222 to become reachable, then reports
       ready or timeout — either way, yfinance fallback remains active.

Usage:
    python3 plugins/tradingview/scripts/tv_launch.py
    python3 plugins/tradingview/scripts/tv_launch.py --port 9222
    python3 plugins/tradingview/scripts/tv_launch.py
"""

import sys
import socket
import subprocess
import time
import platform
import argparse
from pathlib import Path

def _find_scripts_dir() -> Path:
    here = Path(__file__).resolve().parent
    for candidate in [here, *here.parents]:
        if (candidate / "tv_client.py").exists():
            return candidate
        if (candidate / "scripts" / "tv_client.py").exists():
            return candidate / "scripts"
    raise ImportError("tv_client.py not found — check plugin installation or set TV_CDP_DIR.")

sys.path.insert(0, str(_find_scripts_dir()))
from tv_client import TV_PORT, is_tv_running

IS_WINDOWS = platform.system() == "Windows"

# Candidate binary locations — checked in order
MAC_CANDIDATES = [
    Path("/Applications/TradingView.app/Contents/MacOS/TradingView"),
    Path.home() / "Applications/TradingView.app/Contents/MacOS/TradingView",
]
WIN_CANDIDATES = [
    Path(sys.platform) / "TradingView" / "TradingView.exe",  # placeholder
]
# Linux candidates (snap, official .deb, Flatpak) — checked in order
LINUX_CANDIDATES = [
    Path("/snap/bin/tradingview"),
    Path("/var/lib/snapd/snap/bin/tradingview"),
    Path("/opt/TradingView/tradingview"),
    Path("/opt/TradingView/TradingView"),
]


def find_binary() -> Path | None:
    """Return the TradingView binary path, or None if not found."""
    if IS_WINDOWS:
        candidates = WIN_CANDIDATES
    elif platform.system() == "Linux":
        candidates = LINUX_CANDIDATES
    else:
        candidates = MAC_CANDIDATES
    for p in candidates:
        if p.exists():
            return p
    # Spotlight fallback (macOS only)
    if platform.system() == "Darwin":
        try:
            result = subprocess.run(
                ["mdfind", "kMDItemCFBundleIdentifier == 'com.tradingview.tradingviewapp'"],
                capture_output=True, text=True, timeout=5,
            )
            hits = [l.strip() for l in result.stdout.splitlines() if l.strip()]
            if not hits:
                # Try alternate bundle IDs used by some TV versions
                result2 = subprocess.run(
                    ["mdfind", "kMDItemFSName == 'TradingView.app'"],
                    capture_output=True, text=True, timeout=5,
                )
                hits = [l.strip() for l in result2.stdout.splitlines() if l.strip()]
            for app_path in hits:
                binary = Path(app_path) / "Contents/MacOS/TradingView"
                if binary.exists():
                    return binary
        except Exception:
            pass
    return None


def kill_existing() -> bool:
    """Kill any running TradingView process. Returns True if something was killed."""
    try:
        if IS_WINDOWS:
            result = subprocess.run(
                ["taskkill", "/F", "/IM", "TradingView.exe"],
                capture_output=True,
            )
            return result.returncode == 0
        else:
            result = subprocess.run(
                ["pkill", "-f", "TradingView"],
                capture_output=True,
            )
            return result.returncode == 0
    except Exception:
        return False


def wait_for_port(port: int, timeout: int = 20) -> bool:
    """Poll until the given TCP port is reachable or timeout expires."""
    for _ in range(timeout):
        time.sleep(1)
        try:
            with socket.create_connection(("localhost", port), timeout=1):
                return True
        except OSError:
            pass
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Launch TradingView Desktop with CDP debug port")
    parser.add_argument("--port", type=int, default=TV_PORT, help=f"CDP port (default: {TV_PORT})")
    args = parser.parse_args()
    port = args.port

    # 1. Already running with CDP port?
    if is_tv_running():
        print(f"✅ TradingView already running with CDP on port {port}.")
        sys.exit(0)

    # 2. Find binary
    binary = find_binary()
    if not binary:
        if platform.system() == "Linux":
            hint = (
                "   Install via snap:  sudo snap install tradingview\n"
                "   Or .deb: https://www.tradingview.com/desktop/ (Download For Linux)\n"
                f"   Launch manually: /snap/bin/tradingview --remote-debugging-port={port}"
            )
        elif platform.system() == "Darwin":
            hint = (
                "   Install from: https://www.tradingview.com/desktop/\n"
                f"   Or launch manually: /Applications/TradingView.app/Contents/MacOS/TradingView "
                f"--remote-debugging-port={port}"
            )
        else:
            hint = f"   Install from: https://www.tradingview.com/desktop/"
        print(
            "❌ TradingView Desktop binary not found.\n"
            + hint
        )
        sys.exit(1)

    print(f"Found: {binary}")

    # 3. Kill existing instance so we can relaunch with the debug flag
    killed = kill_existing()
    if killed:
        print("Stopped existing TradingView instance.")
        time.sleep(2)

    # 4. Launch with CDP flag
    print(f"Launching with --remote-debugging-port={port} ...")
    try:
        subprocess.Popen(
            [str(binary), f"--remote-debugging-port={port}"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
    except Exception as e:
        print(f"❌ Launch failed: {e}")
        sys.exit(1)

    # 5. Wait for port
    print("Waiting for CDP port", end="", flush=True)
    for _ in range(20):
        time.sleep(1)
        print(".", end="", flush=True)
        try:
            with socket.create_connection(("localhost", port), timeout=1):
                print(f"\n✅ TradingView ready on port {port} — real-time prices enabled.")
                sys.exit(0)
        except OSError:
            pass

    print(
        f"\n⚠️  TradingView launched but port {port} not reachable after 20 s.\n"
        "   The app may still be loading. Try:\n"
        "   python3 plugins/tradingview/scripts/tv_health_check.py"
    )
    sys.exit(1)


if __name__ == "__main__":
    main()
