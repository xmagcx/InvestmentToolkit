#!/usr/bin/env python3
"""
ingest_local_portfolio.py - Local portfolio data ingestion into domain_model.sqlite.

Purpose:
    Records the user's holdings (account + per-account investments) into the local
    domain database WITHOUT any broker feed (no TradingView CDP, no Questrade MCP).
    Reads a hand-maintained JSON payload and writes through the canonical domain
    repositories, so the dashboard, heatmap, and thesis services consume exactly
    the same rows a broker sync would produce.

    Market-wide data (prices, fundamentals, heatmap prices) continues to come from
    yfinance at read time; this script only records WHAT you hold and at what cost.

Layer:
    Backend / Python Services

Usage Examples:
    python3 investment_screener/backend/py_services/ingest_local_portfolio.py \\
        --payload data/portfolio_holdings.json

    # Validate without writing:
    python3 investment_screener/backend/py_services/ingest_local_portfolio.py \\
        --payload data/portfolio_holdings.json --dry-run

Payload Schema (see docs/architecture/local-portfolio-ingest-adr.md):

    {
      "accounts": [
        {"id": "TFSA", "name": "TFSA - 53408189", "type": "TFSA",
         "base_currency": "CAD"}
      ],
      "cash": [
        {"account_id": "TFSA", "currency": "USD", "amount": 1320.50}
      ],
      "holdings": [
        {"account_id": "TFSA", "symbol": "NVDA", "quantity": 10,
         "average_cost": 120.50, "currency": "USD"}
      ]
    }

    - account.id becomes the canonical account_id (system keys holdings by
      plain account-type strings: "TFSA"/"RRSP"/"CASH").
    - cash entries are recorded as synthetic CASH_<CURRENCY> investments so the
      Mandatory Cash Invariant (Rule #18) holds: portfolio total always includes
      uninvested cash.
    - holdings.symbol is normalized through ticker_aliases.normalize_ticker.
    - average_cost and book_value are optional; book_value defaults to
      quantity * average_cost when both present.

Key Functions (Index):
    - load_payload()            : Read and basic-validate the JSON payload.
    - ingest()                  : Apply accounts, cash, and holdings to the DB.
    - main()                    : CLI entrypoint.

Key Input Dependencies:
    - JSON payload file (hand-maintained holdings).
Key Output Dependencies:
    - investment_screener/backend/data/domain_model.sqlite (Domain Database)
"""

import sys
import json
import sqlite3
import argparse
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

_REPO_ROOT = Path(__file__).resolve().parents[2]
_PY_SERVICES = _REPO_ROOT / "investment_screener/backend/py_services"
sys.path.insert(0, str(_PY_SERVICES))

from ticker_aliases import normalize_ticker  # noqa: E402
from domain_model.account_repository import upsert_account  # noqa: E402
from domain_model.account_investment_repository import (  # noqa: E402
    upsert_account_investment,
)
from domain_model.investment_repository import resolve_investment  # noqa: E402

_DEFAULT_DB_PATH = str(_REPO_ROOT / "investment_screener/backend/data/domain_model.sqlite")


def _as_float(value: Any) -> Optional[float]:
    """Coerce a number-or-string amount to float, or None if unparseable."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    cleaned = str(value).replace("$", "").replace(",", "").strip()
    if not cleaned or cleaned in {"-", "N/A"}:
        return None
    try:
        return float(cleaned)
    except ValueError:
        return None


def load_payload(path: str) -> dict:
    """Read and validate the JSON payload.

    Raises ValueError on a structurally invalid payload so the caller fails
    loud instead of writing partial state.
    """
    p = Path(path)
    if not p.exists():
        raise ValueError(f"Payload file not found: {path}")
    with open(p) as f:
        payload = json.load(f)

    if "accounts" not in payload:
        raise ValueError("Payload must contain an 'accounts' list.")
    if not isinstance(payload.get("accounts"), list) or not payload["accounts"]:
        raise ValueError("Payload 'accounts' must be a non-empty list.")
    if "holdings" not in payload and "cash" not in payload:
        raise ValueError("Payload must contain 'holdings' and/or 'cash'.")
    return payload


def ingest(conn: sqlite3.Connection, payload: dict) -> int:
    """Apply accounts, cash, and holdings to the DB. Returns rows written."""
    now = datetime.now(timezone.utc).isoformat()
    written = 0

    # 1. Upsert accounts, keyed by their canonical id ("TFSA"/"RRSP"/...)
    for acc in payload.get("accounts", []):
        acc_id = str(acc.get("id") or "").strip().upper()
        if not acc_id:
            raise ValueError("Each account requires a non-empty 'id'.")
        upsert_account(
            conn=conn,
            account_id=acc_id,
            account_name=acc.get("name") or acc_id,
            account_type=acc.get("type") or acc_id,
            base_currency=acc.get("base_currency") or "CAD",
        )
        written += 1

    # 2. Uninvested cash — recorded as synthetic CASH_<CURRENCY> investments so
    #    portfolio totals always include cash (Mandatory Cash Invariant, Rule #18).
    for cash in payload.get("cash", []):
        acc_id = str(cash.get("account_id") or "").strip().upper()
        currency = str(cash.get("currency") or "USD").strip().upper()
        amount = _as_float(cash.get("amount"))
        if not acc_id or not currency:
            raise ValueError("Each cash entry requires 'account_id' and 'currency'.")
        if amount is None or amount == 0.0:
            continue
        cash_sym = f"CASH_{currency}"
        resolve_investment(conn, cash_sym, asset_class="CASH", currency=currency, name=f"{currency} Cash")
        upsert_account_investment(
            conn=conn,
            account_id=acc_id,
            investment_id=cash_sym,
            quantity=amount,
            average_cost=1.0,
            book_value=amount,
            currency=currency,
            last_synced_at=now,
        )
        written += 1

    # 3. Security holdings
    for h in payload.get("holdings", []):
        acc_id = str(h.get("account_id") or "").strip().upper()
        raw_sym = str(h.get("symbol") or "").strip()
        if not acc_id or not raw_sym:
            raise ValueError("Each holding requires 'account_id' and 'symbol'.")
        symbol = normalize_ticker(raw_sym)
        qty = _as_float(h.get("quantity"))
        avg_cost = _as_float(h.get("average_cost"))
        book_value = _as_float(h.get("book_value"))
        if book_value is None and qty is not None and avg_cost is not None:
            book_value = qty * avg_cost
        currency = str(h.get("currency") or "USD").strip().upper()

        resolve_investment(conn, symbol, asset_class="EQUITY", currency=currency)
        upsert_account_investment(
            conn=conn,
            account_id=acc_id,
            investment_id=symbol,
            quantity=qty if qty is not None else 0.0,
            average_cost=avg_cost,
            book_value=book_value,
            currency=currency,
            last_synced_at=now,
        )
        written += 1

    return written


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Ingest local portfolio holdings into domain_model.sqlite."
    )
    parser.add_argument("--payload", type=str, required=True, help="Path to JSON payload file.")
    parser.add_argument("--db-path", type=str, default=_DEFAULT_DB_PATH, help="Path to domain_model.sqlite.")
    parser.add_argument("--dry-run", action="store_true", help="Validate without writing.")
    args = parser.parse_args()

    try:
        payload = load_payload(args.payload)
    except ValueError as e:
        print(f"Error: {e}", file=sys.stderr)
        sys.exit(1)

    if args.dry_run:
        print("Dry-run: payload valid, no rows written.")
        print(f"  accounts: {len(payload.get('accounts', []))}")
        print(f"  cash:     {len(payload.get('cash', []))}")
        print(f"  holdings: {len(payload.get('holdings', []))}")
        sys.exit(0)

    conn = sqlite3.connect(args.db_path)
    try:
        written = ingest(conn, payload)
        print(f"✅ Ingested {written} rows into {args.db_path}.")
    finally:
        conn.close()


if __name__ == "__main__":
    main()
