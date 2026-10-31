#!/usr/bin/env python3
"""
brief_tasks.py - the daily brief as a prioritized review list (S9/S10).

Purpose:
    Turns the latest REVIEW_DAILY brief into the payload of GET /api/daily-brief/today:
    one task per ticker ("alta"/"media"/"baja"), the market bar in plain Spanish, the
    TA-stale notice and the held tickers without tasks. Every number is formatted in
    es-CL (comma decimals, U+2212 minus) because the page shows the strings as they are.

    Nothing here is a buy or a sell call: tasks are reviews. A recommendation-driven task
    exists only when the brief's already-aligned `recommendations` carry one (AGENTS rule 23
    — canonical calls come from recommendation.py through brief_recommendations.align_current_brief).

Layer:
    Backend / Python Services

Usage Examples:
    python3 brief_tasks.py --latest --db-path data/intelligence.sqlite --domain-db data/domain_model.sqlite
    from brief_tasks import build_tasks; build_tasks(brief, date.today())

Key Functions (Index):
    - build_tasks(brief, today) - the whole /today payload (pure)
    - load_latest_brief(db_path, domain_db) - the same latest brief as /api/daily-brief/latest
    - main() - CLI: prints the payload, or `null` when there is no brief

Key Input Dependencies:
    - py_services/query_ledger_brief.py (the only query of the REVIEW_DAILY ledger)

Key Output Dependencies:
    - JSON payloads use `ticker`; SQL keeps `symbol`
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

MINUS = "−"  # U+2212, the minus sign the design uses (never a hyphen)

MONTHS_ES = ("enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
             "agosto", "septiembre", "octubre", "noviembre", "diciembre")

URGENCY_ORDER = {"alta": 0, "media": 1, "baja": 2}

# A gap this deep is a thesis review, not a note (S9).
GAP_ALTA = -5.0
# A jump this big needs an explanation; below it the gap is only context.
GAP_MEDIA = 4.0
# Below this, an overnight move is not worth a task at all.
GAP_BAJA = 2.0
RSI_OVERSOLD = 30.0
# Earnings create their own task only this close. The artboard leaves tickers reporting in
# 5 days (MCD, UBER on 2026-10-30) in the "sin tareas" table, so 4 days is the task cutoff;
# a report within a week still shows up as the reason inside another ticker's task.
EARNINGS_TASK_DAYS = 4
EARNINGS_REASON_DAYS = 7

# Conviction bands in the owner's words.
STATUS_ES = {"ACCUMULATE": "Acumular", "INITIATE": "Acumular",
             "HOLD": "Mantener", "NEUTRAL": "Mantener", "MAINTAIN": "Mantener",
             "REDUCE": "Reducir", "TRIM": "Reducir", "EXIT": "Salir"}
# Aligned recommendation actions that deserve a review task today.
REC_ACTIONS = {"REDUCE": "Reducir", "TRIM": "Reducir", "EXIT": "Salir",
               "ACCUMULATE": "Acumular", "INITIATE": "Acumular"}
REC_PHRASE = {"Reducir": "reducir la posición", "Salir": "salir de la posición",
              "Acumular": "acumular la posición"}

TA_STALE_NOTE = ("Análisis técnico no actualizado hoy — RSI y tendencia vienen del cierre "
                 "anterior; el resto de los datos es de esta madrugada.")

CREDIT_ES = {"HEALTHY": "sano", "STRESSED": "con estrés", "STRESS": "con estrés",
             "TIGHTENING": "en tensión"}


# ── es-CL formatting ─────────────────────────────────────────────────────────

def _num(value: float, decimals: int) -> str:
    """19.42 -> '19,4'; -9.62 -> '−9,62'."""
    text = f"{abs(value):.{decimals}f}".replace(".", ",")
    return f"{MINUS}{text}" if value < 0 else text


def _pct(value: float, decimals: int = 2, signed: bool = True) -> str:
    """4.85 -> '+4,85 %'; 6.67 (unsigned, 0 decimals) -> '7 %'."""
    sign = "+" if signed and value > 0 else ""
    return f"{sign}{_num(value, decimals)} %"


def _long_date(iso: str | None) -> str | None:
    """'2026-11-04' -> '4 de noviembre'."""
    try:
        day = date.fromisoformat(str(iso)[:10])
    except (TypeError, ValueError):
        return None
    return f"{day.day} de {MONTHS_ES[day.month - 1]}"


# ── Market bar ───────────────────────────────────────────────────────────────

def _market_regime(brief: dict[str, Any]) -> str | None:
    regime = (brief.get("market_regime") or {}).get("regime")
    return regime or (brief.get("macro_regime") or {}).get("regime") or None


def _indicators(brief: dict[str, Any]) -> list[dict[str, Any]]:
    """VIX, S&P vs. 200d, amplitud and crédito — only the ones the brief actually carries."""
    signals = (brief.get("market_regime") or {}).get("signals") or {}
    macro = brief.get("macro_regime") or {}

    def signal_value(key: str, macro_key: str) -> float | None:
        value = (signals.get(key) or {}).get("value")
        return value if value is not None else macro.get(macro_key)

    credit_signal = (signals.get("credit") or {}).get("signal") or macro.get("credit_signal")
    rows = [
        ("vix", "VIX", signal_value("vix", "vix"), lambda v: _num(v, 1)),
        ("spy200d", "S&P vs. 200d", signal_value("spy200d", "spy_vs_200d"), lambda v: _pct(v, 1)),
        ("breadth", "Amplitud", (signals.get("breadth") or {}).get("value"),
         lambda v: _pct(v, 0, signed=False)),
        ("credit", "Crédito", signal_value("credit", "hyg_lqd_ratio"),
         lambda _v: CREDIT_ES.get(str(credit_signal).upper(), str(credit_signal).lower())),
    ]
    out = []
    for key, label, value, display in rows:
        if value is None or (key == "credit" and not credit_signal):
            continue
        # Raw float noise (VIX arrives as 19.420000076293945) must not reach the page.
        out.append({"key": key, "label": label, "value": round(float(value), 4),
                    "display": display(value)})
    return out


def _market(brief: dict[str, Any]) -> dict[str, Any]:
    regime = _market_regime(brief)
    indicators = _indicators(brief)
    key = str(regime or "").upper().replace("-", "_")
    by_key = {ind["key"]: ind for ind in indicators}

    if key in ("BULL", "RISK_ON"):
        label = "Mercado al alza"
        sentence = ("La tendencia acompaña: el índice está sobre su promedio largo y el crédito "
                    "no muestra estrés. Día para revisar con calma, no para perseguir precios.")
    elif key in ("BEAR", "RISK_OFF"):
        label = "Mercado a la baja"
        sentence = ("El mercado está a la defensiva: el riesgo se castiga. Día para proteger lo "
                    "que ya tienes, no para sumar.")
    elif key in ("NEUTRAL", "CONGESTION", "MIXED"):
        label = "Mercado neutral"
        spy, breadth = by_key.get("spy200d"), by_key.get("breadth")
        clause = ""
        if spy and spy["value"] > 0 and breadth:
            clause = (f": el índice sube, pero solo {breadth['display']} de tus acciones "
                      "lo acompaña")
        sentence = f"No hay una tendencia clara{clause}. Día para revisar, no para apurarse."
    else:
        label = "Mercado sin clasificar"
        sentence = "No hay datos de régimen para hoy: revisa cada acción por su cuenta."
    return {"regime": regime, "label": label, "sentence": sentence, "indicators": indicators}


# ── Tasks ────────────────────────────────────────────────────────────────────

def _days_away(earn: dict[str, Any] | None, today: date) -> int | None:
    """Days to the report, recomputed from today so an old brief does not lie."""
    if not earn:
        return None
    try:
        return (date.fromisoformat(str(earn.get("earnings_date"))[:10]) - today).days
    except (TypeError, ValueError):
        return earn.get("days_away")


def _gap_phrase(gap: float, prev_close: float | None, current: float | None) -> str:
    if gap <= -8:
        verb = "Se desplomó"
    elif gap <= GAP_ALTA:
        verb = "Cayó"
    elif gap < 0:
        verb = "Bajó"
    elif gap >= GAP_MEDIA:
        verb = "Saltó"
    else:
        verb = "Subió"
    overnight = " anoche" if abs(gap) >= GAP_MEDIA else ""
    prices = (f" ({_num(prev_close, 2)} → {_num(current, 2)} USD)"
              if prev_close is not None and current is not None else "")
    return f"{verb} {_pct(gap)}{overnight}{prices}"


def _rec_action(rec: dict[str, Any] | None) -> str | None:
    """The aligned stance in Spanish, or None. Never derived here (rule 23)."""
    if not rec:
        return None
    action = str(rec.get("recommendation") or rec.get("signal") or "").upper()
    return REC_ACTIONS.get(action)


def _task_for(ticker: str, gap: dict[str, Any] | None, score: dict[str, Any],
              earn: dict[str, Any] | None, breaker: bool, rec: dict[str, Any] | None,
              today: date) -> dict[str, Any] | None:
    """One ticker's task, or None when nothing is worth reviewing today."""
    change = (gap or {}).get("change_pct")
    rsi = score.get("rsi")
    days = _days_away(earn, today)
    earnings_date = _long_date((earn or {}).get("earnings_date"))
    rec_action = _rec_action(rec)
    oversold = rsi is not None and rsi < RSI_OVERSOLD

    # Candidates in rule order; the most urgent wins, ties keep this order.
    candidates: list[tuple[str, str, str]] = []
    if breaker:
        candidates.append(("alta", "Revisar la tesis", "Alerta de tesis activada"))
    if rec_action:
        candidates.append(("alta", "Revisar la tesis", f"Recomendación vigente: {rec_action}"))
    if change is not None and change <= GAP_ALTA:
        if oversold:
            tag = f"Sobreventa: RSI {_num(rsi, 1)}"
        elif days is not None and days <= EARNINGS_REASON_DAYS:
            tag = "Caída antes de resultados"
        else:
            tag = "Caída fuerte"
        candidates.append(("alta", "Revisar la tesis", tag))
    if days is not None and 0 <= days <= EARNINGS_TASK_DAYS:
        unit = "día" if days == 1 else "días"
        candidates.append(("media", "Anotar la fecha", f"Resultados en {days} {unit}"))
    if change is not None and change >= GAP_MEDIA:
        candidates.append(("media", "Buscar la causa", "Subida sin explicación"))
    if oversold:
        candidates.append(("media", "Vigilar el rebote", f"Sobreventa: RSI {_num(rsi, 1)}"))
    if change is not None and abs(change) >= GAP_BAJA:
        tag = "Anotar la fecha" if earnings_date and days is not None and days <= EARNINGS_REASON_DAYS \
            else "Está en seguimiento"
        candidates.append(("baja", "Sin acción", tag))
    if not candidates:
        return None
    urgency, action, tag = min(candidates, key=lambda c: URGENCY_ORDER[c[0]])

    # One merged reason besides the move itself, most important first.
    reason = None
    if breaker:
        reason = ("y", "se activó una alerta de tesis")
    elif rec_action:
        reason = ("y", f"la recomendación vigente es {REC_PHRASE[rec_action]}")
    elif earnings_date and days is not None and days <= EARNINGS_REASON_DAYS:
        reason = ("y", f"publica resultados el {earnings_date}")
    elif oversold:
        connector = "pero" if change is not None and change > 0 else "y"
        reason = (connector, f"sigue en sobreventa (RSI {_num(rsi, 1)})")

    if change is None:
        summary = reason[1][0].upper() + reason[1][1:] + "."
    else:
        head = _gap_phrase(change, (gap or {}).get("prev_close"), (gap or {}).get("current"))
        if reason:
            summary = f"{head} {reason[0]} {reason[1]}."
        elif change >= GAP_MEDIA:
            summary = f"{head} sin noticia registrada en el sistema."
        else:
            summary = f"{head}."

    link = "watchlist" if str(score.get("band") or "").upper() == "WATCHLIST" else "analysis"
    return {"urgency": urgency, "ticker": ticker, "summary": summary,
            "action": action, "tag": tag, "link": link,
            "_gap": abs(change) if change is not None else 0.0}


# ── Tickers without a task ───────────────────────────────────────────────────

def _untasked_note(score: dict[str, Any], earnings_date: str | None) -> str:
    rsi = score.get("rsi")
    flags = score.get("flags") or []
    if rsi is None:
        base = "Sin historial de precios suficiente para calcular"
    elif rsi < 35:
        base = "Impulso negativo, cerca de sobreventa"
    elif "ADX_STRONG" in flags:
        base = "Tendencia fuerte"
    elif "ADX_WEAK" in flags:
        base = "Sin dirección clara"
    else:
        base = ""
    if not base:
        return f"Publica resultados el {earnings_date}" if earnings_date else "Sin cambios relevantes"
    if earnings_date:
        return f"{base}; publica resultados el {earnings_date}"
    return f"{base}, sin cambios" if base == "Tendencia fuerte" else base


# ── Payload ──────────────────────────────────────────────────────────────────

def build_tasks(brief: dict[str, Any], today: date) -> dict[str, Any]:
    """The /api/daily-brief/today payload for one brief (pure, no I/O).

    Args:
        brief: A REVIEW_DAILY payload, already aligned with current recommendations.
        today: The day the list is read on (earnings distances are measured from it).

    Returns:
        {date, generatedAt, market, tasks, untasked, taFresh, taNote, counts}.
    """
    scores = {s["ticker"]: s for s in brief.get("conviction_scores") or []}
    gaps = {g["ticker"]: g for g in brief.get("overnight_gaps") or []}
    earnings = {e["ticker"]: e for e in brief.get("earnings_flags") or []}
    recs = {r["ticker"]: r for r in brief.get("recommendations") or []}
    breakers = {b.get("ticker") if isinstance(b, dict) else b
                for b in brief.get("thesis_breakers_triggered") or []}

    order = list(scores) + [t for t in list(gaps) + list(recs) if t not in scores]
    tasks = []
    for ticker in order:
        task = _task_for(ticker, gaps.get(ticker), scores.get(ticker) or {},
                         earnings.get(ticker), ticker in breakers, recs.get(ticker), today)
        if task:
            tasks.append(task)
    tasks.sort(key=lambda t: (URGENCY_ORDER[t["urgency"]], -t["_gap"]))
    tasked = {t["ticker"] for t in tasks}
    for task in tasks:
        task.pop("_gap")

    untasked = []
    for ticker, score in scores.items():
        if ticker in tasked:
            continue
        earn = earnings.get(ticker)
        days = _days_away(earn, today)
        when = _long_date((earn or {}).get("earnings_date")) if (
            days is not None and days <= EARNINGS_REASON_DAYS) else None
        untasked.append({
            "ticker": ticker,
            "status": STATUS_ES.get(str(score.get("band") or "").upper(), "En seguimiento"),
            "rsi": score.get("rsi"),
            "note": _untasked_note(score, when),
        })

    ta_fresh = bool(brief.get("ta_refreshed"))
    skip_reason = (brief.get("ta_skip_reason") or "").strip()
    ta_note = None if ta_fresh else (f"{TA_STALE_NOTE} ({skip_reason})" if skip_reason else TA_STALE_NOTE)

    return {
        "date": brief.get("date"),
        "generatedAt": brief.get("timestamp"),
        "market": _market(brief),
        "tasks": tasks,
        "untasked": untasked,
        "taFresh": ta_fresh,
        "taNote": ta_note,
        "counts": {"tasks": len(tasks), "untasked": len(untasked)},
    }


def load_latest_brief(db_path: str | None = None, domain_db: str | None = None) -> dict[str, Any] | None:
    """The latest REVIEW_DAILY brief, exactly as /api/daily-brief/latest reads it.

    Runs query_ledger_brief.py — the single owner of the ledger query (rule 19) — so the
    "no ledger yet" and alignment behaviours cannot drift between the two endpoints.
    """
    cmd = [sys.executable, str(Path(__file__).with_name("query_ledger_brief.py")), "--latest"]
    if domain_db:
        cmd += ["--current-recommendations", "--domain-db", domain_db]
    if db_path:
        cmd += ["--db-path", db_path]
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    return json.loads(result.stdout.strip() or "null")


def main() -> None:
    parser = argparse.ArgumentParser(description="Daily brief review list (S9/S10)")
    parser.add_argument("--latest", action="store_true", required=True)
    parser.add_argument("--db-path", type=str)
    parser.add_argument("--domain-db", type=str)
    args = parser.parse_args()

    brief = load_latest_brief(args.db_path, args.domain_db)
    if not brief:
        print(json.dumps(None))
        return
    print(json.dumps(build_tasks(brief, datetime.now().date()), ensure_ascii=False))


if __name__ == "__main__":
    main()
