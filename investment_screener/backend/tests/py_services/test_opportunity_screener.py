"""test_opportunity_screener.py — behaviour tests for the opportunity screening engine (B1a, S3-S8).

Purpose:
    Covers ``opportunity_screener`` through its public interface (the pure valuation
    functions, ``build_response(conn, params)`` and the CLI) against a real migrated SQLite
    file: hand-checked Graham arithmetic, the five condition groups and their Spanish
    displays, the "No aplica" rule for Finance/Utilities, missing data, the risk/revisions
    step 5 (S11), the superinvestor holdings of step 6 (S12), the Dataroma join,
    the sequential step counts over the required steps, sorting, the ETF toggle and the
    200-row cap. No network and no real database.

Key Input Dependencies:
    - investment_screener/backend/schema/domain_model/*.sql (real migrator builds the tmp DB)
    - py_services/opportunity_screener.py (the engine under test)
"""
import json
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
PY_SERVICES = REPO_ROOT / "investment_screener/backend/py_services"
sys.path.insert(0, str(PY_SERVICES))

from domain_model.db_client import initialize_db  # noqa: E402
import opportunity_screener as engine  # noqa: E402

AAA = 6.03
#: A row that meets every group: cheap, quality, fallen, turning, bought by experts.
GOOD = dict(
    sector="Electronic Technology", close=75.0, price_52_week_high=100.0, sma50=70.0,
    sma200=90.0, rsi=30.0, macd=1.0, macd_signal=0.5, pe_ttm=7.5, eps_ttm=10.0,
    eps_growth_pct=12.0, book_value_per_share=30.0, roe=20.0, roa=9.0, roic=18.0,
    free_cash_flow=5_000_000_000.0, market_cap=50_000_000_000.0, debt_to_equity=0.4,
    peg=0.9, revenue_growth_pct=12.0, price_target_average=130.0,
    recommendation_buy=10, recommendation_hold=2, recommendation_sell=1, recommendation_total=20,
)
SNAPSHOT_COLUMNS = (
    "symbol", "tv_symbol", "name", "sector", "close", "price_52_week_high", "sma50", "sma200",
    "rsi", "macd", "macd_signal", "pe_ttm", "eps_ttm", "eps_growth_pct", "book_value_per_share",
    "roe", "roa", "roic", "free_cash_flow", "market_cap", "debt_to_equity", "peg",
    "revenue_growth_pct", "price_target_average", "recommendation_buy", "recommendation_hold",
    "recommendation_sell", "recommendation_total", "update_mode", "raw_row", "fetched_at",
)


@pytest.fixture
def conn(tmp_path) -> sqlite3.Connection:
    c = initialize_db(str(tmp_path / "domain_model.sqlite"))
    c.execute(
        "INSERT INTO market_rate (series_id, value, observed_at, fetched_at) "
        "VALUES ('AAA', ?, '2026-09-01', '2026-10-31T00:00:00+00:00')",
        (AAA,),
    )
    c.commit()
    yield c
    c.close()


def add_stock(conn: sqlite3.Connection, symbol: str, asset_type: str = "EQUITY",
              is_active: int = 1, snapshot: dict | None = None, **overrides) -> None:
    """Seed one stocks_origin row and (unless snapshot is False) its stock_screen_snapshot row."""
    conn.execute(
        "INSERT INTO stocks_origin (source_code, symbol, normalized_symbol, asset_type, is_active) "
        "VALUES ('racional_gsheet', ?, ?, ?, ?)",
        (symbol, symbol, asset_type, is_active),
    )
    if snapshot is not False:
        values = {**GOOD, **(snapshot or {}), **overrides}
        values.update(symbol=symbol, tv_symbol=f"NASDAQ:{symbol}",
                      name=values.get("name", f"{symbol} Inc."), update_mode="delayed_streaming_900",
                      raw_row="{}", fetched_at="2026-10-31T12:00:00+00:00")
        conn.execute(
            f"INSERT INTO stock_screen_snapshot ({', '.join(SNAPSHOT_COLUMNS)}) "
            f"VALUES ({', '.join('?' for _ in SNAPSHOT_COLUMNS)})",
            [values.get(column) for column in SNAPSHOT_COLUMNS],
        )
    conn.commit()


def add_quarter_buy(conn: sqlite3.Connection, symbol: str, buys: int, hold_price: float,
                    quarter: str = "2026Q3") -> None:
    conn.execute(
        "INSERT INTO recent_buys_q (quarter, symbol, normalized_symbol, buys_count, hold_price, "
        "first_seen_at, last_synced_at) VALUES (?, ?, ?, ?, ?, '2026-10-01', '2026-10-01')",
        (quarter, symbol, symbol, buys, hold_price),
    )
    conn.commit()


def add_risk(conn: sqlite3.Connection, symbol: str, sortino: float | None = 1.2,
             dbeta: float | None = 0.8, drawdown: float | None = -0.38,
             recovery: int | None = 214) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO stock_risk_metrics (symbol, sortino_3y, sharpe_3y, "
        "downside_beta_3y, max_drawdown_3y, recovery_days, volatility_ann, history_days, "
        "as_of, fetched_at) VALUES (?, ?, 0.9, ?, ?, ?, 0.31, 756, '2026-10-30', "
        "'2026-10-31T00:00:00+00:00')",
        (symbol, sortino, dbeta, drawdown, recovery),
    )
    conn.commit()


def add_revisions(conn: sqlite3.Connection, symbol: str, up30: int | None = 4,
                  down30: int | None = 1, up7: int | None = 1, down7: int | None = 0) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO stock_eps_revisions (symbol, up_7d, down_7d, up_30d, down_30d, "
        "period, fetched_at) VALUES (?, ?, ?, ?, ?, '0y', '2026-10-31T00:00:00+00:00')",
        (symbol, up7, down7, up30, down30),
    )
    conn.commit()


def add_holdings(conn: sqlite3.Connection, symbol: str, holders: int = 7,
                 holders_prev: int | None = 5, max_pct: float | None = 12.5,
                 avg_price: float | None = 80.5, net_activity: int | None = 3,
                 top_holders: str | None = '[{"manager": "Li Lu", "pct": 12.5, "activity": 1}]'
                 ) -> None:
    conn.execute(
        "INSERT OR REPLACE INTO stock_superinvestor_holdings (symbol, holders, holders_prev, "
        "max_portfolio_pct, avg_hold_price, net_activity, top_holders, fetched_at) "
        "VALUES (?, ?, ?, ?, ?, ?, ?, '2026-10-31T00:00:00+00:00')",
        (symbol, holders, holders_prev, max_pct, avg_price, net_activity, top_holders),
    )
    conn.commit()


def add_insider(conn: sqlite3.Connection, symbol: str, name: str, days_ago: int = 5,
                ten_pct: int = 0, shares: int = 100) -> None:
    conn.execute(
        "INSERT INTO recent_buys_insider (filing_at, symbol, normalized_symbol, reporting_name, "
        "transaction_date, shares, price, is_ten_pct_owner, first_seen_at, last_synced_at) "
        "VALUES (date('now', ?) || 'T10:00', ?, ?, ?, date('now', ?), ?, 10.0, ?, "
        "'2026-10-01', '2026-10-01')",
        (f"-{days_ago} days", symbol, symbol, name, f"-{days_ago} days", shares, ten_pct),
    )
    conn.commit()


def _row(response: dict, ticker: str) -> dict:
    return next(row for row in response["rows"] if row["ticker"] == ticker)


def _item(row: dict, group: str, key: str) -> dict:
    return next(item for item in row["groups"][group]["items"] if item["key"] == key)


# --- pure valuation functions (rule 19: this module owns the formulas) -------------------


def test_graham_value_matches_the_hand_checked_number():
    assert engine.graham_value(28.60, 13, 6.03) == pytest.approx(719.98, abs=0.01)


def test_graham_value_is_none_without_earnings_or_without_a_yield():
    assert engine.graham_value(0.0, 10, 6.03) is None
    assert engine.graham_value(-2.5, 10, 6.03) is None
    assert engine.graham_value(28.60, 13, None) is None
    assert engine.graham_value(28.60, None, 6.03) is None


def test_margin_of_safety_and_fcf_yield_and_drop():
    assert engine.margin_of_safety(100.0, 75.0) == pytest.approx(25.0)
    assert engine.margin_of_safety(100.0, 125.0) == pytest.approx(-25.0)
    assert engine.margin_of_safety(None, 75.0) is None
    assert engine.fcf_yield(5_000_000_000.0, 100_000_000_000.0) == pytest.approx(5.0)
    assert engine.fcf_yield(5_000_000_000.0, 0.0) is None
    assert engine.drop_pct(80.0, 100.0) == pytest.approx(-20.0)
    assert engine.drop_pct(80.0, None) is None


def test_growth_for_graham_is_capped_to_zero_fifteen():
    assert engine.graham_growth(13.0) == 13.0
    assert engine.graham_growth(76.4) == 15.0
    assert engine.graham_growth(-114.0) == 0.0
    assert engine.graham_growth(None) is None


def test_sector_median_pe_uses_only_positive_ratios():
    rows = [
        {"sector": "Tech", "pe_ttm": 10.0}, {"sector": "Tech", "pe_ttm": 30.0},
        {"sector": "Tech", "pe_ttm": -5.0}, {"sector": "Tech", "pe_ttm": None},
        {"sector": "Finance", "pe_ttm": 12.0},
    ]
    assert engine.sector_median_pe(rows) == {"Tech": 20.0, "Finance": 12.0}


# --- the response ------------------------------------------------------------------------


def test_a_five_star_row_reports_every_group_met_with_spanish_displays(conn):
    add_stock(conn, "GOOD")
    add_stock(conn, "PRICEY", pe_ttm=30.0)
    add_quarter_buy(conn, "GOOD", buys=2, hold_price=80.5)
    add_insider(conn, "GOOD", "Smith John")
    add_insider(conn, "GOOD", "Doe Jane")
    add_risk(conn, "GOOD")
    add_revisions(conn, "GOOD")

    response = engine.build_response(conn, {})

    row = _row(response, "GOOD")
    assert row["stars"] == 5
    assert all(row["groups"][g]["ok"] for g in ("calidad", "precio", "caida", "sana", "expertos"))
    assert row["dropPct"] == pytest.approx(-25.0)
    assert row["graham"]["value"] == pytest.approx(10 * (8.5 + 24) * 4.4 / AAA, abs=0.01)
    assert row["graham"]["formula"] == {"eps": 10.0, "g": 12.0, "y": AAA}
    assert row["sectorPe"] == pytest.approx(18.75)
    assert row["fcfYield"] == pytest.approx(10.0)
    assert row["analysts"] == {"buy": 17, "hold": 2, "sell": 1, "total": 20,
                               "targetPct": pytest.approx((130.0 / 75.0 - 1) * 100)}
    assert row["dataroma"]["superinvestors"] == 2 and row["dataroma"]["holdPrice"] == 80.5
    assert row["dataroma"]["insiders"] == 2 and row["dataroma"]["insiderCluster"] is True
    assert row["risk"] == {"sortino": 1.2, "sharpe": 0.9, "downsideBeta": 0.8,
                           "maxDrawdown": -0.38, "recoveryDays": 214, "volatility": 0.31,
                           "asOf": "2026-10-30"}
    assert row["revisions"] == {"up30": 4, "down30": 1, "net": 3, "up7": 1, "down7": 0}
    roic = _item(row, "calidad", "roic")
    assert roic["label"] == "Gana por cada $1 invertido (ROIC)"
    assert roic["display"] == "18,0 %" and roic["threshold"] == "≥ 15 %" and roic["ok"] is True
    assert _item(row, "precio", "mos")["display"].endswith(" %")
    assert response["aaaYield"] == {"value": AAA, "asOf": "2026-09-01"}
    assert response["scannerUpdateMode"] == "delayed_streaming_900"
    assert response["asOf"] == "2026-10-31T12:00:00+00:00"


def test_finance_and_utilities_are_not_penalised_for_roic_and_free_cash_flow(conn):
    add_stock(conn, "FIN", sector="Finance", roic=None, free_cash_flow=None)
    add_stock(conn, "UTIL", sector="Utilities", roic=None, free_cash_flow=None)
    add_stock(conn, "FINB", sector="Finance", pe_ttm=30.0)       # raises the Finance median P/E
    add_stock(conn, "UTILB", sector="Utilities", pe_ttm=30.0)    # raises the Utilities median P/E

    response = engine.build_response(conn, {"require": "1"})

    for ticker in ("FIN", "UTIL"):
        row = _row(response, ticker)
        assert _item(row, "calidad", "roic")["notApplicable"] is True
        assert _item(row, "calidad", "roic")["display"] == "No aplica"
        assert _item(row, "calidad", "fcf")["notApplicable"] is True
        assert _item(row, "precio", "fcfy")["notApplicable"] is True
        assert row["groups"]["calidad"]["ok"] is True
        assert row["groups"]["precio"]["ok"] is True


def test_missing_data_makes_the_item_unknown_and_the_group_unmet(conn):
    add_stock(conn, "MISS", roe=None)

    row = _row(engine.build_response(conn, {"require": "1"}), "MISS")

    item = _item(row, "calidad", "roe")
    assert item["ok"] is None and item["value"] is None
    assert item["display"] == "Datos insuficientes"
    assert row["groups"]["calidad"]["ok"] is False
    assert row["groups"]["calidad"]["notApplicable"] is False


def test_an_insider_cluster_needs_distinct_recent_non_ten_percent_names(conn):
    add_stock(conn, "OLD")
    add_insider(conn, "OLD", "Smith John", days_ago=120)
    add_insider(conn, "OLD", "Doe Jane", days_ago=100)
    add_stock(conn, "DUPE")
    add_insider(conn, "DUPE", "Smith John")
    add_insider(conn, "DUPE", "Smith John", shares=250)   # same person filing twice
    add_stock(conn, "TENPCT")
    add_insider(conn, "TENPCT", "Fund LP", ten_pct=1)
    add_insider(conn, "TENPCT", "Other LP", ten_pct=1)
    add_stock(conn, "CLUSTER")
    add_insider(conn, "CLUSTER", "Smith John")
    add_insider(conn, "CLUSTER", "Doe Jane")

    response = engine.build_response(conn, {"require": "1", "sup": 99})

    assert _row(response, "OLD")["dataroma"]["insiderCluster"] is False
    assert _row(response, "DUPE")["dataroma"]["insiderCluster"] is False
    assert _row(response, "TENPCT")["dataroma"]["insiderCluster"] is False
    assert _row(response, "CLUSTER")["dataroma"]["insiderCluster"] is True
    assert _row(response, "CLUSTER")["groups"]["expertos"]["ok"] is True
    assert _row(response, "DUPE")["groups"]["expertos"]["ok"] is False


def test_stars_count_only_the_groups_met(conn):
    add_stock(conn, "TWO", roe=1.0, roa=1.0, peg=5.0, price_target_average=10.0)

    row = _row(engine.build_response(conn, {"require": "1"}), "TWO")

    assert row["groups"]["caida"]["ok"] is True
    assert row["groups"]["calidad"]["ok"] is False
    assert row["groups"]["precio"]["ok"] is False
    assert row["groups"]["sana"]["ok"] is False
    assert row["stars"] == sum(1 for g in row["groups"].values() if g["ok"])


# --- step 5 "\u00bfEs una ca\u00edda sana?" (S11) -------------------------------------------------


def test_a_healthy_fall_needs_sortino_downside_beta_and_revisions_together(conn):
    add_stock(conn, "SANA")
    add_risk(conn, "SANA", sortino=1.2, dbeta=0.8)
    add_revisions(conn, "SANA", up30=4, down30=1)

    row = _row(engine.build_response(conn, {"require": "1"}), "SANA")

    assert row["groups"]["sana"]["ok"] is True
    sortino = _item(row, "sana", "sortino")
    assert sortino["label"] == "Rinde bien para el riesgo que corre (Sortino 3 a\u00f1os)"
    assert sortino["display"] == "1,20" and sortino["threshold"] == "\u2265 0,50"
    dbeta = _item(row, "sana", "dbeta")
    assert dbeta["label"] == "Cae menos que el mercado en d\u00edas malos (beta bajista)"
    assert dbeta["display"] == "0,80" and dbeta["threshold"] == "\u2264 1,20"
    revisions = _item(row, "sana", "rev")
    assert revisions["label"] == "Los analistas no bajan sus estimaciones (revisiones 30 d\u00edas)"
    assert revisions["value"] == 3 and revisions["display"] == "+3"


@pytest.mark.parametrize("risk,revisions", [
    ({"sortino": 0.2}, {}),            # pays too little for its risk
    ({"dbeta": 1.9}, {}),              # falls harder than the market on bad days
    ({}, {"up30": 1, "down30": 4}),    # the analysts are cutting their estimates
])
def test_a_fall_is_not_healthy_when_one_condition_fails(conn, risk, revisions):
    add_stock(conn, "BAD")
    add_risk(conn, "BAD", **risk)
    add_revisions(conn, "BAD", **revisions)

    row = _row(engine.build_response(conn, {"require": "1"}), "BAD")

    assert row["groups"]["sana"]["ok"] is False


def test_negative_net_revisions_fail_the_condition_and_show_their_sign(conn):
    add_stock(conn, "CUT")
    add_risk(conn, "CUT")
    add_revisions(conn, "CUT", up30=1, down30=4)

    row = _row(engine.build_response(conn, {"require": "1"}), "CUT")

    assert row["revisions"]["net"] == -3
    assert _item(row, "sana", "rev")["display"] == "-3"
    assert _item(row, "sana", "rev")["ok"] is False
    assert row["groups"]["sana"]["ok"] is False


def test_without_three_years_of_history_step_five_reports_insufficient_data(conn):
    add_stock(conn, "NEW")                     # no stock_risk_metrics, no stock_eps_revisions

    row = _row(engine.build_response(conn, {"require": "1"}), "NEW")

    assert row["risk"] is None and row["revisions"] is None
    for key in ("sortino", "dbeta", "rev", "drawdown"):
        item = _item(row, "sana", key)
        assert item["ok"] is None and item["display"] == "Datos insuficientes"
    assert row["groups"]["sana"]["ok"] is False


def test_the_worst_drawdown_is_informational_and_never_changes_the_stars(conn):
    add_stock(conn, "DEEP")
    add_risk(conn, "DEEP", sortino=0.1, dbeta=3.0, drawdown=-0.38, recovery=214)
    add_revisions(conn, "DEEP", up30=0, down30=9)

    row = _row(engine.build_response(conn, {"require": "1"}), "DEEP")

    drawdown = _item(row, "sana", "drawdown")
    assert drawdown["label"] == "Peor ca\u00edda en 3 a\u00f1os"
    assert drawdown["display"] == "\u221238 % \u00b7 se recuper\u00f3 en 214 d\u00edas"
    assert drawdown["ok"] is None and drawdown["informational"] is True
    assert row["groups"]["sana"]["ok"] is False      # the three conditions all failed
    assert row["stars"] == sum(1 for g in row["groups"].values() if g["ok"])


def test_an_instrument_still_under_water_says_so(conn):
    add_stock(conn, "UNDER")
    add_risk(conn, "UNDER", drawdown=-0.5, recovery=None)

    row = _row(engine.build_response(conn, {"require": "1"}), "UNDER")

    assert _item(row, "sana", "drawdown")["display"] == "\u221250 % \u00b7 a\u00fan no se recupera"


def test_the_thresholds_of_step_five_come_from_the_parameters(conn):
    add_stock(conn, "EDGE")
    add_risk(conn, "EDGE", sortino=0.4, dbeta=1.5)
    add_revisions(conn, "EDGE", up30=1, down30=3)

    strict = _row(engine.build_response(conn, {"require": "1"}), "EDGE")
    loose = _row(engine.build_response(
        conn, {"require": "1", "sortino": 0.3, "dbeta": 2.0, "rev": -5}), "EDGE")

    assert strict["groups"]["sana"]["ok"] is False
    assert loose["groups"]["sana"]["ok"] is True


def test_rsi_macd_and_the_fifty_day_average_stay_on_the_row_as_information(conn):
    add_stock(conn, "INFO", rsi=80.0, macd=0.1, macd_signal=0.9, sma50=90.0)
    add_risk(conn, "INFO")
    add_revisions(conn, "INFO")

    row = _row(engine.build_response(conn, {"require": "1"}), "INFO")

    assert (row["rsi"], row["macd"], row["macdSignal"], row["sma50"]) == (80.0, 0.1, 0.9, 90.0)
    assert row["aboveSma50"] is False
    assert row["groups"]["sana"]["ok"] is True       # technicals no longer earn or cost a star


# --- step 6 "\u00bfLo compran los expertos?" (S12) ----------------------------------------------


def test_the_superinvestor_holdings_enrich_the_row_without_changing_the_gate(conn):
    add_stock(conn, "HELD")
    add_holdings(conn, "HELD", holders=7, holders_prev=5, max_pct=12.5, avg_price=80.5,
                 net_activity=3)

    row = _row(engine.build_response(conn, {"require": "1"}), "HELD")

    assert row["dataroma"]["holders"] == 7
    assert row["dataroma"]["holdersPrev"] == 5
    assert row["dataroma"]["maxPortfolioPct"] == 12.5
    assert row["dataroma"]["avgHoldPrice"] == 80.5
    assert row["dataroma"]["netActivity"] == 3
    assert row["dataroma"]["topHolders"] == [{"manager": "Li Lu", "pct": 12.5, "activity": 1}]
    assert row["dataroma"]["belowExpertsPrice"] is True       # it trades at 75 vs 80,5
    assert row["groups"]["expertos"]["ok"] is False           # nobody bought this quarter


def test_a_symbol_without_holdings_reports_null_fields(conn):
    add_stock(conn, "NONE")

    row = _row(engine.build_response(conn, {"require": "1"}), "NONE")

    for key in ("holders", "holdersPrev", "maxPortfolioPct", "avgHoldPrice", "netActivity",
                "topHolders", "belowExpertsPrice"):
        assert row["dataroma"][key] is None, key


def test_above_the_experts_price_is_reported_as_false(conn):
    add_stock(conn, "EXPENSIVE")
    add_holdings(conn, "EXPENSIVE", avg_price=50.0)

    row = _row(engine.build_response(conn, {"require": "1"}), "EXPENSIVE")

    assert row["dataroma"]["belowExpertsPrice"] is False


def test_the_holdings_items_are_informational_and_never_change_the_stars(conn):
    add_stock(conn, "HELD")
    add_holdings(conn, "HELD")
    add_quarter_buy(conn, "HELD", buys=2, hold_price=80.5)

    row = _row(engine.build_response(conn, {"require": "1"}), "HELD")

    labels = {entry["key"]: entry["label"] for entry in row["groups"]["expertos"]["items"]}
    assert labels["holders"] == "Grandes inversores que la tienen"
    assert labels["maxPortfolioPct"] == "Peso m\u00e1ximo en su cartera (convicci\u00f3n)"
    assert labels["expertsPrice"] == "Precio vs. el de compra de los expertos"
    for key in ("holders", "maxPortfolioPct", "expertsPrice"):
        entry = _item(row, "expertos", key)
        assert entry["ok"] is None and entry["informational"] is True
    assert row["groups"]["expertos"]["ok"] is True            # the gate is the buys, unchanged
    assert row["stars"] == sum(1 for g in row["groups"].values() if g["ok"])


def test_required_steps_filter_the_rows_and_the_counts_are_sequential(conn):
    add_stock(conn, "GOOD")
    add_stock(conn, "PRICEY", pe_ttm=30.0)
    add_stock(conn, "LOSS", eps_ttm=-1.0, pe_ttm=None)
    add_stock(conn, "NOFALL", close=99.0, sma200=50.0)
    add_quarter_buy(conn, "GOOD", buys=2, hold_price=80.5)

    response = engine.build_response(conn, {"require": "1,4"})

    assert response["universe"] == 4
    steps = {step["n"]: step for step in response["steps"]}
    assert [steps[n]["id"] for n in range(1, 7)] == [
        "gana", "calidad", "precio", "caida", "sana", "expertos"]
    assert steps[1]["required"] is True and steps[4]["required"] is True
    assert steps[2]["required"] is False
    assert steps[1]["remaining"] == 3            # LOSS has no earnings
    # "quedan N" is a running count: a step that is not required leaves the set as it is
    assert steps[2]["remaining"] == steps[3]["remaining"] == 3
    assert steps[4]["remaining"] == 2            # NOFALL never fell
    assert steps[5]["remaining"] == steps[6]["remaining"] == 2
    assert {row["ticker"] for row in response["rows"]} == {"GOOD", "PRICEY"}
    assert response["resultCount"] == 2
    assert sum(response["starHistogram"].values()) == 2


def test_rows_are_sorted_by_stars_then_by_graham_margin(conn):
    add_stock(conn, "ALPHA", eps_growth_pct=5.0)               # 5 stars, smaller Graham margin
    add_stock(conn, "BETA")                                    # 5 stars, bigger Graham margin
    add_stock(conn, "GAMMA", roe=1.0)                          # fewer stars
    for index in range(4):                                     # lift the sector median P/E
        add_stock(conn, f"EXP{index}", pe_ttm=30.0, eps_ttm=-1.0)
    for ticker in ("ALPHA", "BETA", "GAMMA"):
        add_quarter_buy(conn, ticker, buys=1, hold_price=50.0)

    rows = engine.build_response(conn, {"require": "1"})["rows"]

    assert [row["ticker"] for row in rows[:3]] == ["BETA", "ALPHA", "GAMMA"]


def test_etfs_join_the_universe_only_when_the_toggle_is_on(conn):
    add_stock(conn, "GOOD")
    add_stock(conn, "SPY", asset_type="ETF")

    without = engine.build_response(conn, {"require": "1"})
    with_etf = engine.build_response(conn, {"require": "1", "etf": 1})

    assert {row["ticker"] for row in without["rows"]} == {"GOOD"}
    assert without["universe"] == 1
    assert {row["ticker"] for row in with_etf["rows"]} == {"GOOD", "SPY"}


def test_at_most_two_hundred_rows_are_returned(conn):
    for index in range(205):
        add_stock(conn, f"T{index:03d}")

    response = engine.build_response(conn, {"require": "1"})

    assert response["universe"] == 205
    assert response["resultCount"] == 205
    assert len(response["rows"]) == 200


def test_without_a_snapshot_the_engine_reports_screen_data_missing(conn):
    add_stock(conn, "GOOD", snapshot=False)

    with pytest.raises(engine.ScreenDataMissing):
        engine.build_response(conn, {})


def test_cli_prints_the_response_json(tmp_path, conn):
    add_stock(conn, "GOOD")
    db_path = str(tmp_path / "domain_model.sqlite")

    completed = subprocess.run(
        [sys.executable, str(PY_SERVICES / "opportunity_screener.py"),
         "--params", json.dumps({"require": "1"}), "--db", db_path],
        capture_output=True, text=True, timeout=120,
    )

    assert completed.returncode == 0, completed.stderr
    payload = json.loads(completed.stdout)
    assert payload["rows"][0]["ticker"] == "GOOD"
    assert payload["universe"] == 1


def test_cli_reports_screen_data_missing_with_exit_code_one(tmp_path, conn):
    db_path = str(tmp_path / "domain_model.sqlite")

    completed = subprocess.run(
        [sys.executable, str(PY_SERVICES / "opportunity_screener.py"), "--db", db_path],
        capture_output=True, text=True, timeout=120,
    )

    assert completed.returncode == 1
    assert json.loads(completed.stdout)["code"] == "SCREEN_DATA_MISSING"
