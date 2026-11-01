"""test_sentiment.py — behaviour tests for the sentiment reader (C2, S13/S15).

Purpose:
    Drives ``sentiment.py`` through its public interface with injected fetchers — no
    network, no yfinance import — pinning the two independent halves of the payload:
    the CNN Fear & Greed rating mapped to Spanish, and the headline sentiment scored with
    the embedded Loughran-McDonald subset. A failing half must be ``null``, never invented.

Key Input Dependencies:
    - py_services/sentiment.py and py_services/data/financial_lexicon.json
"""
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

import sentiment  # noqa: E402


def _market_payload(rating: str, score: float = 39.4, timestamp: int = 1793577600000) -> dict:
    return {"fear_and_greed": {"score": score, "rating": rating, "timestamp": timestamp}}


def _flat_news(count: int = 3) -> list[dict]:
    return [
        {
            "title": f"Strong company beats estimates {n}",
            "publisher": f"Reuters {n}",
            "link": f"https://example.com/{n}",
            "providerPublishTime": 1793577600 + n,
        }
        for n in range(count)
    ]


def _nested_news(count: int = 3) -> list[dict]:
    return [
        {
            "id": f"id-{n}",
            "content": {
                "title": f"Strong company beats estimates {n}",
                "provider": {"displayName": f"Reuters {n}"},
                "canonicalUrl": {"url": f"https://example.com/{n}"},
                "pubDate": f"2026-11-0{n + 1}T12:00:00Z",
            },
        }
        for n in range(count)
    ]


# --- the lexicon ----------------------------------------------------------------------


def test_lexicon_carries_its_attribution_and_both_word_lists():
    data = json.loads(Path(sentiment.LEXICON_PATH).read_text(encoding="utf-8"))
    assert "Loughran-McDonald" in data["attribution"]
    assert "no comercial" in data["attribution"]
    assert len(data["positive"]) >= 100 and len(data["negative"]) >= 100
    assert set(data["positive"]).isdisjoint(data["negative"])


# --- CNN Fear & Greed -------------------------------------------------------------------


@pytest.mark.parametrize(
    "rating,spanish",
    [
        ("extreme fear", "Miedo extremo"),
        ("fear", "Miedo"),
        ("neutral", "Neutral"),
        ("greed", "Codicia"),
        ("extreme greed", "Codicia extrema"),
    ],
)
def test_market_rating_is_mapped_to_spanish(rating, spanish):
    market = sentiment.market_sentiment(fetch=lambda url: _market_payload(rating))
    assert market["rating"] == spanish
    assert market["label"].startswith(f"{spanish}:")
    assert market["label"].count(".") == 0  # one plain sentence, no full stop


def test_market_keeps_the_published_score_and_date():
    market = sentiment.market_sentiment(fetch=lambda url: _market_payload("fear", score=24.0))
    assert market["score"] == 24.0
    assert market["asOf"].startswith("2026-11-02")


def test_market_failure_returns_none():
    def boom(url):
        raise RuntimeError("timeout")

    assert sentiment.market_sentiment(fetch=boom) is None


def test_market_unknown_rating_returns_none():
    assert sentiment.market_sentiment(fetch=lambda url: _market_payload("euphoria")) is None


# --- headline scoring -------------------------------------------------------------------


def test_title_scores_follow_the_lexicon():
    assert sentiment.score_title("Strong profit growth and record revenue beats estimates") == 1.0
    assert sentiment.score_title("Fraud lawsuit and bankruptcy losses deteriorate outlook") == -1.0
    assert sentiment.score_title("Company schedules its annual shareholder meeting") == 0.0


def test_mixed_title_scores_between_the_extremes():
    score = sentiment.score_title("Strong profit but litigation weighs on the quarter")
    assert -1.0 < score < 1.0


def test_label_thresholds():
    assert sentiment.score_label(0.15) == "Positivo"
    assert sentiment.score_label(0.14) == "Neutral"
    assert sentiment.score_label(-0.15) == "Negativo"
    assert sentiment.score_label(-0.14) == "Neutral"


# --- ticker headlines -------------------------------------------------------------------


def test_flat_news_shape_is_read():
    result = sentiment.ticker_sentiment("TMO", fetch=lambda symbol: _flat_news())
    headline = result["headlines"][0]
    assert headline["title"] == "Strong company beats estimates 2"  # latest first
    assert headline["publisher"] == "Reuters 2"
    assert headline["url"] == "https://example.com/2"
    assert headline["publishedAt"].startswith("2026-11-02")
    assert headline["score"] == 1.0
    assert (result["score"], result["label"]) == (1.0, "Positivo")


def test_nested_content_news_shape_is_read():
    result = sentiment.ticker_sentiment("TMO", fetch=lambda symbol: _nested_news())
    titles = [headline["title"] for headline in result["headlines"]]
    assert titles == [
        "Strong company beats estimates 2",
        "Strong company beats estimates 1",
        "Strong company beats estimates 0",
    ]
    assert result["headlines"][0]["publisher"] == "Reuters 2"
    assert result["headlines"][0]["url"] == "https://example.com/2"
    assert result["headlines"][0]["publishedAt"] == "2026-11-03T12:00:00Z"


def test_only_the_five_latest_headlines_are_returned():
    result = sentiment.ticker_sentiment("TMO", fetch=lambda symbol: _flat_news(12))
    assert len(result["headlines"]) == 5
    assert result["headlines"][0]["title"] == "Strong company beats estimates 11"


def test_ticker_score_is_the_mean_of_the_scored_titles():
    news = [
        {"title": "Strong profit growth", "publisher": "A", "link": "u", "providerPublishTime": 2},
        {"title": "Fraud lawsuit filed", "publisher": "B", "link": "u", "providerPublishTime": 1},
    ]
    result = sentiment.ticker_sentiment("TMO", fetch=lambda symbol: news)
    assert result["score"] == 0.0
    assert result["label"] == "Neutral"


def test_ticker_failure_returns_none():
    def boom(symbol):
        raise RuntimeError("yfinance exploded")

    assert sentiment.ticker_sentiment("TMO", fetch=boom) is None


def test_ticker_without_news_returns_none():
    assert sentiment.ticker_sentiment("TMO", fetch=lambda symbol: []) is None


# --- the payload ------------------------------------------------------------------------


def test_payload_keeps_each_half_independent():
    def boom(*args):
        raise RuntimeError("down")

    payload = sentiment.build_payload(
        "TMO", market_fetch=boom, news_fetch=lambda symbol: _flat_news()
    )
    assert payload["market"] is None
    assert payload["ticker"]["label"] == "Positivo"
    assert set(payload) == {"market", "ticker"}
