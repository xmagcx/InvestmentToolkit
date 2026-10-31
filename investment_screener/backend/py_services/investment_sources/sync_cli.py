#!/usr/bin/env python3
"""sync_cli.py — run one investment-source sync and print its result as JSON.

Purpose:
    The command behind the "Fuentes" Sync button and the scheduler: it opens the
    domain-model database through ``domain_model.db_client.initialize_db`` (the repo's
    only DB entry point, which also applies pending migrations), runs the requested
    source's ``sync()`` and prints exactly one JSON object on stdout. Logs are JSON
    lines on stderr so stdout stays machine-readable.

Layer:
    Backend / Python Services / Investment Sources

Usage Examples:
    python3 sync_cli.py --list
    python3 sync_cli.py --source racional_gsheet --trigger manual
    python3 sync_cli.py --source racional_gsheet --db /tmp/domain_model.sqlite

Exit codes:
    0 = sync succeeded, 1 = sync failed or the source is unknown (JSON printed either way)

Key Functions (Index):
    - build_parser(): the argparse CLI definition
    - main(argv): run the sync, print one JSON object, return the exit code

Key Input Dependencies:
    - investment_screener/backend/data/domain_model.sqlite (default --db)
    - investment_sources.registry (source codes)

Key Output Dependencies:
    - stdout: one JSON object (SyncResult.to_dict() or {"sources": [...]})
    - stocks_origin / source_sync_run rows
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
DEFAULT_DB_PATH = REPO_ROOT / "investment_screener/backend/data/domain_model.sqlite"

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from domain_model.db_client import initialize_db  # noqa: E402

# Absolute imports: the Node bridge runs this file as a script, not with `python -m`.
from investment_sources.base import SyncResult  # noqa: E402
from investment_sources.registry import get_source, list_sources  # noqa: E402


def build_parser() -> argparse.ArgumentParser:
    """Return the CLI parser (--list, or --source with optional --db/--trigger)."""
    parser = argparse.ArgumentParser(description="Sync one investment source into the domain model.")
    parser.add_argument("--source", help="source_code to sync, e.g. racional_gsheet")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="domain_model.sqlite path")
    parser.add_argument(
        "--trigger", default="cli", choices=["manual", "scheduled", "cli"],
        help="who started this run (recorded in source_sync_run)",
    )
    parser.add_argument("--list", action="store_true", help="list the registered sources and exit")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Run one sync (or list sources) and print a single JSON object; return the exit code."""
    args = build_parser().parse_args(argv)
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(message)s")

    if args.list:
        print(json.dumps({"sources": list_sources()}, ensure_ascii=False))
        return 0
    if not args.source:
        print(json.dumps({"status": "failed", "error": "--source or --list is required"}))
        return 1

    try:
        source_cls = get_source(args.source)
    except KeyError as exc:
        print(json.dumps(SyncResult(args.source, "failed", error=str(exc.args[0])).to_dict()))
        return 1

    conn = initialize_db(args.db)
    try:
        result = source_cls().sync(conn, trigger=args.trigger)
    finally:
        conn.close()
    print(json.dumps(result.to_dict(), ensure_ascii=False))
    return 0 if result.status == "success" else 1


if __name__ == "__main__":
    raise SystemExit(main())
