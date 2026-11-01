#!/usr/bin/env python3
"""sentiment.py — market mood and headline sentiment for the Oportunidades detail (S13/S15).

Purpose:
    The expanded row of the Oportunidades table shows two context readings, and nothing
    else uses them: how the whole market feels right now (CNN's Fear & Greed index, 0-100,
    with its rating translated into plain Spanish) and how this ticker's latest headlines
    read (Yahoo ``Ticker.news`` titles scored against the compact Loughran-McDonald subset
    embedded in ``data/financial_lexicon.json``).

    The two halves are independent on purpose: CNN being unreachable must not hide the
    headlines, and a ticker without news must not hide the market mood. A half that fails
    is ``null`` — never a neutral score invented to fill the gap. Neither half is ever a
    star or a filter (S13); this is context the reader interprets.

Layer:
    Backend / Python Services

Usage Examples:
    python3 sentiment.py --ticker TMO
    from sentiment import build_payload; build_payload("TMO")

Exit codes:
    0 = payload printed (even when one half is null), 1 = unusable arguments

Key Classes / Functions (Index):
    - FEAR_GREED_URL / RATINGS / LABELS: the CNN endpoint and its Spanish wording
    - load_lexicon(): the cached {positive, negative} word sets
    - score_title(title) / score_label(score): (pos - neg) / max(1, pos + neg) and its label
    - fetch_market(url) / fetch_news(symbol): the real fetchers (requests / yfinance)
    - market_sentiment(fetch) -> {score, rating, label, asOf} | None
    - ticker_sentiment(symbol, fetch) -> {score, label, headlines, asOf} | None
    - build_payload(ticker, market_fetch, news_fetch) -> {market, ticker}
    - main(argv): the CLI the Node bridge spawns

Key Input Dependencies:
    - https://production.dataviz.cnn.io/index/fearandgreed/graphdata/ (browser-like UA)
    - yfinance Ticker(symbol).news (both the old flat shape and the new `content` shape)
    - py_services/data/financial_lexicon.json

Key Output Dependencies:
    - stdout: one JSON object {market, ticker} consumed by src/routes/sentiment.ts
    - writes nothing: this module only reads
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Sequence

FEAR_GREED_URL = "https://production.dataviz.cnn.io/index/fearandgreed/graphdata/"
#: CNN refuses its own dataviz endpoint without a browser-like agent.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)
HTTP_TIMEOUT_SECONDS = 10.0
LEXICON_PATH = Path(__file__).resolve().parent / "data" / "financial_lexicon.json"
#: CNN's five ratings, in the words the page shows.
RATINGS = {
    "extreme fear": "Miedo extremo",
    "fear": "Miedo",
    "neutral": "Neutral",
    "greed": "Codicia",
    "extreme greed": "Codicia extrema",
}
#: One plain sentence per rating (no full stop: the page prints it inline).
LABELS = {
    "Miedo extremo": "Miedo extremo: históricamente un buen momento para comprar calidad con calma",
    "Miedo": "Miedo: el mercado está nervioso y suele dejar mejores precios",
    "Neutral": "Neutral: el mercado no muestra ni miedo ni euforia",
    "Codicia": "Codicia: el mercado está optimista, conviene ser más exigente con el precio",
    "Codicia extrema": "Codicia extrema: el mercado está eufórico, es momento de extremar la cautela",
}
#: How many headlines are scored, and how many of them the detail panel shows.
MAX_SCORED_HEADLINES = 10
MAX_SHOWN_HEADLINES = 5
POSITIVE_THRESHOLD = 0.15
NEGATIVE_THRESHOLD = -0.15
_WORD_RE = re.compile(r"[a-z']+")
_LEXICON: dict[str, frozenset] | None = None


# --- the lexicon --------------------------------------------------------------------------


def load_lexicon() -> dict[str, frozenset]:
    """Return the embedded Loughran-McDonald subset as {positive, negative} word sets (cached)."""
    global _LEXICON
    if _LEXICON is None:
        data = json.loads(LEXICON_PATH.read_text(encoding="utf-8"))
        _LEXICON = {
            "positive": frozenset(word.lower() for word in data["positive"]),
            "negative": frozenset(word.lower() for word in data["negative"]),
        }
    return _LEXICON


def score_title(title: str) -> float:
    """Score one headline: (positive - negative) / max(1, positive + negative), in [-1, 1]."""
    lexicon = load_lexicon()
    words = _WORD_RE.findall((title or "").lower())
    positive = sum(1 for word in words if word in lexicon["positive"])
    negative = sum(1 for word in words if word in lexicon["negative"])
    return (positive - negative) / max(1, positive + negative)


def score_label(score: float) -> str:
    """Translate a score into the label the panel prints."""
    if score >= POSITIVE_THRESHOLD:
        return "Positivo"
    if score <= NEGATIVE_THRESHOLD:
        return "Negativo"
    return "Neutral"


# --- the real fetchers --------------------------------------------------------------------


def fetch_market(url: str = FEAR_GREED_URL) -> dict:
    """GET CNN's Fear & Greed graph data (browser-like agent, 10 s timeout)."""
    import requests  # local import: tests inject a fetcher and never touch the network

    response = requests.get(
        url, timeout=HTTP_TIMEOUT_SECONDS, headers={"User-Agent": BROWSER_USER_AGENT}
    )
    response.raise_for_status()
    return response.json()


def fetch_news(symbol: str) -> list[dict]:
    """Return Yahoo's latest news items for one symbol (shape handled by ``_headline``)."""
    import yfinance  # local import: the tests inject a fetcher, yfinance is not needed there

    return list(yfinance.Ticker(symbol).news or [])


# --- the market half ------------------------------------------------------------------------


def market_sentiment(fetch: Callable[[str], dict] = fetch_market) -> dict | None:
    """Return {score, rating, label, asOf} for the whole market, or None when unreadable."""
    try:
        payload = fetch(FEAR_GREED_URL) or {}
        index = payload.get("fear_and_greed") or {}
        rating = RATINGS.get(str(index.get("rating", "")).strip().lower())
        score = index.get("score")
        if rating is None or score is None:
            return None
        return {
            "score": round(float(score), 1),
            "rating": rating,
            "label": LABELS[rating],
            "asOf": _as_iso(index.get("timestamp")),
        }
    except Exception as exc:  # noqa: BLE001 — a failing half is null, never a fake score
        _warn(f"market sentiment unavailable: {exc}")
        return None


def _as_iso(value: Any) -> str | None:
    """Turn CNN's timestamp (ms since epoch, or an ISO string) into an ISO-8601 string."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value) / 1000, tz=timezone.utc).isoformat()
    text = str(value)
    if text.isdigit():
        return datetime.fromtimestamp(float(text) / 1000, tz=timezone.utc).isoformat()
    return text


# --- the ticker half --------------------------------------------------------------------------


def _headline(item: dict) -> dict | None:
    """Read one Yahoo news item in either shape (old flat fields or the new ``content`` block)."""
    content = item.get("content") if isinstance(item.get("content"), dict) else None
    if content is not None:
        url = content.get("canonicalUrl") or content.get("clickThroughUrl") or {}
        title = content.get("title")
        publisher = (content.get("provider") or {}).get("displayName")
        published = content.get("pubDate") or content.get("displayTime")
        link = url.get("url") if isinstance(url, dict) else url
    else:
        title = item.get("title")
        publisher = item.get("publisher")
        published = item.get("providerPublishTime")
        link = item.get("link")
    if not title:
        return None
    return {
        "title": str(title),
        "publisher": publisher or None,
        "url": link or None,
        "publishedAt": _published_at(published),
        "score": round(score_title(str(title)), 4),
    }


def _published_at(value: Any) -> str | None:
    """Normalise a publication date: epoch seconds become ISO-8601, strings stay as published."""
    if value in (None, ""):
        return None
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc).isoformat()
    return str(value)


def ticker_sentiment(
    symbol: str, fetch: Callable[[str], Sequence[dict]] = fetch_news
) -> dict | None:
    """Return {score, label, headlines, asOf} for one ticker, or None when there is no news."""
    try:
        items = [headline for headline in (_headline(item) for item in fetch(symbol)) if headline]
        if not items:
            return None
        items.sort(key=lambda headline: headline["publishedAt"] or "", reverse=True)
        scored = items[:MAX_SCORED_HEADLINES]
        score = sum(headline["score"] for headline in scored) / len(scored)
        return {
            "score": round(score, 4),
            "label": score_label(score),
            "headlines": scored[:MAX_SHOWN_HEADLINES],
            "asOf": scored[0]["publishedAt"],
        }
    except Exception as exc:  # noqa: BLE001 — a failing half is null, never fake headlines
        _warn(f"ticker sentiment unavailable for {symbol}: {exc}")
        return None


# --- the payload ---------------------------------------------------------------------------------


def build_payload(
    ticker: str,
    market_fetch: Callable[[str], dict] = fetch_market,
    news_fetch: Callable[[str], Sequence[dict]] = fetch_news,
) -> dict:
    """Return {market, ticker}; each half is independent and null when it could not be read."""
    return {
        "market": market_sentiment(fetch=market_fetch),
        "ticker": ticker_sentiment(ticker, fetch=news_fetch),
    }


def _warn(message: str) -> None:
    """Report a failed half on stderr (stdout stays machine-readable)."""
    print(f"[sentiment] {message}", file=sys.stderr)


# --- CLI -------------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Return the CLI parser (--ticker)."""
    parser = argparse.ArgumentParser(description="Market and headline sentiment for one ticker.")
    parser.add_argument("--ticker", required=True, help="the ticker to read headlines for")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Print {market, ticker} as one JSON object; return the exit code."""
    args = build_parser().parse_args(argv)
    ticker = args.ticker.strip().upper()
    if not ticker:
        print(json.dumps({"error": "ticker is required"}, ensure_ascii=False))
        return 1
    print(json.dumps(build_payload(ticker), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
