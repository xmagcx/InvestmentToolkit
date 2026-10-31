#!/usr/bin/env python
"""
run_investment_toolkit.py (CLI)
=====================================

Purpose:
    Unified startup script for the Investment Toolkit suite.
    Handles virtual environment setup, dependency installation (Node & Python),
    backend building, concurrent service orchestration (Frontend & Backend),
    and TradingView Desktop launch with real-time price access.

Layer:
    Codify

Key Input Dependencies:
    - investment_screener/package.json (Vite/React workspace setup)
    - requirements.txt (Python packages pins)

Usage Examples:
    # Full standard launch:
    python3 run_investment_toolkit.py

    # Fast launch (skips dependency install and build if already updated):
    python3 run_investment_toolkit.py --skip-deps --skip-build

    # Launch servers without launching TradingView Desktop:
    python3 run_investment_toolkit.py --no-tv

    # Every launch also runs daily_brief.py in the background (log: .runtime/daily_brief.log);
    # skip it with:
    python3 run_investment_toolkit.py --no-daily-brief
"""

import os
import sys
import subprocess
import platform
import signal
import time
import shutil
from typing import List, Optional, Dict, Any

# --- Configuration & Setup ---
ROOT_DIR: str = os.path.dirname(os.path.abspath(__file__))
APP_DIR: str = os.path.join(ROOT_DIR, "investment_screener")

# Ensure we operate relative to the app directory for npm commands
os.chdir(APP_DIR)

IS_WINDOWS: bool = platform.system() == "Windows"


class Colors:
    """ANSI color codes for terminal output."""
    GREEN: str = '\033[0;32m'
    YELLOW: str = '\033[1;33m'
    RED: str = '\033[0;31m'
    CYAN: str = '\033[0;36m'
    NC: str = '\033[0m' # No Color

    @staticmethod
    def print(msg: str, color: str = NC) -> None:
        """
        Prints a colored message to the terminal.
        """
        print(f"{color}{msg}{Colors.NC}")


# External comment: Run a shell command synchronously
def run_command(
    command: List[str], 
    shell: bool = False, 
    env: Optional[Dict[str, str]] = None, 
    check: bool = True
) -> None:
    """
    Run a command synchronously.
    """
    try:
        subprocess.run(command, shell=shell, env=env, check=check)
    except subprocess.CalledProcessError as e:
        Colors.print(f"Error running command: {' '.join(command)}", Colors.RED)
        sys.exit(e.returncode)


# External comment: Checks if command is in system PATH
def check_command(cmd: str) -> bool:
    """
    Check if a command exists in the system PATH.
    """
    return shutil.which(cmd) is not None


# External comment: Kill stale processes on ports
def clear_ports(ports: List[int]) -> None:
    """
    Attempt to kill processes listening on the specified ports.
    """
    for port in ports:
        if not IS_WINDOWS:
            try:
                result = subprocess.run(
                    ["lsof", "-ti", f":{port}"],
                    capture_output=True, text=True
                )
                pids = result.stdout.strip().split()
                for pid in pids:
                    if pid:
                        try:
                            # Graceful shutdown first
                            os.kill(int(pid), signal.SIGTERM)
                            time.sleep(1.0)
                            # Only escalate to SIGKILL if the process is still alive
                            os.kill(int(pid), 0)
                            os.kill(int(pid), signal.SIGKILL)
                            Colors.print(f"  Force-killed stale process on :{port} (PID {pid})", Colors.YELLOW)
                        except ProcessLookupError:
                            Colors.print(f"  Cleared stale process on :{port} (PID {pid})", Colors.YELLOW)
                        except Exception:
                            pass
            except Exception:
                pass
        else:
            try:
                result = subprocess.run(
                    ["netstat", "-ano"],
                    capture_output=True, text=True
                )
                for line in result.stdout.splitlines():
                    if f":{port}" in line and "LISTENING" in line:
                        parts = line.split()
                        pid = parts[-1]
                        subprocess.run(["taskkill", "/F", "/PID", pid], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                        Colors.print(f"  Cleared stale process on :{port} (PID {pid})", Colors.YELLOW)
            except Exception:
                pass
        try:
            time.sleep(0.5)
        except Exception:
            pass


# External comment: Prepare Python virtual environment
def setup_virtual_env(venv_dir: str, env: Dict[str, str]) -> None:
    """
    Creates and populates the Python virtual environment.
    """
    if not os.path.exists(venv_dir):
        Colors.print("Creating Python virtual environment...", Colors.GREEN)
        run_command([sys.executable, "-m", "venv", venv_dir])

    Colors.print("Activating virtual environment context...", Colors.GREEN)
    
    if IS_WINDOWS:
        venv_bin = os.path.join(ROOT_DIR, venv_dir, "Scripts")
    else:
        venv_bin = os.path.join(ROOT_DIR, venv_dir, "bin")
    
    env["PATH"] = venv_bin + os.pathsep + env.get("PATH", "")
    env["VIRTUAL_ENV"] = os.path.join(ROOT_DIR, venv_dir)
    
    Colors.print("Installing Python dependencies...", Colors.GREEN)
    python_exec = "python" if IS_WINDOWS else "python3"

    run_command([python_exec, "-m", "pip", "install", "--upgrade", "pip"], env=env)

    req_txt = os.path.join(ROOT_DIR, "requirements.txt")
    req_in  = os.path.join(ROOT_DIR, "requirements.in")
    if os.path.exists(req_txt):
        run_command([python_exec, "-m", "pip", "install", "-r", req_txt], env=env)
    elif os.path.exists(req_in):
        Colors.print("Warning: requirements.txt not found — installing from requirements.in.", Colors.YELLOW)
        run_command([python_exec, "-m", "pip", "install", "-r", req_in], env=env)
    else:
        Colors.print("Warning: No requirements file found — installing fallback deps.", Colors.YELLOW)
        run_command([python_exec, "-m", "pip", "install", "yfinance", "pandas", "uvicorn", "fastapi",
                     "cryptography", "keyring"], env=env)


# External comment: Run best-effort TradingView launcher script
def _launch_tradingview() -> None:
    """Delegate to tv_launch.py — single source of truth for TradingView CDP launch."""
    tv_launcher = os.path.join(ROOT_DIR, "investment_screener", "backend", "py_services", "tv_launch.py")
    if not os.path.exists(tv_launcher):
        Colors.print("  TradingView: launcher not found — skipping.", Colors.YELLOW)
        return
    try:
        subprocess.run([sys.executable, tv_launcher], check=False)
    except Exception as e:
        Colors.print(f"  TradingView: launch failed ({e}) — yfinance fallback active.", Colors.YELLOW)


# External comment: Pre-flight checks for tools and permissions
def preflight_checks(process_env: Dict[str, str]) -> None:
    """
    Verifies node environment, config files, and directory permission locks.
    """
    if not check_command("node"):
        Colors.print("Error: Node.js is not installed.", Colors.RED)
        sys.exit(1)
    
    env_file = os.path.join(ROOT_DIR, ".env")
    if not os.path.exists(env_file):
        Colors.print("Note: No .env file found — copy .env.example to configure optional services.", Colors.YELLOW)
    
    # Pre-flight: fix root-owned node_modules (caused by accidental sudo npm/rm)
    node_modules_dir = os.path.join(ROOT_DIR, "investment_screener", "node_modules")
    if os.path.exists(node_modules_dir) and not IS_WINDOWS:
        import pwd
        current_user = pwd.getpwuid(os.getuid()).pw_name
        result = subprocess.run(
            ["find", node_modules_dir, "-maxdepth", "1", "-user", "root"],
            capture_output=True, text=True
        )
        root_owned = [l for l in result.stdout.strip().splitlines() if l]
        if root_owned:
            Colors.print(f"⚠️  {len(root_owned)} node_modules packages owned by root — restoring permissions...", Colors.YELLOW)
            fix_result = subprocess.run(["sudo", "chown", "-R", f"{current_user}", node_modules_dir], check=False)
            if fix_result.returncode != 0:
                Colors.print(f"❌ Permission fix failed. Please run manually: sudo chown -R {current_user} {node_modules_dir}", Colors.RED)
                sys.exit(1)


# External comment: Dependency installation and validation
def install_and_verify_dependencies(process_env: Dict[str, str]) -> None:
    """
    Installs packages and checks Python dependency requirements.
    """
    Colors.print("Installing Node dependencies...", Colors.GREEN)
    run_command(["npm", "install"], env=process_env)

    Colors.print("Verifying Python dependencies...", Colors.GREEN)
    required_modules = ["keyring", "cryptography", "yfinance", "pandas"]
    python_exec = "python" if IS_WINDOWS else "python3"
    missing = []
    for mod in required_modules:
        result = subprocess.run([python_exec, "-c", f"import {mod}"], env=process_env, capture_output=True)
        if result.returncode != 0:
            missing.append(mod)
    if missing:
        Colors.print(f"❌ Missing Python modules: {', '.join(missing)}", Colors.RED)
        Colors.print("Run: pip install " + " ".join(missing), Colors.YELLOW)
        sys.exit(1)
    Colors.print("✅ Python dependencies OK.", Colors.GREEN)


DAILY_BRIEF_SCRIPT: str = os.path.join(APP_DIR, "backend", "py_services", "daily_brief.py")
DAILY_BRIEF_LOG: str = os.path.join(ROOT_DIR, ".runtime", "daily_brief.log")


# External comment: Runs the daily brief in the background on every start
def start_daily_brief(process_env: Dict[str, str], log_path: str = DAILY_BRIEF_LOG,
                      popen: Any = subprocess.Popen) -> Optional[Any]:
    """
    Starts daily_brief.py detached from the service loop: it neither blocks the launch nor is
    supervised (its exit never stops the servers). Output goes to log_path. A spawn failure
    only warns: the app must start even when the brief cannot.
    """
    venv_python = os.path.join(ROOT_DIR, "venv", "Scripts" if IS_WINDOWS else "bin",
                               "python.exe" if IS_WINDOWS else "python")
    python = venv_python if os.path.exists(venv_python) else "python3"
    try:
        os.makedirs(os.path.dirname(log_path), exist_ok=True)
        log = open(log_path, "w", encoding="utf-8")
        proc = popen([python, DAILY_BRIEF_SCRIPT], env=process_env, stdout=log,
                     stderr=subprocess.STDOUT, cwd=ROOT_DIR)
    except OSError as exc:
        Colors.print(f"⚠️  Daily brief not started: {exc}", Colors.YELLOW)
        return None
    Colors.print(f"📰 Daily brief running in background (log: {log_path})", Colors.CYAN)
    return proc


# External comment: Concurrently starts backend and frontend servers
def start_services_loop(process_env: Dict[str, str], run_daily_brief: bool = True) -> None:
    """
    Spawns Node backend and Vite frontend services and monitors their lifecycles.
    """
    Colors.print("Starting Services...", Colors.GREEN)
    clear_ports([3001, 5173])

    processes: List[subprocess.Popen] = []
    brief_proc = None
    try:
        backend_proc = subprocess.Popen(["npm", "run", "start", "-w", "backend"], env=process_env, shell=False, cwd=APP_DIR)
        processes.append(backend_proc)

        frontend_proc = subprocess.Popen(["npm", "run", "dev", "-w", "frontend"], env=process_env, shell=False, cwd=APP_DIR)
        processes.append(frontend_proc)

        # Not appended to `processes`: the brief finishing (or failing) must not stop the servers.
        brief_proc = start_daily_brief(process_env) if run_daily_brief else None

        Colors.print("✅ Services Running!", Colors.GREEN)
        Colors.print("Backend:  http://localhost:3001")
        Colors.print("Frontend: http://localhost:5173")
        Colors.print("\nPress Ctrl+C to stop all services.", Colors.CYAN)

        while all(p.poll() is None for p in processes):
            time.sleep(0.5)

    except KeyboardInterrupt:
        Colors.print("\nShutting down services...", Colors.YELLOW)
    finally:
        for p in processes:
            if p.poll() is None:
                if IS_WINDOWS:
                    subprocess.run(["taskkill", "/F", "/T", "/PID", str(p.pid)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                else:
                    p.terminate()
        if brief_proc is not None and brief_proc.poll() is None:
            brief_proc.terminate()
        Colors.print("All services stopped.", Colors.GREEN)


# External comment: Back up the SQLite databases, then bring the schema up to date
def prepare_databases(process_env: Dict[str, str]) -> None:
    """
    The gitignored databases hold data git cannot restore, so every launch first takes a
    verified, WAL-safe backup of each existing one (a failure here warns and continues),
    then applies pending schema migrations. The migrator takes its own pre-migration
    backup of a populated file and aborts startup on any problem, so the Node backend
    never opens a database whose schema it does not understand.
    """
    py_services = os.path.join(APP_DIR, "backend", "py_services", "domain_model")
    data_dir = os.path.join(APP_DIR, "backend", "data")

    for name in ("domain_model", "intelligence"):
        if not os.path.exists(os.path.join(data_dir, f"{name}.sqlite")):
            continue
        result = subprocess.run(
            [sys.executable, os.path.join(py_services, "db_backup.py"), "backup", "--db", name],
            env=process_env, capture_output=True, text=True,
        )
        if result.returncode == 0:
            Colors.print(f"💾 {result.stdout.strip()}", Colors.CYAN)
        else:
            Colors.print(f"⚠️  Backup of {name}.sqlite FAILED (continuing): {result.stderr.strip()}", Colors.YELLOW)

    Colors.print("Checking database schema...", Colors.GREEN)
    run_command([sys.executable, os.path.join(py_services, "schema_migrator.py")], env=process_env)


# External comment: Command-line options of the launcher
def build_arg_parser() -> "argparse.ArgumentParser":
    """Return the launcher's argument parser."""
    import argparse
    parser = argparse.ArgumentParser(description="Unified startup launcher for Investment Toolkit suite.")
    parser.add_argument("--skip-deps", action="store_true", help="Skip npm install and python module re-verification")
    parser.add_argument("--no-tv", action="store_true", help="Skip launching TradingView Desktop")
    parser.add_argument("--skip-build", action="store_true", help="Skip building backend (if already built)")
    parser.add_argument("--no-daily-brief", action="store_true",
                        help="Do not run daily_brief.py in the background at startup")
    return parser


# External comment: CLI execution coordinator
def main() -> None:
    """
    Main execution loop for launching the toolkit.
    """
    args = build_arg_parser().parse_args()

    Colors.print("🚀 Launching Investment Screener...", Colors.GREEN)

    process_env = os.environ.copy()
    process_env["NODE_OPTIONS"] = (process_env.get("NODE_OPTIONS", "") + " --no-deprecation").strip()
    process_env["NODE_NO_WARNINGS"] = "1"
    
    # 1. Preflight permission and environment check
    preflight_checks(process_env)

    # 2. Virtual Env setup
    setup_virtual_env(os.path.join(ROOT_DIR, "venv"), process_env)

    # 3. Dependencies check
    if not args.skip_deps:
        install_and_verify_dependencies(process_env)
    else:
        Colors.print("⚡ Skipping dependency check (--skip-deps active)", Colors.CYAN)

    # 4. Launch TradingView Desktop
    if not args.no_tv:
        Colors.print("Launching TradingView Desktop...", Colors.GREEN)
        _launch_tradingview()
    else:
        Colors.print("⚡ Skipping TradingView launch (--no-tv active)", Colors.CYAN)

    # 5. Build Backend
    if not args.skip_build:
        Colors.print("Building Backend...", Colors.GREEN)
        run_command(["npm", "run", "build", "-w", "backend"], env=process_env)
    else:
        Colors.print("⚡ Skipping Backend build (--skip-build active)", Colors.CYAN)

    # 6. Back up databases and apply pending schema migrations (before Node opens them)
    prepare_databases(process_env)

    # 7. Start active servers
    start_services_loop(process_env, run_daily_brief=not args.no_daily_brief)


if __name__ == "__main__":
    main()
