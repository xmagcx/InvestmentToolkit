"""test_portfolio_optimizer.py — behaviour tests for the portfolio risk / optimization service.

Purpose:
    Covers ``portfolio_optimizer`` through its public functions and CLI over a real migrated
    temporary SQLite file: the ``--risk`` reading (shape, risk contribution, the estimated
    volatility fallback), the three ``--optimize`` objectives, the exclusion warning for a
    symbol without history, the 25 USD order threshold, and that the database is never written.
    No network: the downloader is injected.

Layer:
    Backend / Tests / Python Services

Key Input Dependencies:
    - investment_screener/backend/schema/domain_model/*.sql (real migrator builds the tmp DB)
    - portfolio_optimizer (the service under test)
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

REPO_ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(REPO_ROOT / "investment_screener/backend/py_services"))

import portfolio_optimizer as po  # noqa: E402
from domain_model.db_client import initialize_db  # noqa: E402

DAYS = 760
#: symbol -> (shares, price, daily vol of the synthetic closes, stored annual volatility)
HOLDINGS = {
    "AAA": (10, 100.0, 0.030, 0.48),
    "BBB": (20, 50.0, 0.015, 0.24),
    "CCC": (40, 25.0, 0.010, 0.16),
    "DDD": (5, 200.0, 0.020, 0.32),
    "SFD": (10, 30.0, 0.020, None),  # no stored volatility, no history
}


def closes(daily_vol: float, seed: int, days: int = DAYS) -> pd.Series:
    rng = np.random.default_rng(seed)
    values = 100 * np.cumprod(1 + rng.normal(0.0005, daily_vol, days))
    return pd.Series(values, index=pd.bdate_range("2023-01-02", periods=days))


@pytest.fixture
def db(tmp_path) -> str:
    path = str(tmp_path / "domain_model.sqlite")
    conn = initialize_db(path)
    conn.execute("INSERT INTO account (account_id, account_name, base_currency) VALUES ('A1', 'TFSA', 'USD')")
    rows = dict(HOLDINGS)
    rows["CASH_USD"] = (124.38, 1.0, 0, None)
    for symbol, (shares, price, _vol, stored) in rows.items():
        asset_class = "CASH" if symbol == "CASH_USD" else "EQUITY"
        conn.execute("INSERT INTO investment (investment_id, symbol, asset_class, updated_at) "
                     "VALUES (?, ?, ?, '2026-11-03T20:00:00Z')",
                     (symbol, symbol, asset_class))
        conn.execute("INSERT INTO investment_price (investment_id, price, currency, fetched_at) "
                     "VALUES (?, ?, 'USD', '2026-11-03T20:00:00Z')", (symbol, price))
        conn.execute("INSERT INTO account_investment (account_investment_id, account_id, investment_id, "
                     "quantity, currency, last_synced_at) VALUES (?, 'A1', ?, ?, 'USD', '2026-11-03T20:00:00Z')",
                     (f"A1:{symbol}", symbol, shares))
        if stored is not None:
            conn.execute("INSERT INTO stock_risk_metrics (symbol, sortino_3y, sharpe_3y, downside_beta_3y, "
                         "max_drawdown_3y, volatility_ann, history_days, as_of) "
                         "VALUES (?, 1.5, 1.0, 1.2, ?, ?, 760, '2026-11-03')", (symbol, -stored, stored))
    conn.commit()
    conn.close()
    return path


class StubDownloader:
    def __init__(self, short: dict[str, int] | None = None):
        self.short = short or {"SFD": 100}
        self.calls: list[list[str]] = []

    def __call__(self, symbols, period: str) -> pd.DataFrame:
        self.calls.append(list(symbols))
        out = {}
        for i, symbol in enumerate(symbols):
            vol = HOLDINGS[symbol][2]
            out[symbol] = closes(vol, seed=i + 1, days=self.short.get(symbol, DAYS))
        return pd.DataFrame(out)


def test_risk_shape_and_contribution(db):
    report = po.risk_report(db)
    rows = {r["ticker"]: r for r in report["rows"]}
    assert set(rows) == set(HOLDINGS)  # cash excluded
    assert set(rows["AAA"]) == {"ticker", "market_value", "weight_pct", "volatility_ann", "max_drawdown_3y",
                                "sharpe_3y", "sortino_3y", "downside_beta_3y", "risk_contribution_pct",
                                "estimated"}
    assert rows["AAA"]["market_value"] == 1000.0
    assert rows["AAA"]["estimated"] is False
    assert sum(r["risk_contribution_pct"] for r in rows.values()) == pytest.approx(100, abs=0.05)
    p = report["portfolio"]
    assert p["market_value_usd"] == 4300.0  # 4 x 1000 + SFD 300, cash apart
    assert p["cash_usd"] == 124.38
    assert p["holdings_total"] == 5 and p["holdings_with_history"] == 4
    assert report["as_of"]


def test_weight_pct_is_of_the_whole_portfolio_cash_included(db):
    """Rule 15 and computeWeightsMap: the denominator is holdings + cash, so this page's
    weight never disagrees with the Actual % column the rest of the app already shows."""
    report = po.risk_report(db)
    rows = {r["ticker"]: r for r in report["rows"]}
    base = 4300.0 + 124.38
    assert rows["AAA"]["weight_pct"] == pytest.approx(100 * 1000.0 / base, abs=0.01)
    assert sum(r["weight_pct"] for r in rows.values()) == pytest.approx(100 * 4300.0 / base, abs=0.05)


def test_optimize_weights_share_the_risk_report_denominator(db):
    """current_pct must equal the weight_pct of --risk, or the table and the suggestion disagree."""
    risk = {r["ticker"]: r["weight_pct"] for r in po.risk_report(db)["rows"]}
    result = po.optimize(db, "min_volatility", downloader=StubDownloader())
    for w in result["weights"]:
        assert w["current_pct"] == pytest.approx(risk[w["ticker"]], abs=0.01)
    cash_pct = 100 * 124.38 / (4300.0 + 124.38)
    assert sum(w["target_pct"] for w in result["weights"]) == pytest.approx(100 - cash_pct, abs=0.1)


def test_missing_volatility_uses_median_of_others_and_is_flagged(db):
    rows = {r["ticker"]: r for r in po.risk_report(db)["rows"]}
    assert rows["SFD"]["estimated"] is True
    assert rows["SFD"]["volatility_ann"] == pytest.approx(0.28)  # median of .48 .24 .16 .32
    assert rows["SFD"]["sharpe_3y"] is None
    report = po.risk_report(db)
    assert report["medians"]["volatility_ann"] == pytest.approx(0.28)
    assert report["medians"]["max_drawdown_3y"] == pytest.approx(-0.28)
    naive = sum(r["weight_pct"] / 100 * r["volatility_ann"] for r in report["rows"])
    assert report["portfolio"]["volatility_ann"] == pytest.approx(naive, abs=1e-3)


@pytest.mark.parametrize("objective", ["min_volatility", "risk_parity", "max_sharpe"])
def test_each_objective_returns_weights_orders_and_effect(db, objective):
    result = po.optimize(db, objective, downloader=StubDownloader())
    assert result["objective"] == objective
    weights = {w["ticker"]: w for w in result["weights"]}
    assert set(weights) == set(HOLDINGS)
    assert weights["SFD"]["target_pct"] == weights["SFD"]["current_pct"]  # excluded: stays put
    assert sum(w["target_pct"] for w in weights.values()) == pytest.approx(
        sum(w["current_pct"] for w in weights.values()), abs=0.1)
    assert any("SFD" in w and "excluida" in w for w in result["warnings"])
    assert {"volatility_before", "volatility_after", "top_risk_before", "top_risk_after"} <= set(result["effect"])
    assert result["effect"]["volatility_after"] > 0
    sells = [i for i, o in enumerate(result["orders"]) if o["action"] == "SELL"]
    buys = [i for i, o in enumerate(result["orders"]) if o["action"] == "BUY"]
    assert not sells or not buys or max(sells) < min(buys)
    for order in result["orders"]:
        assert order["ticker"] != "SFD" and order["amount_usd"] >= 25
        assert order["amount_usd"] == pytest.approx(order["shares"] * HOLDINGS[order["ticker"]][1], abs=0.5)
    flow = sum(o["amount_usd"] * (1 if o["action"] == "SELL" else -1) for o in result["orders"])
    assert result["cash_after_usd"] == pytest.approx(124.38 + flow, abs=0.01)


def test_min_volatility_lowers_volatility_and_favours_the_calm_stock(db):
    result = po.optimize(db, "min_volatility", downloader=StubDownloader())
    assert result["effect"]["volatility_after"] < result["effect"]["volatility_before"]
    weights = {w["ticker"]: w["target_pct"] for w in result["weights"]}
    assert weights["CCC"] > weights["AAA"]
    assert any(o["action"] == "SELL" and o["ticker"] == "AAA" for o in result["orders"])


def test_orders_under_the_threshold_are_skipped(db):
    result = po.optimize(db, "min_volatility", downloader=StubDownloader(), min_order_usd=100000)
    assert result["orders"] == []
    assert result["cash_after_usd"] == 124.38


def test_downloader_receives_only_holdings_and_three_years(db):
    seen = []

    def spy(symbols, period):
        seen.append((list(symbols), period))
        return StubDownloader()(symbols, period)

    po.optimize(db, "risk_parity", downloader=spy)
    assert seen[0][1] == "3y" and set(seen[0][0]) == set(HOLDINGS)


def test_unknown_objective_is_rejected(db):
    with pytest.raises(ValueError, match="objective"):
        po.optimize(db, "get_rich", downloader=StubDownloader())


def test_cli_prints_json_and_never_writes(db, capsys):
    before = Path(db).read_bytes()
    assert po.main(["--db", db, "--risk", "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["rows"]
    assert Path(db).read_bytes() == before


def test_cli_rejects_unknown_objective(db, capsys):
    with pytest.raises(SystemExit) as exc:
        po.main(["--db", db, "--optimize", "get_rich", "--json"])
    assert exc.value.code == 2
