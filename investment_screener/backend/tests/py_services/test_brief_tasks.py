"""Tests for brief_tasks.py — the daily brief's prioritized review list (S9/S10).

build_tasks() turns the latest REVIEW_DAILY brief into the /api/daily-brief/today payload:
one task per ticker (highest urgency wins, reasons merged), Spanish copy in es-CL number
format, the market bar in plain words, the TA-stale notice and the held tickers without
tasks. It never derives a buy or sell call: recommendation-driven tasks come only from the
brief's already-aligned `recommendations` (AGENTS rule 23).

Run:
    python3 -m pytest investment_screener/backend/tests/py_services/test_brief_tasks.py -q
"""
from __future__ import annotations

import json
import subprocess
import sys
from datetime import date
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[4]
PY_SERVICES = REPO_ROOT / "investment_screener/backend/py_services"
FIXTURES = Path(__file__).resolve().parent / "fixtures/daily_brief"
sys.path.insert(0, str(PY_SERVICES))

from brief_tasks import build_tasks  # noqa: E402


def _fixture(name: str) -> dict:
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def _today(name: str = "brief_2026-10-30.json", on: date = date(2026, 10, 30)) -> dict:
    return build_tasks(_fixture(name), on)


def _task(payload: dict, ticker: str) -> dict:
    return next(t for t in payload["tasks"] if t["ticker"] == ticker)


# ── Tasks ────────────────────────────────────────────────────────────────────

def test_app_is_alta_with_the_artboard_sentence():
    task = _task(_today(), "APP")
    assert task["urgency"] == "alta"
    assert task["summary"] == (
        "Se desplomó −9,62 % anoche (252,83 → 228,50 USD) y publica resultados "
        "el 4 de noviembre."
    )
    assert task["action"] == "Revisar la tesis"
    assert task["tag"] == "Sobreventa: RSI 24,9"
    assert task["link"] == "analysis"


def test_vitl_gap_and_earnings_merge_into_one_alta_task():
    task = _task(_today(), "VITL")
    assert task["urgency"] == "alta"
    assert task["summary"] == (
        "Cayó −6,57 % anoche (9,28 → 8,67 USD) y publica resultados el 3 de noviembre."
    )
    assert task["action"] == "Revisar la tesis"
    assert task["tag"] == "Caída antes de resultados"


def test_bkng_small_gap_plus_imminent_earnings_is_media():
    task = _task(_today(), "BKNG")
    assert task["urgency"] == "media"
    assert task["summary"] == (
        "Bajó −3,03 % (152,76 → 148,13 USD) y publica resultados el 3 de noviembre."
    )
    assert task["action"] == "Anotar la fecha"
    assert task["tag"] == "Resultados en 4 días"


def test_tmus_unexplained_jump_is_media_buscar_la_causa():
    task = _task(_today(), "TMUS")
    assert task["urgency"] == "media"
    assert task["summary"] == (
        "Saltó +4,85 % anoche (149,20 → 156,44 USD) sin noticia registrada en el sistema."
    )
    assert task["action"] == "Buscar la causa"
    assert task["tag"] == "Subida sin explicación"


def test_sfm_oversold_is_media_vigilar_el_rebote():
    task = _task(_today(), "SFM")
    assert task["urgency"] == "media"
    assert task["summary"] == (
        "Subió +3,78 % (47,89 → 49,70 USD) pero sigue en sobreventa (RSI 25,1)."
    )
    assert task["action"] == "Vigilar el rebote"
    assert task["tag"] == "Sobreventa: RSI 25,1"


def test_small_gaps_are_baja_and_a_watchlist_ticker_links_to_the_watchlist():
    nvda = _task(_today(), "NVDA")
    assert nvda["urgency"] == "baja"
    assert nvda["summary"] == "Bajó −2,62 % (210,15 → 204,64 USD)."
    assert nvda["action"] == "Sin acción"
    assert nvda["tag"] == "Está en seguimiento"
    assert nvda["link"] == "watchlist"

    nvo = _task(_today(), "NVO")
    assert nvo["urgency"] == "baja"
    assert nvo["summary"] == "Subió +2,70 % (38,95 → 40,00 USD) y publica resultados el 4 de noviembre."
    assert nvo["action"] == "Sin acción"
    assert nvo["tag"] == "Anotar la fecha"
    assert nvo["link"] == "analysis"


def test_tasks_are_one_per_ticker_sorted_by_urgency_then_gap_size():
    payload = _today()
    assert [t["ticker"] for t in payload["tasks"]] == [
        "APP", "VITL", "TMUS", "SFM", "BKNG", "NVO", "NVDA",
    ]
    assert payload["counts"] == {"tasks": 7, "untasked": 9}


def test_a_reduce_recommendation_makes_an_alta_task_without_any_gap():
    payload = build_tasks(_fixture("brief_reduce.json"), date(2026, 11, 2))
    task = _task(payload, "NFLX")
    assert task["urgency"] == "alta"
    assert task["summary"] == "La recomendación vigente es reducir la posición."
    assert task["action"] == "Revisar la tesis"
    assert task["tag"] == "Recomendación vigente: Reducir"
    assert [u["ticker"] for u in payload["untasked"]] == ["VICI"]


def test_an_empty_brief_produces_no_tasks():
    payload = build_tasks(_fixture("brief_empty.json"), date(2026, 11, 2))
    assert payload["tasks"] == []
    assert payload["untasked"] == []
    assert payload["counts"] == {"tasks": 0, "untasked": 0}
    assert payload["market"]["regime"] is None
    assert payload["market"]["label"] == "Mercado sin clasificar"
    assert payload["market"]["indicators"] == []


# ── Market bar, TA notice, untasked table ────────────────────────────────────

def test_market_bar_is_plain_spanish_with_indicators_from_the_regime():
    market = _today()["market"]
    assert market["regime"] == "NEUTRAL"
    assert market["label"] == "Mercado neutral"
    assert market["sentence"] == (
        "No hay una tendencia clara: el índice sube, pero solo 7 % de tus acciones "
        "lo acompaña. Día para revisar, no para apurarse."
    )
    assert market["indicators"] == [
        {"key": "vix", "label": "VIX", "value": 19.42, "display": "19,4"},
        {"key": "spy200d", "label": "S&P vs. 200d", "value": 4.1, "display": "+4,1 %"},
        {"key": "breadth", "label": "Amplitud", "value": 6.67, "display": "7 %"},
        {"key": "credit", "label": "Crédito", "value": 0.7426, "display": "sano"},
    ]


def test_ta_stale_notice_when_the_sweep_did_not_run():
    payload = _today()
    assert payload["taFresh"] is False
    assert payload["taNote"] == (
        "Análisis técnico no actualizado hoy — RSI y tendencia vienen del cierre "
        "anterior; el resto de los datos es de esta madrugada."
    )
    assert payload["date"] == "2026-10-30"
    assert payload["generatedAt"] == "2026-10-31T02:28:57.829523+00:00"


def test_a_fresh_ta_sweep_leaves_no_notice():
    payload = build_tasks(_fixture("brief_empty.json"), date(2026, 11, 2))
    assert payload["taFresh"] is True
    assert payload["taNote"] is None


def test_untasked_table_lists_the_remaining_tickers_with_status_rsi_and_note():
    assert _today()["untasked"] == [
        {"ticker": "MCD", "status": "Mantener", "rsi": 68.2,
         "note": "Tendencia fuerte; publica resultados el 4 de noviembre"},
        {"ticker": "PEP", "status": "Mantener", "rsi": 61.4, "note": "Tendencia fuerte, sin cambios"},
        {"ticker": "AXP", "status": "Mantener", "rsi": 54.3, "note": "Sin dirección clara"},
        {"ticker": "DECK", "status": "Mantener", "rsi": 47.3, "note": "Sin cambios relevantes"},
        {"ticker": "NFLX", "status": "Mantener", "rsi": 30.9,
         "note": "Impulso negativo, cerca de sobreventa"},
        {"ticker": "TSMC", "status": "En seguimiento", "rsi": None,
         "note": "Sin historial de precios suficiente para calcular"},
        {"ticker": "UBER", "status": "Mantener", "rsi": 36.2,
         "note": "Publica resultados el 4 de noviembre"},
        {"ticker": "VICI", "status": "Mantener", "rsi": 60.2, "note": "Sin cambios relevantes"},
        {"ticker": "SFD", "status": "Mantener", "rsi": 39.8, "note": "Tendencia fuerte, sin cambios"},
    ]


# ── CLI ──────────────────────────────────────────────────────────────────────

def test_cli_prints_null_when_the_ledger_has_no_brief(tmp_path):
    result = subprocess.run(
        [sys.executable, str(PY_SERVICES / "brief_tasks.py"), "--latest",
         "--db-path", str(tmp_path / "missing.sqlite")],
        capture_output=True, text=True, timeout=120,
    )
    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) is None
