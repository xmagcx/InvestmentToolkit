#!/usr/bin/env python3
"""CLI and parsing logic for ingesting a ``ticker,name,source`` CSV into
the ``universe_candidate`` table in ``domain_model.sqlite``.

Layer: Backend / Python Services

CLI usage::

    python3 ingest_universe_csv.py --csv <path> | --payload <csv-text> \\
        --db-path <path> [--dry-run]

Exit code 0 on success. JSON output on stdout::

    {"inserted": N, "skipped": M, "errors": ["row N: ..."]}

Source field formats accepted:
  - ``"RACIONAL"``            -> source=RACIONAL, asset_class=NULL
  - ``"EQUITY,RACIONAL"``     -> source=RACIONAL, asset_class=EQUITY
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import os
import sys
from typing import Any

# Ensure py_services/ is on sys.path for local imports.
_PY_SERVICES_DIR = os.path.dirname(os.path.abspath(__file__))
if _PY_SERVICES_DIR not in sys.path:
    sys.path.insert(0, _PY_SERVICES_DIR)

from ticker_aliases import normalize_ticker  # noqa: E402

EXPECTED_HEADER = ["ticker", "name", "source"]


def _split_source(raw: str) -> tuple[str, str | None]:
    """Split the ``source`` CSV field into ``(source, asset_class)``.

    Formats:
      - ``"RACIONAL"``         -> ``("RACIONAL", None)``
      - ``"EQUITY,RACIONAL"``  -> ``("RACIONAL", "EQUITY")``
    """
    parts = [p.strip() for p in raw.split(",")]
    parts = [p for p in parts if p]  # drop empty segments from leading/trailing commas
    if len(parts) >= 2:
        return parts[1], parts[0]
    return parts[0] if parts else "", None


def parse_csv_text(csv_text: str, db_path: str, *, dry_run: bool = False) -> dict[str, Any]:
    """Parse CSV text, normalize tickers, upsert into universe_candidate.

    Returns ``{"inserted": N, "skipped": M, "errors": [...]}``.
    Raises ``ValueError`` on header mismatch.
    """
    reader = csv.reader(io.StringIO(csv_text))
    try:
        header = next(reader)
    except StopIteration:
        return {"inserted": 0, "skipped": 0, "errors": []}

    header = [h.strip().lower() for h in header]
    if header != EXPECTED_HEADER:
        raise ValueError(
            f"Header mismatch: expected {EXPECTED_HEADER}, got {header}"
        )

    # Import here to avoid circular imports at module level.
    from domain_model.db_client import initialize_db
    from domain_model.universe_repository import (
        list_universe_candidates,
        upsert_universe_candidate,
    )

    if dry_run:
        # Still parse to validate; just skip DB writes.
        inserted = skipped = 0
        errors: list[str] = []
        row_num = 1
        for row in reader:
            row_num += 1
            if len(row) < 3:
                errors.append(f"row {row_num}: expected 3 columns, got {len(row)}")
                continue
            ticker_raw, name_raw, source_raw = row[0].strip(), row[1].strip(), row[2].strip()
            if not ticker_raw:
                errors.append(f"row {row_num}: empty ticker")
                continue
            # Normalization check (validates format without writing).
            normalize_ticker(ticker_raw)
            inserted += 1  # dry-run: count as inserted
        return {"inserted": inserted, "skipped": skipped, "errors": errors}

    conn = initialize_db(db_path)
    existing = {r["ticker"] for r in list_universe_candidates(conn)}

    inserted = skipped = 0
    errors: list[str] = []
    row_num = 1

    for row in reader:
        row_num += 1
        if len(row) < 3:
            errors.append(f"row {row_num}: expected 3 columns, got {len(row)}")
            continue

        ticker_raw, name_raw, source_raw = row[0].strip(), row[1].strip(), row[2].strip()

        if not ticker_raw:
            errors.append(f"row {row_num}: empty ticker")
            continue

        normalized = normalize_ticker(ticker_raw)
        if normalized in existing:
            skipped += 1
            continue

        source, asset_class = _split_source(source_raw)
        upsert_universe_candidate(conn, ticker_raw, name_raw, source, asset_class)
        existing.add(normalized)
        inserted += 1

    conn.close()
    return {"inserted": inserted, "skipped": skipped, "errors": errors}


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest a ticker,name,source CSV into universe_candidate."
    )
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--csv", help="Path to CSV file to ingest.")
    group.add_argument("--payload", help="Raw CSV text passed directly as a string.")
    parser.add_argument("--db-path", required=True, help="Path to domain_model.sqlite.")
    parser.add_argument("--dry-run", action="store_true", help="Parse and validate without writing.")
    args = parser.parse_args()

    if args.csv:
        with open(args.csv, "r", encoding="utf-8") as f:
            csv_text = f.read()
    else:
        csv_text = args.payload

    result = parse_csv_text(csv_text, args.db_path, dry_run=args.dry_run)
    print(json.dumps(result))


if __name__ == "__main__":
    main()
