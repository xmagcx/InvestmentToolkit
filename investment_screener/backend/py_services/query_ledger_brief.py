#!/usr/bin/env python3
"""Query daily brief data from the SQLite Intelligence Ledger.

Usage:
    python3 query_ledger_brief.py --latest [--db-path PATH]
    python3 query_ledger_brief.py --history [--db-path PATH]
    python3 query_ledger_brief.py --conviction TICKER [--db-path PATH]
"""
import sys
from pathlib import Path
import json
import sqlite3
import argparse

REPO_ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

from intelligence.event_repository import get_latest_event_by_type


def main():
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--latest", action="store_true")
    group.add_argument("--history", action="store_true")
    group.add_argument("--conviction", type=str)
    parser.add_argument("--db-path", type=str)
    parser.add_argument("--current-recommendations", action="store_true")
    parser.add_argument("--domain-db", type=str)
    args = parser.parse_args()

    db_path = args.db_path or str(REPO_ROOT / "investment_screener/backend/data/intelligence.sqlite")

    if not Path(db_path).exists():
        # No ledger yet (fresh install) means no briefs: the same empty answer as an empty ledger.
        print(json.dumps(None if args.latest else []))
        return

    try:
        conn = sqlite3.connect(db_path)
    except Exception as exc:
        print(json.dumps({"error": f"Failed to connect to database: {exc}"}))
        sys.exit(1)

    try:
        if args.latest:
            event = get_latest_event_by_type(conn, "REVIEW_DAILY")
            if not event or not event.get("payload_json"):
                print(json.dumps(None))
            else:
                # Output the exact payload JSON
                payload = json.loads(event["payload_json"])
                if args.current_recommendations:
                    from brief_recommendations import align_current_brief
                    payload = align_current_brief(payload, args.domain_db)
                print(json.dumps(payload))

        elif args.history:
            from intelligence.event_repository import list_active_events_by_type
            events = list_active_events_by_type(conn, "REVIEW_DAILY")
            history = []
            for event in events:
                payload_json = event.get("payload_json")
                if not payload_json:
                    continue
                try:
                    d = json.loads(payload_json)
                    history.append({
                        "date": d.get("date"),
                        "regime": d.get("macro_regime", {}).get("regime"),
                        "reduce_count": len([s for s in d.get("conviction_scores", []) if s.get("band") in ("REDUCE", "EXIT")]),
                        "accum_count": len([s for s in d.get("conviction_scores", []) if s.get("band") == "ACCUMULATE"]),
                        "ta_refreshed": d.get("ta_refreshed"),
                    })
                except Exception:
                    pass
            print(json.dumps(history))

        elif args.conviction:
            from intelligence.event_repository import list_active_events_by_type
            ticker = args.conviction.upper()
            events = list_active_events_by_type(conn, "REVIEW_DAILY")
            conviction_history = []
            for event in reversed(events):  # ascending by date for this endpoint
                payload_json = event.get("payload_json")
                if not payload_json:
                    continue
                try:
                    d = json.loads(payload_json)
                except Exception:
                    continue
                score = next((s for s in d.get("conviction_scores", []) if s.get("ticker") == ticker), None)
                if score:
                    conviction_history.append({"date": d.get("date"), **score})
            print(json.dumps(conviction_history))

    finally:
        conn.close()


if __name__ == "__main__":
    main()
