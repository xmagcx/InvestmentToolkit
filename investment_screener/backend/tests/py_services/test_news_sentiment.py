"""
test_news_sentiment.py - finviz headlines + VADER sentiment for the Noticias tab (S14).
No network: the finviz fetcher and the analyzer are injected; the ledger is a temp
intelligence.sqlite. One test uses the real VADER lexicon when it is present offline.
"""
import json
import sqlite3
import sys
from datetime import date
from pathlib import Path

import pytest

REPO_ROOT = next(p for p in Path(__file__).resolve().parents if (p / "investment_screener").is_dir())
PY = REPO_ROOT / "investment_screener/backend/py_services"
sys.path.insert(0, str(PY))

from intelligence.db_client import initialize_db  # noqa: E402
from news_sentiment import (  # noqa: E402
    EVENT_TYPE, build_news_sentiment, classify, finviz_symbol, load_stored, period_counts,
)

TODAY = date(2025, 6, 30)


class Stub:
    """Analyzer stub: the compound score is looked up by title."""
    def __init__(self, scores):
        self.scores = scores

    def polarity_scores(self, title):
        return {"compound": self.scores.get(title, 0.0)}


def fetcher(rows):
    return lambda symbol: rows


def boom(symbol):
    raise RuntimeError("finviz down")


def make_db(tmp_path):
    path = tmp_path / "intelligence.sqlite"
    initialize_db(str(path)).close()
    return str(path)


ROWS = [
    ("2025-06-28 09:30", "Up big", "https://x/1", "Reuters"),
    ("2025-05-15 10:00", "Meh", "https://x/2", "CNBC"),
    ("2025-03-01 10:00", "Down hard", "https://x/3", "WSJ"),
    ("2025-01-10 10:00", "Up again", "https://x/4", "Reuters"),
    ("2024-08-01 10:00", "Old down", "https://x/5", "Reuters"),
    ("2023-01-01 10:00", "Ancient", "https://x/6", "Reuters"),
]
SCORES = {"Up big": 0.8, "Meh": 0.0, "Down hard": -0.6, "Up again": 0.3, "Old down": -0.2, "Ancient": 0.9}


def test_classify_thresholds_are_inclusive_at_005():
    a = Stub({"p": 0.05, "n": -0.05, "just_under": 0.0499, "just_over_neg": -0.0499, "z": 0.0})
    assert classify("p", a) == ("positive", 0.05)
    assert classify("n", a) == ("negative", -0.05)
    assert classify("just_under", a)[0] == "neutral"
    assert classify("just_over_neg", a)[0] == "neutral"
    assert classify("z", a) == ("neutral", 0.0)


def test_real_vader_lexicon_classifies_clear_headlines():
    pytest.importorskip("nltk")
    import news_sentiment
    try:
        analyzer = news_sentiment.get_analyzer(download=False)
    except LookupError:
        pytest.skip("vader_lexicon not downloaded")
    assert classify("Company posts record profit and great growth", analyzer)[0] == "positive"
    assert classify("Company crashes amid terrible fraud scandal", analyzer)[0] == "negative"
    assert classify("Company holds annual meeting on Tuesday", analyzer)[0] == "neutral"


def test_finviz_symbol_maps_canonical_tickers():
    assert finviz_symbol("msft") == "MSFT"
    assert finviz_symbol("BRK.B") == "BRK-B"
    assert finviz_symbol("BRK-B") == "BRK-B"
    assert finviz_symbol("PSU.U") is None      # alias of PSU-U.TO, a Canadian fund
    assert finviz_symbol("SHOP.TO") is None
    assert finviz_symbol("") is None


def test_period_counts_are_trailing_windows_by_date():
    arts = [{"date": r[0].replace(" ", "T"), "sentiment": s} for r, s in
            zip(ROWS, ["positive", "neutral", "negative", "positive", "negative", "positive"])]
    counts = period_counts(arts, TODAY)
    assert counts["1M"] == {"positive": 1, "neutral": 0, "negative": 0}
    assert counts["3M"] == {"positive": 1, "neutral": 1, "negative": 0}
    assert counts["6M"] == {"positive": 2, "neutral": 1, "negative": 1}
    assert counts["1Y"] == {"positive": 2, "neutral": 1, "negative": 2}


def test_build_stores_headlines_and_reports_periods_from_storage(tmp_path):
    db = make_db(tmp_path)
    out = build_news_sentiment("MSFT", db, fetcher(ROWS), Stub(SCORES), TODAY)
    assert out["ticker"] == "MSFT" and out["stale"] is False
    assert list(out["periods"]) == ["1M", "3M", "6M", "1Y"]
    assert out["periods"]["1Y"] == {"positive": 2, "neutral": 1, "negative": 2}
    assert out["total"] == 5                       # the 2023 headline is outside 1Y
    assert out["coverage_since"] == "2023-01-01"   # earliest stored, even outside 1Y
    first = out["articles"][0]
    assert first == {"title": "Up big", "date": "2025-06-28T09:30", "source": "Reuters",
                     "url": "https://x/1", "sentiment": "positive", "score": 0.8}
    assert [a["date"] for a in out["articles"]] == sorted((a["date"] for a in out["articles"]), reverse=True)
    assert out["fetched_at"]
    conn = sqlite3.connect(db)
    n, types = conn.execute("SELECT COUNT(*), GROUP_CONCAT(DISTINCT event_type) FROM intelligence_event").fetchone()
    assert (n, types) == (6, EVENT_TYPE)


def test_second_run_dedupes_by_url_and_title_date(tmp_path):
    db = make_db(tmp_path)
    build_news_sentiment("MSFT", db, fetcher(ROWS), Stub(SCORES), TODAY)
    no_url = [("2025-06-01 08:00", "No link", "", "AP")]
    build_news_sentiment("MSFT", db, fetcher(ROWS + no_url), Stub(SCORES), TODAY)
    out = build_news_sentiment("MSFT", db, fetcher(ROWS + no_url), Stub(SCORES), TODAY)
    conn = sqlite3.connect(db)
    assert conn.execute("SELECT COUNT(*) FROM intelligence_event").fetchone()[0] == 7
    assert out["total"] == 6


def test_stored_events_resolve_to_the_canonical_instrument(tmp_path):
    db = make_db(tmp_path)
    build_news_sentiment("MSFT", db, fetcher(ROWS), Stub(SCORES), TODAY)
    build_news_sentiment("NVDA", db, fetcher([("2025-06-20 10:00", "Nv", "https://n/1", "AP")]), Stub({}), TODAY)
    conn = sqlite3.connect(db)
    rows = conn.execute(
        "SELECT i.ticker, e.source_id, e.status, e.payload_json FROM intelligence_event e "
        "JOIN instrument i ON i.instrument_id = e.instrument_id WHERE i.ticker = 'NVDA'").fetchall()
    assert len(rows) == 1 and rows[0][1] == "finviz" and rows[0][2] == "ACTIVE"
    assert json.loads(rows[0][3])["title"] == "Nv"
    assert len(load_stored(conn, "MSFT")) == 6


def test_fetch_failure_returns_stored_data_flagged_stale(tmp_path):
    db = make_db(tmp_path)
    build_news_sentiment("MSFT", db, fetcher(ROWS), Stub(SCORES), TODAY)
    out = build_news_sentiment("MSFT", db, boom, Stub(SCORES), TODAY)
    assert out["stale"] is True
    assert out["total"] == 5 and out["periods"]["1Y"]["positive"] == 2


def test_fetch_failure_with_nothing_stored_is_empty_and_stale_not_an_error(tmp_path):
    out = build_news_sentiment("MSFT", make_db(tmp_path), boom, Stub({}), TODAY)
    assert "error" not in out
    assert out["stale"] is True and out["articles"] == [] and out["total"] == 0
    assert out["coverage_since"] is None
    assert out["periods"]["1M"] == {"positive": 0, "neutral": 0, "negative": 0}


def test_unserved_ticker_is_empty_without_calling_finviz(tmp_path):
    out = build_news_sentiment("SHOP.TO", make_db(tmp_path), boom, Stub({}), TODAY)
    assert out["stale"] is False and out["articles"] == [] and out["total"] == 0


def test_finviz_empty_result_for_unknown_ticker_is_empty(tmp_path):
    out = build_news_sentiment("ZZZZ", make_db(tmp_path), fetcher([]), Stub({}), TODAY)
    assert out["stale"] is False and out["articles"] == [] and out["total"] == 0
