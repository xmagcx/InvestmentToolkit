"""Purpose: verify the thesis currency store and tool: stale detection, context for the writer, replace-not-append.

Layer: Plugins / Portfolio Advisor / Tests.
Key Functions: put/show replace semantics, validation, stale reasons, context contents.
Key Input Dependencies: thesis_currency.py, the thesis_document_member table, temporary domain and ledger databases.
"""
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

import pytest

ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
sys.path.insert(0, str(ROOT / "investment_screener/backend/py_services"))
sys.path.insert(0, str(ROOT / "plugins/portfolio-advisor/.apm/skills/running-portfolio-reviews/scripts"))
sys.path.insert(0, str(ROOT / "investment_screener/backend/py_services"))

from domain_model.db_client import initialize_db as init_domain  # noqa: E402
from domain_model.thesis_document_member_repository import replace_members  # noqa: E402
from record_news_sweep import record_findings  # noqa: E402
from thesis_currency import MAX_CHARS, build_context, put_note, set_members, show_note, stale_documents, touch_note  # noqa: E402

TODAY = date(2026, 10, 10)


@pytest.fixture()
def dbs(tmp_path):
    domain, ledger = tmp_path / "domain_model.sqlite", tmp_path / "intelligence.sqlite"
    conn = init_domain(str(domain))
    replace_members(conn, "ai", ["NVDA", "AMD"])
    replace_members(conn, "power", ["VST"])
    conn.close()
    record_findings("## NVDA\n- buyback raised\n", ledger, as_of="2026-10-09", source="grok")
    record_findings("## VST\n- new PPA signed\n", ledger, as_of="2026-10-01", source="grok")
    record_findings("## TSLA\n- unrelated\n", ledger, as_of="2026-10-09", source="grok")
    return domain, ledger


def test_put_replaces_the_note_and_keeps_no_history(dbs):
    domain, _ = dbs
    put_note(domain, "ai", "2026-10-09", "- first", updated_by="daily-loop")
    put_note(domain, "ai", "2026-10-10", "- second", updated_by="weekly-review")
    note = show_note(domain, "ai", today=TODAY)
    assert note["markdown"] == "- second" and note["as_of"] == "2026-10-10" and note["age_days"] == 0
    assert note["updated_by"] == "weekly-review"
    conn = sqlite3.connect(domain)
    assert conn.execute("SELECT COUNT(*) FROM thesis_document_currency").fetchone()[0] == 1


def test_show_is_none_when_never_refreshed(dbs):
    assert show_note(dbs[0], "ai", today=TODAY) is None


@pytest.mark.parametrize("markdown,as_of", [("", "2026-10-10"), ("   ", "2026-10-10"), ("- ok", "2026-13-01"), ("x" * (MAX_CHARS + 1), "2026-10-10")])
def test_put_rejects_empty_oversize_and_bad_dates(dbs, markdown, as_of):
    with pytest.raises(ValueError):
        put_note(dbs[0], "ai", as_of, markdown)
    assert show_note(dbs[0], "ai", today=TODAY) is None


def test_stale_reports_documents_never_refreshed_with_their_new_event_counts(dbs):
    domain, ledger = dbs
    stale = {s["document_id"]: s for s in stale_documents(domain, ledger, today=TODAY, max_age_days=7)}
    assert set(stale) == {"ai", "power"}
    assert stale["ai"]["reason"] == "never refreshed" and stale["ai"]["new_events"] == 1
    assert stale["power"]["new_events"] == 1


def test_a_fresh_note_with_no_newer_events_is_not_stale(dbs):
    domain, ledger = dbs
    put_note(domain, "ai", "2026-10-10", "- current")
    put_note(domain, "power", "2026-10-10", "- current")
    assert stale_documents(domain, ledger, today=TODAY, max_age_days=7) == []


def test_a_newer_event_for_a_member_makes_the_note_stale(dbs):
    domain, ledger = dbs
    put_note(domain, "ai", "2026-10-08", "- older")
    stale = {s["document_id"]: s for s in stale_documents(domain, ledger, today=TODAY, max_age_days=30)}
    assert stale["ai"]["new_events"] == 1 and "new events" in stale["ai"]["reason"]


def test_an_old_note_is_stale_by_age_even_without_new_events(dbs):
    domain, ledger = dbs
    put_note(domain, "power", (TODAY - timedelta(days=9)).isoformat(), "- old")
    put_note(domain, "ai", "2026-10-10", "- current")
    stale = {s["document_id"]: s for s in stale_documents(domain, ledger, today=TODAY, max_age_days=7)}
    assert set(stale) == {"power"} and stale["power"]["reason"].startswith("9 days old")


def test_context_holds_members_recent_events_of_members_only_and_the_current_note(dbs):
    domain, ledger = dbs
    put_note(domain, "ai", "2026-10-05", "- the old note")
    text = build_context(domain, ledger, "ai", today=TODAY, days=14)
    assert "NVDA" in text and "AMD" in text
    assert "buyback raised" in text
    assert "new PPA signed" not in text and "unrelated" not in text
    assert "the old note" in text
    assert "as of 2026-10-05" in text


def test_context_for_a_document_without_members_says_so(dbs):
    assert "no stocks are linked" in build_context(dbs[0], dbs[1], "applied_ai", today=TODAY, days=14).lower()


def test_touch_redates_a_note_without_changing_its_text_and_fails_without_one(dbs):
    domain, _ = dbs
    assert touch_note(domain, "ai", "2026-10-10") is False
    put_note(domain, "ai", "2026-10-01", "- same text")
    assert touch_note(domain, "ai", "2026-10-10", updated_by="weekly-review") is True
    note = show_note(domain, "ai", today=TODAY)
    assert note["markdown"] == "- same text" and note["as_of"] == "2026-10-10" and note["updated_by"] == "weekly-review"


def test_set_members_links_stocks_to_a_new_thesis_document(dbs):
    domain, ledger = dbs
    assert set_members(domain, "robotics", ["tsla", " HUMN ", "TSLA"]) == ["HUMN", "TSLA"]
    text = build_context(domain, ledger, "robotics", today=TODAY, days=14)
    assert "HUMN, TSLA" in text and "unrelated" in text  # TSLA's sweep event now belongs to this document
    assert {s["document_id"] for s in stale_documents(domain, ledger, today=TODAY, max_age_days=7)} == {"ai", "power", "robotics"}


def test_set_members_replaces_the_previous_list(dbs):
    domain, ledger = dbs
    set_members(domain, "ai", ["NVDA"])
    assert "AMD" not in build_context(domain, ledger, "ai", today=TODAY, days=14).split("## Events")[0]


class _NeutralAnalyzer:
    def polarity_scores(self, _title):
        return {"compound": 0.0}


def test_finviz_headlines_are_not_thesis_events(dbs):
    from news_sentiment import build_news_sentiment
    domain, ledger = dbs
    rows = [("2026-10-09 10:00:00", "Nvidia ships new chips", "https://example.test/nvda-1", "Reuters")]
    build_news_sentiment("NVDA", str(ledger), fetcher=lambda _s: rows, analyzer=_NeutralAnalyzer(), today=TODAY)
    stale = {s["document_id"]: s for s in stale_documents(domain, ledger, today=TODAY, max_age_days=7)}
    assert stale["ai"]["new_events"] == 1
