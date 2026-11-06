"""
recommendation.py — THE canonical recommendation (action) function.

Purpose:
    Single source of truth for TRIM / EXIT / ACCUMULATE / INITIATE / MAINTAIN /
    WATCHLIST across the whole app (API, every page, every script).
Layer:
    Business logic (pure function + thin SQLite loader).
Usage:
    python3 recommendation.py --all [--db PATH]   -> JSON {TICKER: {...}}
Key Functions:
    valuation_signal(upside_pct)            BUY / HOLD / SELL band
    recommend(held, upside_pct, exit_signal) pure decision
    recommend_all(db_path)                  per-ticker records for the API
    _valuation_inputs()                    selected projection and current price
    _risk_reward_fields()                  reward:risk, reduce flag and valuation support
    _recent_trades_by_symbol()             filled trades inside the recent window
    _triggered_tickers()                   evaluated thesis breaker signals
Key Input Dependencies:
    domain_model.sqlite (holdings, prices, latest projection fair value,
    thesis_breaker_state: TRIGGERED breakers = exit signal).

Policy: a recommendation is decided BEFORE targets. It uses valuation against
the latest fair value plus an explicit exit signal. Target weights play no part;
the app shows the current holding and asks the user to set the target.

Rules (held):    exit signal -> EXIT; SELL band -> TRIM; BUY band -> ACCUMULATE;
                 otherwise MAINTAIN (also when there is no valuation).
Rules (not held): BUY band -> INITIATE; otherwise WATCHLIST.
The +/-15% valuation band is the policy inherited by this refactor. Standing
decisions remain explicit review constraints; this band is not an FV-change test.

Each record also carries risk_reward and support (risk_reward.py) and
recent_trades (recent_trades.py) and decision_check (standing_decision_check.py).
They explain and cross-check the action against the saved scenarios, the owner's
filled trades and the owner's standing decision; they never change `action`.
decision_check.effective is the stance to show when the two disagree.
"""
from __future__ import annotations

import json
import math
import sys
from pathlib import Path
from datetime import date
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from recent_trades import flip_hold_note, summarize_recent_trades, trade_context, window_start  # noqa: E402
from risk_reward import SCENARIO_NAMES, _forward_check, assess_risk_reward, debt_view, evidence_date, reduce_view, valuation_support  # noqa: E402
from standing_decision_check import check_standing_decision  # noqa: E402

ACT_THRESHOLD_PCT = 15.0

ACTION_EMOJI = {
    "INITIATE": "🟢", "ACCUMULATE": "🔵", "MAINTAIN": "⚪",
    "TRIM": "🟡", "EXIT": "🔴", "WATCHLIST": "👁️",
}


def valuation_signal(upside_pct: float | None) -> str | None:
    """Classify upside to fair value into BUY / HOLD / SELL (None if unknown)."""
    if upside_pct is None or not math.isfinite(upside_pct):
        return None
    if upside_pct >= ACT_THRESHOLD_PCT:
        return "BUY"
    if upside_pct <= -ACT_THRESHOLD_PCT:
        return "SELL"
    return "HOLD"


def recommend(held: bool, upside_pct: float | None, exit_signal: bool = False) -> dict[str, Any]:
    """Return the one recommendation for a ticker.

    Args:
        held: True if shares > 0 in any account.
        upside_pct: (fair value - price) / price * 100, or None if no valuation.
        exit_signal: Explicit exit (TRIGGERED thesis breaker or EXIT projection).

    Returns:
        {"action", "reason", "valuation", "upside_pct"}.
    """
    if upside_pct is not None and not math.isfinite(upside_pct):
        upside_pct = None
    val = valuation_signal(upside_pct)
    if not held:
        action = "INITIATE" if val == "BUY" and not exit_signal else "WATCHLIST"
        reason = (f"Not held; valuation {val} ({upside_pct:+.0f}% to fair value)"
                  if val else "Not held; no valuation")
        if exit_signal:
            reason = "Not held; explicit exit signal prevents entry"
    elif exit_signal:
        action, reason = "EXIT", "Explicit exit signal (thesis breaker or EXIT projection)"
    elif val == "SELL":
        action, reason = "TRIM", f"{upside_pct:+.0f}% to fair value; valuation SELL"
    elif val == "BUY":
        action, reason = "ACCUMULATE", f"{upside_pct:+.0f}% to fair value; valuation BUY"
    elif val == "HOLD":
        action, reason = "MAINTAIN", f"Within ±{ACT_THRESHOLD_PCT:.0f}% of fair value"
    else:
        action, reason = "MAINTAIN", "No valuation available"
    return {"action": action, "reason": reason, "valuation": val, "upside_pct": upside_pct}


def _triggered_tickers(db_path: str | Path | None) -> set[str]:
    """Tickers with at least one TRIGGERED thesis breaker in domain_model.sqlite (read-only)."""
    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "investment_screener/backend/py_services"))
    from portfolio_io import load_breaker_state
    state = load_breaker_state(db_path)["holdings"]
    return {t for t, bs in state.items() if any(b.get("status") == "TRIGGERED" for b in bs.values())}


# Resolve the projection and price once before producing the recommendation.
def _valuation_inputs(conn: Any, inv_id: str, prices: dict[str, float], symbol: str) -> tuple:
    """Return the preferred projection, fair value, price, provenance and upside."""
    from domain_model.investment_price_repository import get_investment_price
    from domain_model.projection_repository import get_preferred_projection

    entry = get_preferred_projection(conn, inv_id)
    fv = entry.get("fair_value") if entry else None
    current_price = get_investment_price(conn, inv_id)
    price = current_price.get("price") if current_price else prices.get(symbol)
    if not price and entry and entry.get("snapshot_json"):
        price = json.loads(entry["snapshot_json"]).get("price")
    upside = (fv - price) / price * 100 if fv is not None and price and price > 0 else None
    return entry, fv, price, "investment_price" if current_price else "projection_snapshot", upside


REVALUE_BEFORE_ACTING_DAYS = 30  # risk_reward.REFRESH_BEFORE_ACTING_DAYS; one threshold for both


def apply_review_gate(rec: dict[str, Any], held: bool, review_state: str | None, review_reason: str | None,
                      evidence_age_days: int | None, breaker_triggered: bool) -> dict[str, Any]:
    """Withhold buy/trim calls the current analysis doesn't support. Mutates and returns ``rec``.

    1. A name still NEEDS_ANALYSIS this cycle gets no call (review_cycle.py).
    2. A valuation older than REVALUE_BEFORE_ACTING_DAYS can't drive INITIATE, ACCUMULATE, TRIM or
       EXIT; a TRIGGERED thesis breaker still drives EXIT.
    The withheld stance is MAINTAIN when held, WATCHLIST otherwise; the reason says why.
    """
    actionable = ("INITIATE", "ACCUMULATE", "TRIM", "EXIT")
    quiet = "MAINTAIN" if held else "WATCHLIST"
    if review_state == "NEEDS_ANALYSIS":
        rec.update(action=quiet, reason=f"Needs analysis this cycle ({review_reason or 'not yet reviewed'}); "
                                        f"valuation alone says {rec.get('valuation')}")
        rec["review_gate"] = {"withheld": True, "why": "NEEDS_ANALYSIS", "detail": review_reason}
        return rec
    stale = evidence_age_days is not None and evidence_age_days > REVALUE_BEFORE_ACTING_DAYS
    if stale and rec.get("action") in actionable and not (rec.get("action") == "EXIT" and breaker_triggered):
        rec["review_gate"] = {"withheld": True, "why": "STALE_VALUATION", "detail": f"valuation {evidence_age_days} days old",
                              "withheld_action": rec["action"]}
        rec.update(action=quiet, reason=f"Valuation {evidence_age_days} days old: re-value before acting "
                                        f"(it alone says {rec['action']})")
    return rec


def _log_dict(entry: dict) -> dict:
    """The projection's analytics log as a dict ({} for empty, malformed or legacy list logs)."""
    try:
        log = json.loads(entry.get("analytics_log_json") or "{}")
    except (TypeError, ValueError):
        return {}
    return log if isinstance(log, dict) else {}


def _reverified_evidence_date(entry: dict | None) -> str | None:
    """Evidence date of the saved valuation when its forward review passed (not flagged), else None.

    Older projections store analytics_log_json as a list or leave it empty; those count as not
    re-verified, so they can never lift the no-flip hold.
    """
    if not entry:
        return None
    try:
        log = json.loads(entry.get("analytics_log_json") or "{}")
    except (TypeError, ValueError):
        return None
    if not isinstance(log, dict) or not _forward_check(log)[0]:
        return None
    return evidence_date(entry.get("saved_at"), entry.get("analyzed_at"), log)


def _risk_reward_fields(conn: Any, entry: dict | None, rec: dict, price: float | None,
                        fair_value: float | None, weight: float, target: float | None) -> dict[str, Any]:
    """Build the scenario, reward:risk and support fields from the selected projection."""
    from domain_model.projection_repository import get_projection_scenarios

    rows = get_projection_scenarios(conn, entry["projection_id"]) if entry else []
    saved = {row["scenario_name"]: {"price": row["scenario_price"], "weight": row["weight"]} for row in rows}
    assessment = assess_risk_reward(price, fair_value, saved)
    assessment.update(reduce_view(rec["held"], rec["action"], assessment, weight, target))
    log = json.loads(entry["analytics_log_json"] or "{}") if entry else None
    return {
        "scenarios": {name: (saved.get(name) or {}).get("price") for name in SCENARIO_NAMES},
        "risk_reward": assessment,
        "support": valuation_support(evidence_date(entry.get("saved_at"), entry.get("analyzed_at"), log) if entry else None,
                                     log, saved, date.today()),
        # How debt was handled in this valuation (leverage.py, saved by the valuation scripts).
        "debt": debt_view(log, has_valuation=bool(entry and fair_value is not None)),
    }


def _recent_trades_by_symbol(conn: Any, today: date) -> dict[str, list[dict]]:
    """Filled trades inside the recent window, grouped by symbol (one query)."""
    from domain_model.trade_log_entry_repository import list_filled_trades_since

    from recent_trades import FLIP_HOLD_DAYS
    from datetime import timedelta
    # Fetch enough history for the flip-hold rule; summarize_recent_trades applies its own window.
    since = min(window_start(today), (today - timedelta(days=FLIP_HOLD_DAYS)).isoformat())
    grouped: dict[str, list[dict]] = {}
    for row in list_filled_trades_since(conn, since):
        grouped.setdefault(row["symbol"], []).append(row)
    return grouped


def recommend_all(db_path: str | None = None) -> dict[str, dict[str, Any]]:
    """Recommendation record for every investment in domain_model.sqlite."""
    py = str(Path(__file__).resolve().parents[3] / "investment_screener/backend/py_services")
    sys.path.insert(0, py)
    from domain_model.db_client import initialize_db
    from portfolio_io import compute_weights, load_portfolio_state, load_target_weights
    from thesis_breakers import DB_PATH

    state = load_portfolio_state(db_path=db_path)
    weights = compute_weights(state["shares"], state["prices"], state["total_usd"])
    targets = load_target_weights(db_path)
    triggered = _triggered_tickers(db_path)
    out: dict[str, dict[str, Any]] = {}
    conn = initialize_db(db_path or str(DB_PATH))
    try:
        today = date.today()
        trades = _recent_trades_by_symbol(conn, today)
        for inv_id, symbol, standing_type, standing_reason, standing_source, review_state, review_reason in conn.execute(
            "SELECT investment_id, symbol, standing_decision_type, standing_decision_reason, "
            "standing_decision_source, review_state, review_reason FROM investment;"
        ).fetchall():
            entry, fv, price, price_source, upside = _valuation_inputs(conn, inv_id, state["prices"], symbol)
            held = (state["shares"].get(symbol) or 0) > 0
            exit_signal = symbol in triggered or bool(entry and entry.get("action") == "EXIT")
            rec = recommend(held, upside, exit_signal)
            # A call may not reverse what the owner just did: no TRIM/EXIT within 30 days of a buy
            # (unless a thesis breaker triggered), no ACCUMULATE/INITIATE within 30 days of a sale.
            reverified = _reverified_evidence_date(entry)
            flip = flip_hold_note(rec["action"], trades.get(symbol, []), today, symbol in triggered, reverified)
            if flip and flip["held"]:
                rec.update(action="MAINTAIN" if held else "WATCHLIST",
                           reason=f"{flip['note']}; valuation alone says {rec['valuation']}")
            if flip:
                rec["flip_check"] = flip
            # Calls must reflect this cycle's analysis: no call while NEEDS_ANALYSIS, none from a stale valuation.
            ev = evidence_date(entry.get("saved_at"), entry.get("analyzed_at"),
                               _log_dict(entry)) if entry else None
            ev_age = (today - date.fromisoformat(str(ev)[:10])).days if ev else None
            apply_review_gate(rec, held, review_state, review_reason, ev_age, symbol in triggered)
            if standing_type or standing_reason:
                rec["reason"] += f"; standing decision {standing_type or 'USER'}: {standing_reason or 'review before trading'}"
            rec.update(ticker=symbol, held=held, exit_signal=exit_signal,
                       projection_id=entry.get("projection_id") if entry else None, current_weight_pct=round(weights.get(symbol, 0.0), 2),
                       fair_value=fv, price=price,
                       price_source=price_source,
                       standing_decision={"type": standing_type or "USER", "reason": standing_reason,
                                          "source": standing_source} if standing_type or standing_reason else None)
            rec.update(_risk_reward_fields(conn, entry, rec, price, fv, weights.get(symbol, 0.0), targets.get(symbol)))
            summary = summarize_recent_trades(trades.get(symbol, []), today)
            rec["recent_trades"] = {**summary, "context": trade_context(rec["action"], summary)}
            # One answer to "does my standing decision agree with this action, and what is the stance?"
            rec["decision_check"] = check_standing_decision(rec["action"], held, rec["standing_decision"], summary, today)
            out[symbol] = rec
    finally:
        conn.close()
    return out


if __name__ == "__main__":
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", required=True)
    ap.add_argument("--db", default=None)
    print(json.dumps(recommend_all(ap.parse_args().db)))
