#!/usr/bin/env python3
"""opportunity_screener.py — THE opportunity screening engine over the Racional universe (S3-S8).

Purpose:
    One informational filter: it walks the latest TradingView scanner snapshot of the Racional
    universe, answers the six questions of the "Embudo" design for each instrument, and returns
    the JSON the Oportunidades page renders. Rule 19 makes this module the only place these
    formulas live — Graham's intrinsic value, the margin of safety, the FCF yield, the drop from
    the 52-week high and the sector median P/E are defined here and nowhere else.

    It is a screener, NOT a recommendation: nothing here produces a buy/sell call. Canonical
    calls come from recommendation.py (rule 23); the stars below only say how many of the six
    questions an instrument currently answers.

    Reading rules it never breaks: a missing number is missing data (the item's ``ok`` is null
    and its group is not met), it is never silently treated as a failed condition; and ROIC /
    free-cash-flow items are "No aplica" for Finance and Utilities, where the metric is not
    meaningful, so they can never cost a star.

Layer:
    Backend / Python Services

Usage Examples:
    python3 opportunity_screener.py --params '{"require": "1,4", "mos": 25}'
    python3 opportunity_screener.py --params '{}' --db /tmp/opp_smoke.sqlite
    from opportunity_screener import build_response; build_response(conn, {"require": "1"})

Exit codes:
    0 = response printed, 1 = no scanner snapshot yet (JSON {error, code: SCREEN_DATA_MISSING})

Key Classes / Functions (Index):
    - PARAM_DEFAULTS / STEPS: the S8 defaults and the six ordered steps
    - ScreenDataMissing: raised (-> HTTP 503) while stock_screen_snapshot is empty
    - graham_value(eps, g, y) / graham_growth(growth): Graham's V and its capped g
    - margin_of_safety(value, price) / fcf_yield(fcf, mcap) / drop_pct(price, high52)
    - sector_median_pe(rows): median positive P/E per sector, over the snapshot
    - fmt_number / fmt_pct / fmt_signed_pct: the Spanish displays ("16,2 %", "+20 %")
    - build_groups(row, params, context): the five condition groups of one instrument
    - evaluate_row(row, params, context): one response row (metrics + groups + stars)
    - build_response(conn, params): the exact S8/S15 payload
    - main(argv): the CLI the Node bridge spawns

Key Input Dependencies:
    - stock_screen_snapshot + market_rate (migration 0015), stocks_origin (0013),
      recent_buys_q + recent_buys_insider (0014), stock_risk_metrics + stock_eps_revisions +
      stock_superinvestor_holdings (0016) of domain_model.sqlite
    - params: require, roic, roe, roa, de, mos, fcfy, peg, target, drop, sortino, dbeta, rev,
      sup, ins, etf

Key Output Dependencies:
    - stdout: one JSON object (the S8 contract) consumed by OpportunitiesService.ts
    - writes nothing: this module is read-only over the domain model
"""
from __future__ import annotations

import argparse
import json
import sqlite3
import statistics
import sys
from pathlib import Path
from typing import Any, Sequence

REPO_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_DB_PATH = REPO_ROOT / "investment_screener/backend/data/domain_model.sqlite"

sys.path.insert(0, str(Path(__file__).resolve().parent))

from domain_model.db_client import initialize_db  # noqa: E402

#: The S8/S15 query contract: GET /api/opportunities?require=1,4&roic=15&... (percent units).
PARAM_DEFAULTS: dict[str, Any] = {
    "require": "1,4", "roic": 15.0, "roe": 15.0, "roa": 7.0, "de": 0.5, "mos": 25.0,
    "fcfy": 5.0, "peg": 1.0, "target": 20.0, "drop": 20.0,
    "sortino": 0.5, "dbeta": 1.2, "rev": 0,
    "sup": 1, "ins": 2, "etf": 0,
}
#: The six questions of the funnel, in order; step 1 is a prerequisite and earns no star.
STEPS = (
    (1, "gana"), (2, "calidad"), (3, "precio"), (4, "caida"), (5, "sana"), (6, "expertos"),
)
GROUP_IDS = ("calidad", "precio", "caida", "sana", "expertos")
#: Sectors where ROIC and free cash flow are not meaningful, so those items never cost a star.
NOT_APPLICABLE_SECTORS = ("finance", "utilities")
#: An insider purchase older than this no longer counts towards a cluster.
INSIDER_WINDOW_DAYS = 90
MAX_ROWS = 200
MISSING_DISPLAY = "Datos insuficientes"
NOT_APPLICABLE_DISPLAY = "No aplica"


class ScreenDataMissing(RuntimeError):
    """No TradingView scanner snapshot exists yet, so nothing can be screened (-> HTTP 503)."""


# --- the formulas (rule 19: one implementation per concept) ------------------------------


def graham_value(eps: float | None, g: float | None, y: float | None) -> float | None:
    """Graham's intrinsic value V = EPS x (8.5 + 2g) x 4.4 / Y; None without earnings or Y."""
    if eps is None or eps <= 0 or g is None or y is None or y <= 0:
        return None
    return eps * (8.5 + 2 * g) * 4.4 / y


def graham_growth(growth_pct: float | None) -> float | None:
    """The g Graham's formula may use: the published EPS growth capped to [0, 15] % (S7)."""
    if growth_pct is None:
        return None
    return max(0.0, min(15.0, float(growth_pct)))


def margin_of_safety(value: float | None, price: float | None) -> float | None:
    """How far below its estimated value the price sits, in % (negative = it costs more)."""
    if value is None or value <= 0 or price is None:
        return None
    return (value - price) / value * 100


def fcf_yield(free_cash_flow: float | None, market_cap: float | None) -> float | None:
    """Free cash flow as a % of market capitalisation (what $100 of price buys per year)."""
    if free_cash_flow is None or not market_cap or market_cap <= 0:
        return None
    return free_cash_flow / market_cap * 100


def drop_pct(price: float | None, high52: float | None) -> float | None:
    """Change from the 52-week high, in % (a fall is negative)."""
    if price is None or not high52 or high52 <= 0:
        return None
    return (price / high52 - 1) * 100


def sector_median_pe(rows: Sequence[dict]) -> dict[str, float]:
    """Median P/E per sector over the snapshot, counting only positive ratios."""
    by_sector: dict[str, list[float]] = {}
    for row in rows:
        pe = row.get("pe_ttm")
        if row.get("sector") and pe is not None and pe > 0:
            by_sector.setdefault(row["sector"], []).append(float(pe))
    return {sector: statistics.median(values) for sector, values in by_sector.items()}


# --- Spanish displays --------------------------------------------------------------------


def fmt_number(value: float | None, decimals: int = 1) -> str | None:
    """Format a number the way the page shows it (decimal comma): 16.2 -> '16,2'."""
    if value is None:
        return None
    return f"{float(value):.{decimals}f}".replace(".", ",")


def fmt_pct(value: float | None, decimals: int = 1) -> str | None:
    """Format a percentage: 16.2 -> '16,2 %'."""
    text = fmt_number(value, decimals)
    return None if text is None else f"{text} %"


def fmt_signed_pct(value: float | None, decimals: int = 0) -> str | None:
    """Format a percentage that always shows its sign: 20 -> '+20 %', -5 -> '-5 %'."""
    text = fmt_pct(value, decimals)
    if text is None:
        return None
    return f"+{text}" if value >= 0 else text


def item(key: str, label: str, value: float | None, display: str | None, threshold: str,
         ok: bool | None, not_applicable: bool = False, informational: bool = False) -> dict:
    """One checklist entry of a group, with the display the page prints verbatim.

    ``ok`` is None for the three kinds of "cannot say": the metric does not apply to this
    sector (``not_applicable``, shown as "No aplica"), the source published no number (shown
    as "Datos insuficientes"), or the entry is ``informational`` — a number the detail shows
    (the worst drawdown, the experts' average price) that is no condition at all. Neither an
    inapplicable nor an informational entry takes part in its group's verdict, so neither can
    ever cost or earn a star.
    """
    if not_applicable:
        return {"key": key, "label": label, "value": value, "display": NOT_APPLICABLE_DISPLAY,
                "threshold": threshold, "ok": None, "notApplicable": True,
                "informational": False}
    if value is None or display is None:
        return {"key": key, "label": label, "value": None, "display": MISSING_DISPLAY,
                "threshold": threshold, "ok": None, "notApplicable": False,
                "informational": informational}
    return {"key": key, "label": label, "value": value, "display": display,
            "threshold": threshold, "ok": None if informational else ok,
            "notApplicable": False, "informational": informational}


# --- the five condition groups -----------------------------------------------------------


def quality_items(row: dict, params: dict, excluded: bool) -> list[dict]:
    """"¿Es un buen negocio?" — returns, free cash flow and leverage (S3 Buffett/checklist)."""
    fcf = row.get("free_cash_flow")
    return [
        item("roic", "Gana por cada $1 invertido (ROIC)", row.get("roic"),
             fmt_pct(row.get("roic")), f"≥ {fmt_number(params['roic'], 0)} %",
             (row.get("roic") or 0) >= params["roic"], excluded),
        item("roe", "Gana sobre el dinero de los dueños (ROE)", row.get("roe"),
             fmt_pct(row.get("roe")), f"≥ {fmt_number(params['roe'], 0)} %",
             (row.get("roe") or 0) >= params["roe"]),
        item("roa", "Gana sobre todo lo que tiene (ROA)", row.get("roa"),
             fmt_pct(row.get("roa")), f"≥ {fmt_number(params['roa'], 0)} %",
             (row.get("roa") or 0) >= params["roa"]),
        item("fcf", "Genera efectivo real (flujo de caja libre)", fcf,
             None if fcf is None else ("positivo" if fcf > 0 else "negativo"), "positivo",
             fcf is not None and fcf > 0, excluded),
        item("de", "Debe poco (deuda / patrimonio)", row.get("debt_to_equity"),
             fmt_number(row.get("debt_to_equity"), 2), f"≤ {fmt_number(params['de'], 1)}",
             (row.get("debt_to_equity") if row.get("debt_to_equity") is not None else 1e9)
             <= params["de"]),
    ]


def price_items(row: dict, params: dict, metrics: dict, excluded: bool) -> list[dict]:
    """"¿Está a buen precio?" — P/E vs its sector, FCF yield, PEG and the Graham margin."""
    pe, sector_pe, mos = metrics["pe"], metrics["sectorPe"], metrics["mos"]
    pe_display = None if pe is None or sector_pe is None else \
        f"{fmt_number(pe, 1)} vs {fmt_number(sector_pe, 1)}"
    items = [
        item("pe", "Años de ganancias que pagas vs. su sector (P/E)", pe, pe_display, "menor",
             pe is not None and sector_pe is not None and pe < sector_pe),
        item("fcfy", "Efectivo que genera por cada $100 (FCF yield)", metrics["fcfYield"],
             fmt_pct(metrics["fcfYield"]), f"≥ {fmt_number(params['fcfy'], 0)} %",
             (metrics["fcfYield"] or -1e9) >= params["fcfy"], excluded),
        item("peg", "Precio justo para su crecimiento (PEG)", row.get("peg"),
             fmt_number(row.get("peg"), 2), f"≤ {fmt_number(params['peg'], 1)}",
             (row.get("peg") if row.get("peg") is not None else 1e9) <= params["peg"]),
        item("mos", "Colchón bajo su valor (margen Graham)", mos, fmt_pct(mos),
             f"≥ {fmt_number(params['mos'], 0)} %", (mos or -1e9) >= params["mos"]),
    ]
    if params["target"] > 0:
        target_pct = metrics["targetPct"]
        items.append(item(
            "target", "Subida que esperan los analistas", target_pct,
            fmt_signed_pct(target_pct), f"≥ {fmt_signed_pct(params['target'])}",
            (target_pct or -1e9) >= params["target"]))
    return items


def fall_items(row: dict, params: dict, metrics: dict) -> list[dict]:
    """"¿Cayó por causas externas?" — the drop from the 52-week high, below the 200-day average."""
    below = metrics["belowSma200"]
    return [
        item("drop", "Bajó desde su máximo del año", metrics["dropPct"],
             fmt_pct(metrics["dropPct"]), f"≥ {fmt_number(params['drop'], 0)} %",
             (metrics["dropPct"] if metrics["dropPct"] is not None else 1e9) <= -params["drop"]),
        item("sma200", "Está bajo su promedio de 200 días", row.get("sma200"),
             None if below is None else ("sí" if below else "no"), "sí", below is True),
    ]


def healthy_items(params: dict, risk: dict | None, revisions: dict | None) -> list[dict]:
    """"¿Es una caída sana?" — paid for its risk, fell less than the market, estimates holding.

    Three conditions (Sortino, downside beta, net 30-day revisions) and two numbers the detail
    shows without judging them: the worst three-year drawdown and how long it took to recover.
    A symbol with less than two years of history has no risk row, so every condition reads
    "Datos insuficientes" and the group is not met (S11).
    """
    sortino = (risk or {}).get("sortino")
    dbeta = (risk or {}).get("downsideBeta")
    drawdown = (risk or {}).get("maxDrawdown")
    net = None if revisions is None else revisions["net"]
    return [
        item("sortino", "Rinde bien para el riesgo que corre (Sortino 3 años)", sortino,
             fmt_number(sortino, 2), f"≥ {fmt_number(params['sortino'], 2)}",
             sortino is not None and sortino >= params["sortino"]),
        item("dbeta", "Cae menos que el mercado en días malos (beta bajista)", dbeta,
             fmt_number(dbeta, 2), f"≤ {fmt_number(params['dbeta'], 2)}",
             dbeta is not None and dbeta <= params["dbeta"]),
        item("rev", "Los analistas no bajan sus estimaciones (revisiones 30 días)", net,
             None if net is None else f"+{net}" if net > 0 else str(net),
             f"≥ {int(params['rev'])}", net is not None and net >= params["rev"]),
        item("drawdown", "Peor caída en 3 años", drawdown, _drawdown_display(drawdown, risk),
             "informativo", None, informational=True),
    ]


def _drawdown_display(drawdown: float | None, risk: dict | None) -> str | None:
    """"−38 % · se recuperó en 214 días" (or "· aún no se recupera") for the detail."""
    if drawdown is None:
        return None
    days = (risk or {}).get("recoveryDays")
    recovery = f"se recuperó en {int(days)} días" if days is not None else "aún no se recupera"
    return f"−{fmt_number(abs(drawdown) * 100, 0)} % · {recovery}"


def expert_items(params: dict, dataroma: dict, price: float | None) -> list[dict]:
    """"¿Lo compran los expertos?" — the buys that gate the group, plus what they hold (S12)."""
    max_pct = dataroma.get("maxPortfolioPct")
    avg_price = dataroma.get("avgHoldPrice")
    holders = dataroma.get("holders")
    return [
        item("superinvestors", "Grandes inversores compraron", dataroma["superinvestors"],
             f"{dataroma['superinvestors']} compras", f"≥ {int(params['sup'])}",
             dataroma["superinvestors"] >= params["sup"]),
        item("insiders", "Varios directivos compraron", dataroma["insiders"],
             f"{dataroma['insiders']} compras", f"≥ {int(params['ins'])}",
             dataroma["insiderCluster"]),
        item("holders", "Grandes inversores que la tienen", holders,
             None if holders is None else f"{int(holders)} fondos", "informativo", None,
             informational=True),
        item("maxPortfolioPct", "Peso máximo en su cartera (convicción)", max_pct,
             fmt_pct(max_pct), "informativo", None, informational=True),
        item("expertsPrice", "Precio vs. el de compra de los expertos", avg_price,
             None if avg_price is None or price is None
             else f"{fmt_number(price, 1)} vs {fmt_number(avg_price, 1)}",
             "informativo", None, informational=True),
    ]


def group_verdict(items: Sequence[dict], any_of: bool = False) -> dict:
    """Wrap a group's items with its verdict: every applicable item (or any, for 'expertos').

    Informational entries are shown but never judged, so they cannot change the star count.
    """
    applicable = [entry for entry in items
                  if not entry["notApplicable"] and not entry.get("informational")]
    oks = [entry["ok"] for entry in applicable]
    ok = any(value is True for value in oks) if any_of else all(value is True for value in oks)
    return {"ok": bool(ok) and bool(applicable), "notApplicable": not applicable, "items": list(items)}


def build_groups(row: dict, params: dict, metrics: dict, dataroma: dict,
                 risk: dict | None, revisions: dict | None) -> dict:
    """The five starred groups of one instrument, each with its items and verdict."""
    excluded = (row.get("sector") or "").strip().lower() in NOT_APPLICABLE_SECTORS
    return {
        "calidad": group_verdict(quality_items(row, params, excluded)),
        "precio": group_verdict(price_items(row, params, metrics, excluded)),
        "caida": group_verdict(fall_items(row, params, metrics)),
        "sana": group_verdict(healthy_items(params, risk, revisions)),
        "expertos": group_verdict(expert_items(params, dataroma, row.get("close")), any_of=True),
    }


# --- one row ------------------------------------------------------------------------------


def row_metrics(row: dict, sector_pe: dict[str, float], aaa: float | None) -> dict:
    """Everything derived from one snapshot row, computed once and reused by items and payload."""
    price = row.get("close")
    growth = graham_growth(row.get("eps_growth_pct"))
    value = graham_value(row.get("eps_ttm"), growth, aaa)
    target = row.get("price_target_average")
    return {
        "pe": row.get("pe_ttm"),
        "sectorPe": sector_pe.get(row.get("sector") or ""),
        "grahamValue": value,
        "grahamGrowth": growth,
        "mos": margin_of_safety(value, price),
        "fcfYield": fcf_yield(row.get("free_cash_flow"), row.get("market_cap")),
        "dropPct": drop_pct(price, row.get("price_52_week_high")),
        "targetPct": None if target is None or not price else (target / price - 1) * 100,
        "aboveSma50": None if price is None or row.get("sma50") is None else price > row["sma50"],
        "belowSma200": None if price is None or row.get("sma200") is None else price < row["sma200"],
    }


def analysts_block(row: dict, metrics: dict) -> dict | None:
    """The analyst consensus as the page reads it: buy-side = total - hold - sell (S7)."""
    total = row.get("recommendation_total")
    if not total:
        return None
    hold = int(row.get("recommendation_hold") or 0)
    sell = int(row.get("recommendation_sell") or 0)
    return {"buy": int(total) - hold - sell, "hold": hold, "sell": sell, "total": int(total),
            "targetPct": metrics["targetPct"]}


def fallen_symbols(conn: sqlite3.Connection) -> list[str]:
    """Snapshot symbols answering step 4 ("¿Cayó por causas externas?") at default thresholds.

    The one selection the follow-up sources (eps_revisions, dataroma_holdings) share, so the
    step-4 rule is evaluated in this module only.
    """
    params = resolve_params(None)
    return [
        row["symbol"] for row in load_snapshot(conn)
        if group_verdict(fall_items(row, params, row_metrics(row, {}, None)))["ok"]
    ]


def evaluate_row(row: dict, params: dict, context: dict) -> dict:
    """One response row: the metrics the page prints, its five groups and its star count."""
    symbol = row["symbol"]
    risk = context["risk"].get(symbol)
    revisions = context["revisions"].get(symbol)
    dataroma = context["dataroma"].get(symbol, _empty_dataroma())
    dataroma = {**dataroma, **context["holdings"].get(symbol, _empty_holdings()),
                "insiderCluster": dataroma["insiders"] >= params["ins"]}
    dataroma["belowExpertsPrice"] = _below_experts_price(row.get("close"),
                                                         dataroma["avgHoldPrice"])
    metrics = row_metrics(row, context["sectorPe"], context["aaa"])
    groups = build_groups(row, params, metrics, dataroma, risk, revisions)
    graham = None if metrics["grahamValue"] is None else {
        "value": metrics["grahamValue"], "mos": metrics["mos"],
        "formula": {"eps": row.get("eps_ttm"), "g": metrics["grahamGrowth"], "y": context["aaa"]},
    }
    return {
        "ticker": row["symbol"], "name": row.get("name"), "sector": row.get("sector"),
        "stars": sum(1 for group_id in GROUP_IDS if groups[group_id]["ok"]), "groups": groups,
        "price": row.get("close"), "high52": row.get("price_52_week_high"),
        "dropPct": metrics["dropPct"], "eps": row.get("eps_ttm"),
        "growthPct": row.get("eps_growth_pct"), "graham": graham, "roic": row.get("roic"),
        "pe": metrics["pe"], "sectorPe": metrics["sectorPe"], "fcfYield": metrics["fcfYield"],
        "rsi": row.get("rsi"), "macd": row.get("macd"), "macdSignal": row.get("macd_signal"),
        "sma50": row.get("sma50"), "sma200": row.get("sma200"),
        "aboveSma50": metrics["aboveSma50"], "belowSma200": metrics["belowSma200"],
        "risk": risk, "revisions": revisions,
        "analysts": analysts_block(row, metrics), "dataroma": dataroma,
        "_passes": _step_passes(row, groups),
    }


def _step_passes(row: dict, groups: dict) -> dict[int, bool]:
    """Whether each of the six steps is answered: step 1 is "gana dinero", 2-6 are the groups."""
    passes = {1: bool(row.get("eps_ttm") is not None and row["eps_ttm"] > 0)}
    for number, group_id in STEPS[1:]:
        passes[number] = bool(groups[group_id]["ok"])
    return passes


# --- the response ---------------------------------------------------------------------------


def resolve_params(params: dict | None) -> dict:
    """Fill the S8 defaults and coerce the numeric parameters (the CLI receives them as JSON)."""
    merged = {**PARAM_DEFAULTS, **{k: v for k, v in (params or {}).items() if v is not None}}
    for key, default in PARAM_DEFAULTS.items():
        if key == "require":
            continue
        merged[key] = type(default)(merged[key])
    return merged


def required_steps(params: dict) -> set[int]:
    """The step numbers the caller marked "Exigir" ("1,4" or [1, 4])."""
    raw = params["require"]
    parts = raw if isinstance(raw, (list, tuple)) else str(raw).split(",")
    return {int(part) for part in parts if str(part).strip().isdigit()}


def run_steps(payloads: Sequence[dict], required: set[int]) -> tuple[list[dict], list[dict]]:
    """Walk the six steps in order, narrowing the set at each required one.

    ``remaining`` is the running count the page shows as "quedan N": it drops only at the
    steps the caller marked as required; a step that only adds a star leaves it unchanged.
    """
    current = list(payloads)
    steps: list[dict] = []
    for number, step_id in STEPS:
        if number in required:
            current = [row for row in current if row["_passes"][number]]
        steps.append({"n": number, "id": step_id, "required": number in required,
                      "remaining": len(current)})
    return steps, current


def build_response(conn: sqlite3.Connection, params: dict | None = None) -> dict:
    """Screen the universe and return exactly the S8 payload (read-only; writes nothing)."""
    resolved = resolve_params(params)
    rows = load_snapshot(conn, include_etf=bool(resolved["etf"]))
    if not rows:
        raise ScreenDataMissing("no TradingView scanner snapshot yet; sync 'tradingview_scanner'")
    aaa_value, aaa_as_of = load_aaa_yield(conn)
    context = {
        "sectorPe": sector_median_pe(rows), "dataroma": load_dataroma(conn), "aaa": aaa_value,
        "risk": load_risk(conn), "revisions": load_revisions(conn),
        "holdings": load_holdings(conn),
    }
    payloads = [evaluate_row(row, resolved, context) for row in rows]
    steps, kept = run_steps(payloads, required_steps(resolved))
    kept.sort(key=lambda row: (-row["stars"], -(_margin(row))))
    histogram = {str(stars): sum(1 for row in kept if row["stars"] == stars) for stars in range(5, -1, -1)}
    return {
        "asOf": max((row.get("fetched_at") or "") for row in rows) or None,
        "scannerUpdateMode": next((row.get("update_mode") for row in rows if row.get("update_mode")), None),
        "aaaYield": {"value": aaa_value, "asOf": aaa_as_of},
        "universe": len(rows), "steps": steps, "resultCount": len(kept),
        "starHistogram": histogram,
        "rows": [{k: v for k, v in row.items() if k != "_passes"} for row in kept[:MAX_ROWS]],
    }


def _margin(row: dict) -> float:
    """The Graham margin a row is sorted by; rows without one sort last."""
    graham = row.get("graham")
    if not graham or graham.get("mos") is None:
        return -1e9
    return float(graham["mos"])


# --- reads ------------------------------------------------------------------------------------


def load_snapshot(conn: sqlite3.Connection, include_etf: bool = False) -> list[dict]:
    """The scanned instruments of the active Racional universe (ETFs only when asked for)."""
    asset_types = ("EQUITY", "ETF") if include_etf else ("EQUITY",)
    placeholders = ", ".join("?" for _ in asset_types)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT s.* FROM stock_screen_snapshot s "
        "JOIN stocks_origin o ON o.normalized_symbol = s.symbol "
        "WHERE o.source_code = 'racional_gsheet' AND o.is_active = 1 "
        f"AND o.asset_type IN ({placeholders}) GROUP BY s.symbol ORDER BY s.symbol",
        asset_types,
    ).fetchall()
    return [dict(row) for row in rows]


def load_aaa_yield(conn: sqlite3.Connection) -> tuple[float | None, str | None]:
    """The AAA corporate-bond yield (Graham's Y) and the date FRED published it."""
    row = conn.execute("SELECT value, observed_at FROM market_rate WHERE series_id = 'AAA'").fetchone()
    return (None, None) if row is None else (row[0], row[1])


def _empty_dataroma() -> dict:
    return {"superinvestors": 0, "holdPrice": None, "insiders": 0, "insiderCluster": False}


def _empty_holdings() -> dict:
    """What a symbol with no stock_superinvestor_holdings row reports (S15: nulls, not zeros)."""
    return {"holders": None, "holdersPrev": None, "maxPortfolioPct": None,
            "avgHoldPrice": None, "netActivity": None, "topHolders": []}


def _below_experts_price(price: float | None, avg_hold_price: float | None) -> bool | None:
    """Whether it trades under what the superinvestors paid on average (None without both)."""
    if price is None or avg_hold_price is None:
        return None
    return price < avg_hold_price


def _select(conn: sqlite3.Connection, sql: str) -> list[sqlite3.Row]:
    """Rows of an optional screening table; a database without it yet simply has no rows."""
    conn.row_factory = sqlite3.Row
    try:
        return conn.execute(sql).fetchall()
    except sqlite3.OperationalError:
        return []


def load_risk(conn: sqlite3.Connection) -> dict[str, dict]:
    """Per symbol: the three-year risk reading price_risk stored (migration 0016)."""
    return {
        row["symbol"]: {
            "sortino": row["sortino_3y"], "sharpe": row["sharpe_3y"],
            "downsideBeta": row["downside_beta_3y"], "maxDrawdown": row["max_drawdown_3y"],
            "recoveryDays": row["recovery_days"], "volatility": row["volatility_ann"],
            "asOf": row["as_of"],
        }
        for row in _select(conn, "SELECT * FROM stock_risk_metrics")
    }


def load_revisions(conn: sqlite3.Connection) -> dict[str, dict]:
    """Per symbol: the analysts' revisions, with the 30-day net (up - down) the engine judges."""
    revisions: dict[str, dict] = {}
    for row in _select(conn, "SELECT * FROM stock_eps_revisions"):
        up30, down30 = row["up_30d"], row["down_30d"]
        revisions[row["symbol"]] = {
            "up30": up30, "down30": down30,
            "net": None if up30 is None or down30 is None else int(up30) - int(down30),
            "up7": row["up_7d"], "down7": row["down_7d"],
        }
    return revisions


def load_holdings(conn: sqlite3.Connection) -> dict[str, dict]:
    """Per symbol: what the superinvestors hold (dataroma_holdings, S12); absent rows stay null."""
    holdings: dict[str, dict] = {}
    for row in _select(conn, "SELECT * FROM stock_superinvestor_holdings"):
        holdings[row["symbol"]] = {
            "holders": row["holders"], "holdersPrev": row["holders_prev"],
            "maxPortfolioPct": row["max_portfolio_pct"],
            "avgHoldPrice": row["avg_hold_price"], "netActivity": row["net_activity"],
            "topHolders": _json_or_none(row["top_holders"]) or [],
        }
    return holdings


def _json_or_none(text: str | None) -> Any:
    """The per-manager detail Dataroma stored as JSON; unparseable text is simply missing."""
    if not text:
        return None
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def load_dataroma(conn: sqlite3.Connection) -> dict[str, dict]:
    """Per symbol: the latest quarter's superinvestor buys and the recent distinct insiders."""
    by_symbol: dict[str, dict] = {}
    quarter_row = conn.execute("SELECT MAX(quarter) FROM recent_buys_q").fetchone()
    quarter = quarter_row[0] if quarter_row else None
    if quarter:
        for symbol, buys, hold_price in conn.execute(
            "SELECT normalized_symbol, buys_count, hold_price FROM recent_buys_q WHERE quarter = ?",
            (quarter,),
        ):
            entry = by_symbol.setdefault(symbol, _empty_dataroma())
            entry["superinvestors"] = int(buys or 0)
            entry["holdPrice"] = hold_price
    for symbol, insiders in conn.execute(
        "SELECT normalized_symbol, COUNT(DISTINCT reporting_name) FROM recent_buys_insider "
        "WHERE is_ten_pct_owner = 0 AND transaction_date >= date('now', ?) "
        "GROUP BY normalized_symbol",
        (f"-{INSIDER_WINDOW_DAYS} days",),
    ):
        by_symbol.setdefault(symbol, _empty_dataroma())["insiders"] = int(insiders or 0)
    return by_symbol


# --- CLI ----------------------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    """Return the CLI parser (--params JSON, --db path)."""
    parser = argparse.ArgumentParser(description="Screen the Racional universe for opportunities.")
    parser.add_argument("--params", default="{}", help='JSON of the S8 query parameters')
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="domain_model.sqlite path")
    return parser


def main(argv: list[str] | None = None) -> int:
    """Print the screening response as one JSON object; return the exit code."""
    args = build_parser().parse_args(argv)
    conn = initialize_db(args.db)
    try:
        response = build_response(conn, json.loads(args.params or "{}"))
    except ScreenDataMissing as exc:
        print(json.dumps({"error": str(exc), "code": "SCREEN_DATA_MISSING"}, ensure_ascii=False))
        return 1
    finally:
        conn.close()
    print(json.dumps(response, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
