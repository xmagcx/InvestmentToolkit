#!/usr/bin/env python3
"""
news_sentiment.py - finviz headlines + VADER sentiment for one ticker (Noticias tab, S14).

Purpose:
    Fetches the ticker's recent headlines from finviz (the `finviz` package, MIT), scores
    each title with NLTK VADER, stores every new headline in intelligence.sqlite (rule 21)
    and reports 1M/3M/6M/1Y sentiment counts computed from the STORED headlines, because
    finviz only serves recent news: history grows with every call. `coverage_since` is the
    earliest stored date so the UI can say how far back the counts go.

    Sentiment thresholds (VADER compound score of the title):
        compound >=  0.05  -> positive
        compound <= -0.05  -> negative
        otherwise          -> neutral
    Periods are trailing windows counted by headline date: 1M=30, 3M=91, 6M=182, 1Y=365
    days back from today (cumulative: a 1M headline also counts in 3M, 6M, 1Y).

    A finviz/network/lexicon failure never raises: stored data is returned with
    "stale": true. Tickers finviz cannot serve (exchange-suffixed like SHOP.TO) return
    empty data, not an error.

Layer:
    Backend / Python Services / News & Sentiment

Usage Examples:
    python3 news_sentiment.py MSFT
    python3 news_sentiment.py MSFT --db /path/to/intelligence.sqlite

Persistence:
    Each headline is one `intelligence_event` written through intelligence.event_store.
    append_event (no new DDL): event_type NEWS_SWEEP (the ledger's CHECK constraint admits
    no dedicated headline type), source_id "finviz", payload {"kind": "news_headline",
    title, url, source, sentiment, score}. Dedupe: idempotency_key = sha1 of the url, or of
    title+date when there is none. The instrument is the canonical ticker (symbol), never
    the finviz symbol.

Offline lexicon:
    vader_lexicon downloads once into backend/data/nltk_data (gitignored) and is read from
    there afterwards.

Key Functions (Index):
    - finviz_symbol(ticker) - canonical ticker -> finviz symbol, None when finviz cannot serve it
    - get_analyzer(download) - VADER SentimentIntensityAnalyzer from the project nltk_data dir
    - classify(title, analyzer) - (label, compound)
    - period_counts(articles, today) - {"1M".."1Y": {positive, neutral, negative}}
    - load_stored(conn, symbol) - stored headlines, newest first
    - build_news_sentiment(ticker, db_path, fetcher, analyzer, today) - the endpoint payload

Key Input Dependencies:
    - finviz.get_news, nltk (requirements.in), intelligence.sqlite

Key Output Dependencies:
    - routes/stock.ts (GET /api/stock/:ticker/news-sentiment)
"""

import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from intelligence.db_client import initialize_db  # noqa: E402
from intelligence.event_store import append_event, default_db_path  # noqa: E402
from ticker_aliases import normalize_ticker  # noqa: E402

EVENT_TYPE = "NEWS_SWEEP"
SOURCE_ID = "finviz"
POSITIVE_AT = 0.05
NEGATIVE_AT = -0.05
PERIOD_DAYS = {"1M": 30, "3M": 91, "6M": 182, "1Y": 365}
NLTK_DIR = Path(__file__).resolve().parent.parent / "data" / "nltk_data"
# finviz covers US listings only: a trailing exchange suffix means it cannot serve the ticker.
_EXCHANGE_SUFFIX = re.compile(r"\.(TO|V|CN|NE|L|PA|DE|AX|HK|T|SW|MI|MC|SA|MX|NS|BO)$")


def finviz_symbol(ticker: str) -> str | None:
    symbol = normalize_ticker((ticker or "").strip().upper())
    if not symbol or _EXCHANGE_SUFFIX.search(symbol):
        return None
    return symbol.replace(".", "-")


def get_analyzer(download: bool = True):
    import nltk
    from nltk.sentiment.vader import SentimentIntensityAnalyzer

    if str(NLTK_DIR) not in nltk.data.path:
        nltk.data.path.insert(0, str(NLTK_DIR))
    try:
        nltk.data.find("sentiment/vader_lexicon.zip")
    except LookupError:
        if not download:
            raise
        NLTK_DIR.mkdir(parents=True, exist_ok=True)
        nltk.download("vader_lexicon", download_dir=str(NLTK_DIR), quiet=True)
        nltk.data.find("sentiment/vader_lexicon.zip")
    return SentimentIntensityAnalyzer()


def classify(title: str, analyzer) -> tuple[str, float]:
    score = analyzer.polarity_scores(title)["compound"]
    if score >= POSITIVE_AT:
        return "positive", score
    if score <= NEGATIVE_AT:
        return "negative", score
    return "neutral", score


def period_counts(articles: list[dict], today: date) -> dict:
    counts = {p: {"positive": 0, "neutral": 0, "negative": 0} for p in PERIOD_DAYS}
    for a in articles:
        age = (today - date.fromisoformat(a["date"][:10])).days
        for period, days in PERIOD_DAYS.items():
            if 0 <= age <= days:
                counts[period][a["sentiment"]] += 1
    return counts


def _fetch_finviz(symbol: str):
    from finviz import get_news
    return get_news(symbol)


def _iso(stamp: str) -> str:
    return stamp.strip().replace(" ", "T")


def _key(symbol: str, title: str, url: str, day: str) -> str:
    raw = url or f"{title}|{day}"
    return f"news_headline:{symbol}:{hashlib.sha1(raw.encode('utf-8')).hexdigest()[:16]}"


def _store(conn, symbol: str, rows: list, analyzer) -> None:
    for stamp, title, url, source in rows:
        when = _iso(stamp)
        label, score = classify(title, analyzer)
        append_event(
            conn, EVENT_TYPE, when, "ACTIVE", title, title, ticker=symbol, source_id=SOURCE_ID,
            payload={"kind": "news_headline", "title": title, "url": url, "source": source,
                     "sentiment": label, "score": score},
            idempotency_key=_key(symbol, title, url, when[:10]),
        )


def load_stored(conn, symbol: str) -> list[dict]:
    rows = conn.execute(
        "SELECT e.effective_at, e.payload_json FROM intelligence_event e "
        "JOIN instrument i ON i.instrument_id = e.instrument_id "
        "WHERE i.ticker = ? AND e.event_type = ? AND e.source_id = ? AND e.status = 'ACTIVE' "
        "ORDER BY e.effective_at DESC, e.event_sequence DESC;",
        (symbol, EVENT_TYPE, SOURCE_ID),
    ).fetchall()
    out = []
    for effective_at, payload_json in rows:
        p = json.loads(payload_json or "{}")
        if p.get("kind") != "news_headline":
            continue
        out.append({"title": p["title"], "date": effective_at, "source": p.get("source", ""),
                    "url": p.get("url", ""), "sentiment": p["sentiment"], "score": p["score"]})
    return out


def build_news_sentiment(ticker: str, db_path: str, fetcher=None, analyzer=None,
                         today: date | None = None) -> dict:
    today = today or date.today()
    symbol = normalize_ticker((ticker or "").strip().upper())
    fv = finviz_symbol(ticker)
    conn = initialize_db(db_path)
    stale = False
    try:
        if fv:
            try:
                rows = (fetcher or _fetch_finviz)(fv)
                if rows:
                    _store(conn, symbol, rows, analyzer or get_analyzer())
            except Exception as e:  # source failure: serve what is stored
                print(f"news_sentiment: fetch failed for {symbol}: {e}", file=sys.stderr)
                stale = True
        stored = load_stored(conn, symbol)
    finally:
        conn.close()

    start = today - timedelta(days=PERIOD_DAYS["1Y"])
    articles = [a for a in stored if date.fromisoformat(a["date"][:10]) >= start]
    return {
        "ticker": symbol,
        "periods": period_counts(stored, today),
        "articles": articles,
        "total": len(articles),
        "stale": stale,
        "fetched_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "coverage_since": min((a["date"][:10] for a in stored), default=None),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="News headlines + VADER sentiment for one ticker")
    parser.add_argument("ticker")
    parser.add_argument("--db", default=str(default_db_path()))
    args = parser.parse_args()
    try:
        print(json.dumps(build_news_sentiment(args.ticker, args.db)))
    except Exception as e:
        print(json.dumps({"error": "failed", "message": str(e)}))


if __name__ == "__main__":
    main()
