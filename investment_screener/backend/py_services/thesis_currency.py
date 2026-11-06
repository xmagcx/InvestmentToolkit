#!/usr/bin/env python3
"""
thesis_currency.py - Keep the thesis pages current with the latest relevant news and analysis.

Purpose:
    Each thesis document has one "current developments" note in domain_model.sqlite that the
    web app shows at the top of the page. The daily, weekly and review skills refresh it:
    `stale` lists the documents that need it (never refreshed, old, or new ledger events for the
    stocks the thesis covers), `context` prints what happened to those stocks (news sweeps,
    research, thesis updates from intelligence.sqlite) next to the current note, the agent
    writes the new note, and `put` replaces it. There is no history: the note is right today,
    and the events behind it stay in the ledger. `touch` re-dates a note when nothing changed.

Layer:
    Plugins / Portfolio Advisor / Scripts (writes domain_model.sqlite)

Usage Examples:
    python3 investment_screener/backend/py_services/thesis_currency.py stale --max-age-days 7
    python3 investment_screener/backend/py_services/thesis_currency.py context --document asi_race
    python3 investment_screener/backend/py_services/thesis_currency.py put --document asi_race --by daily-loop < note.md
    python3 investment_screener/backend/py_services/thesis_currency.py touch --document asi_race --by weekly-review
    python3 investment_screener/backend/py_services/thesis_currency.py show --document asi_race
    python3 investment_screener/backend/py_services/thesis_currency.py set-members --document robotics_automation --tickers HUMN,KOID

Key Functions (Index):
    - put_note(), touch_note(), show_note(): write, re-date and read one document's note
    - set_members(): set which stocks a thesis document covers
    - stale_documents(): documents that need a refresh, with the reason and new-event count
    - build_context(): markdown for the writer: members, recent events, current note
    - main(): CLI

Key Input Dependencies:
    - thesis_document_member (which stocks each document covers), thesis_document_currency
    - NEWS_SWEEP, RESEARCH_IMPORT and THESIS_UPDATE events in intelligence.sqlite

Key Output Dependencies:
    - thesis_document_currency rows (read by GET /api/theses/sub-strategies/:id)
"""
import argparse
import json
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "investment_screener/backend/py_services"))

from domain_model.db_client import initialize_db  # noqa: E402
from domain_model.thesis_document_currency_repository import (  # noqa: E402
    get_currency, list_currency, put_currency, touch_currency,
)
from domain_model.thesis_document_member_repository import list_members, replace_members  # noqa: E402

DEFAULT_DOMAIN_DB = ROOT / "investment_screener/backend/data/domain_model.sqlite"
DEFAULT_LEDGER_DB = ROOT / "investment_screener/backend/data/intelligence.sqlite"
EVENT_TYPES = ("NEWS_SWEEP", "RESEARCH_IMPORT", "THESIS_UPDATE")
MAX_CHARS = 2400
NEVER_REFRESHED_WINDOW_DAYS = 14
MAX_CONTEXT_EVENTS = 40


def _members_by_document(conn: sqlite3.Connection) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    for symbol, documents in list_members(conn).items():
        for document_id in documents:
            out.setdefault(document_id, []).append(symbol)
    return {d: sorted(s) for d, s in out.items()}


# Raw finviz headlines (news_sentiment.SOURCE_ID) share NEWS_SWEEP but are not thesis findings.
HEADLINE_SOURCE = "finviz"


def _events(ledger_db: Path, tickers: list[str], since: str, after_ingested: str | None = None, same_day: str | None = None) -> list[dict]:
    """ACTIVE events for ``tickers`` dated after ``since`` (and same-day ones ingested after ``after_ingested``)."""
    if not tickers or not Path(ledger_db).exists():
        return []
    conn = sqlite3.connect(f"file:{ledger_db}?mode=ro", uri=True)
    try:
        marks = ",".join("?" * len(tickers))
        types = ",".join("?" * len(EVENT_TYPES))
        sql = (
            "SELECT i.ticker, e.event_type, substr(e.effective_at, 1, 10), e.title, e.body_markdown "
            "FROM intelligence_event e JOIN instrument i ON i.instrument_id = e.instrument_id "
            f"WHERE e.status = 'ACTIVE' AND e.event_type IN ({types}) AND i.ticker IN ({marks}) "
            "AND COALESCE(e.source_id, '') != ? AND ("
            "substr(e.effective_at, 1, 10) > ?"
        )
        params: list = [*EVENT_TYPES, *tickers, HEADLINE_SOURCE, since]
        if same_day is not None and after_ingested is not None:
            sql += " OR (substr(e.effective_at, 1, 10) = ? AND e.ingested_at > ?)"
            params += [same_day, after_ingested]
        sql += ") ORDER BY e.effective_at DESC, e.event_sequence DESC;"
        return [dict(zip(("ticker", "event_type", "date", "title", "body"), r)) for r in conn.execute(sql, params)]
    finally:
        conn.close()


def put_note(domain_db: Path, document_id: str, as_of: str, markdown: str, updated_by: str | None = None) -> None:
    """Replace the current note of ``document_id``; rejects empty text, text over MAX_CHARS and bad dates."""
    date.fromisoformat(as_of)
    if not markdown.strip():
        raise ValueError("note must not be empty")
    if len(markdown) > MAX_CHARS:
        raise ValueError(f"note is {len(markdown)} characters; keep it under {MAX_CHARS} (only the most relevant, current items)")
    conn = initialize_db(str(domain_db))
    try:
        put_currency(conn, document_id, as_of, markdown.strip(), updated_by)
    finally:
        conn.close()


def touch_note(domain_db: Path, document_id: str, as_of: str, updated_by: str | None = None) -> bool:
    """Re-date an existing note when nothing material changed; False if there is no note yet."""
    date.fromisoformat(as_of)
    conn = initialize_db(str(domain_db))
    try:
        return touch_currency(conn, document_id, as_of, updated_by)
    finally:
        conn.close()


def show_note(domain_db: Path, document_id: str, today: date | None = None) -> dict | None:
    """The note with its age in days, or None when the document was never refreshed."""
    conn = initialize_db(str(domain_db))
    try:
        note = get_currency(conn, document_id)
    finally:
        conn.close()
    if note is None:
        return None
    note["age_days"] = ((today or date.today()) - date.fromisoformat(note["as_of"])).days
    return note


def set_members(domain_db: Path, document_id: str, tickers: list[str]) -> list[str]:
    """Make ``tickers`` the stocks a thesis document covers (replaces the previous list); returns the stored list."""
    conn = initialize_db(str(domain_db))
    try:
        replace_members(conn, document_id, tickers)
        return sorted({t.strip().upper() for t in tickers if t and t.strip()})
    finally:
        conn.close()


def stale_documents(domain_db: Path, ledger_db: Path, today: date | None = None, max_age_days: int = 7) -> list[dict]:
    """Documents to refresh: never refreshed, older than ``max_age_days``, or with newer events for their stocks."""
    today = today or date.today()
    conn = initialize_db(str(domain_db))
    try:
        members = _members_by_document(conn)
        notes = list_currency(conn)
    finally:
        conn.close()
    out = []
    for document_id in sorted(set(members) | set(notes)):
        tickers = members.get(document_id, [])
        note = notes.get(document_id)
        if note is None:
            since = (today - timedelta(days=NEVER_REFRESHED_WINDOW_DAYS)).isoformat()
            new = len(_events(ledger_db, tickers, since))
            out.append({"document_id": document_id, "reason": "never refreshed", "new_events": new, "members": len(tickers)})
            continue
        new = len(_events(ledger_db, tickers, note["as_of"], note["updated_at"], note["as_of"]))
        age = (today - date.fromisoformat(note["as_of"])).days
        if new > 0:
            out.append({"document_id": document_id, "reason": f"{new} new events since {note['as_of']}", "new_events": new, "members": len(tickers)})
        elif age > max_age_days:
            out.append({"document_id": document_id, "reason": f"{age} days old, no new events", "new_events": 0, "members": len(tickers)})
    return out


def build_context(domain_db: Path, ledger_db: Path, document_id: str, today: date | None = None, days: int = 14) -> str:
    """Markdown for the writer: the stocks, the current note, and recent events for those stocks."""
    today = today or date.today()
    conn = initialize_db(str(domain_db))
    try:
        tickers = _members_by_document(conn).get(document_id, [])
        note = get_currency(conn, document_id)
    finally:
        conn.close()
    lines = [f"# Thesis page: {document_id}"]
    if not tickers:
        return "\n".join(lines + ["", "No stocks are linked to this thesis document yet, so there is nothing to refresh it from."])
    lines += ["", f"Stocks it covers: {', '.join(tickers)}", ""]
    if note:
        lines += [f"## Current note (as of {note['as_of']})", note["markdown"], ""]
    else:
        lines += ["## Current note", "(none yet)", ""]
    events = _events(ledger_db, tickers, (today - timedelta(days=days)).isoformat())[:MAX_CONTEXT_EVENTS]
    lines.append(f"## Events in the last {days} days ({len(events)})")
    for e in events:
        body = " ".join(e["body"].split())[:400]
        lines.append(f"- [{e['date']}] {e['ticker']} ({e['event_type']}): {e['title']} :: {body}")
    if not events:
        lines.append("(none recorded: nothing new to add; use `touch` to re-date the note)")
    return "\n".join(lines)


def main() -> int:
    """CLI entry point."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--domain-db", type=Path, default=DEFAULT_DOMAIN_DB)
    parser.add_argument("--ledger-db", type=Path, default=DEFAULT_LEDGER_DB)
    sub = parser.add_subparsers(dest="command", required=True)
    s = sub.add_parser("stale", help="list documents that need a refresh")
    s.add_argument("--max-age-days", type=int, default=7)
    m = sub.add_parser("set-members", help="set which stocks a thesis document covers")
    m.add_argument("--document", required=True)
    m.add_argument("--tickers", required=True, help="comma-separated, e.g. HUMN,KOID")
    for name in ("context", "show", "put", "touch"):
        p = sub.add_parser(name)
        p.add_argument("--document", required=True)
        if name == "context":
            p.add_argument("--days", type=int, default=14)
        if name in ("put", "touch"):
            p.add_argument("--as-of", default=date.today().isoformat())
            p.add_argument("--by", default=None, help="skill or person writing the note")
    args = parser.parse_args()
    try:
        if args.command == "stale":
            print(json.dumps(stale_documents(args.domain_db, args.ledger_db, max_age_days=args.max_age_days), indent=2))
        elif args.command == "set-members":
            stored = set_members(args.domain_db, args.document, args.tickers.split(","))
            print(json.dumps({"document": args.document, "members": stored}))
        elif args.command == "context":
            print(build_context(args.domain_db, args.ledger_db, args.document, days=args.days))
        elif args.command == "show":
            print(json.dumps(show_note(args.domain_db, args.document), indent=2))
        elif args.command == "put":
            put_note(args.domain_db, args.document, args.as_of, sys.stdin.read(), args.by)
            print(json.dumps({"document": args.document, "as_of": args.as_of, "stored": True}))
        elif args.command == "touch":
            ok = touch_note(args.domain_db, args.document, args.as_of, args.by)
            print(json.dumps({"document": args.document, "as_of": args.as_of, "touched": ok}))
            return 0 if ok else 1
    except ValueError as exc:
        print(json.dumps({"error": str(exc)}), file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
