#!/usr/bin/env python3
"""
fx_rates.py — USD exchange rates for the portfolio profile currencies.

Purpose:
    The portfolio summary totals every profile in USD, so each non-USD profile
    currency needs one rate: how many units of that currency buy 1 USD
    (`usd_to`). TradingView is the baseline source (AGENTS rule 17, anonymous
    quotes work) via the FX_IDC:USD<CUR> chart symbol; yfinance ("<CUR>=X") is
    the offline fallback. A currency neither source can price is reported under
    `unavailable` — never defaulted to 1.0 and never carried over from another
    symbol, because an invented rate silently falsifies the consolidated total.

Layer:
    Backend / Python Services

Usage Examples:
    python3 fx_rates.py --currencies CLP,EUR

Output (JSON on stdout):
    {
      "rates": {
        "USD": {"usd_to": 1.0,   "source": "identity",    "as_of": "2026-10-30T18:02:11+00:00"},
        "CLP": {"usd_to": 948.2, "source": "tradingview", "as_of": "2026-10-30T18:02:11+00:00"}
      },
      "unavailable": ["XYZ"]
    }

Key Functions (Index):
    - parse_currencies(raw) - split/normalize the --currencies argument
    - tradingview_rate(currency) - FX_IDC:USD<CUR> quote through tv_client
    - yfinance_rate(currency) - "<CUR>=X" fast_info fallback
    - fx_rates(currencies, tv_fetcher, yf_fetcher) - resolution with injected fetchers

Key Input Dependencies:
    - TradingView Desktop CDP on port 9222 via py_services/tv_client.py (optional)
    - yfinance (fallback)

Key Output Dependencies:
    - JSON on stdout; nothing is written to disk
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional

Fetcher = Callable[[str], Optional[float]]


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def parse_currencies(raw: str) -> list[str]:
    """Split a comma-separated --currencies value into upper-case codes."""
    return [part.strip().upper() for part in (raw or "").split(",") if part.strip()]


def _is_usable(rate: object) -> bool:
    return isinstance(rate, (int, float)) and not isinstance(rate, bool) \
        and math.isfinite(float(rate)) and float(rate) > 0


def tradingview_rate(currency: str) -> Optional[float]:
    """Read USD<CUR> from TradingView: switch the chart symbol, then quote it.

    `quote` reads whatever the active chart shows, so the symbol it reports back
    is verified before the price is trusted — a failed symbol switch must look
    like "no rate", not like another instrument's price.
    """
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from tv_client import tv_call, is_tv_running  # type: ignore[import]

    if not is_tv_running():
        return None

    pair = f"USD{currency.upper()}"
    switched = tv_call("chart", "symbol", f"FX_IDC:{pair}")
    if not isinstance(switched, dict) or not switched.get("success"):
        return None

    quote = tv_call("quote", f"FX_IDC:{pair}")
    if not isinstance(quote, dict) or not quote.get("success"):
        return None
    shown = str(quote.get("symbol") or "").upper().replace(":", "").replace(" ", "")
    if pair not in shown:
        return None
    price = quote.get("price")
    return float(price) if _is_usable(price) else None


def yfinance_rate(currency: str) -> Optional[float]:
    """Offline fallback: yfinance quotes USD→<CUR> as the "<CUR>=X" pair."""
    import yfinance as yf  # imported lazily: the TradingView path needs no network stack

    fast = yf.Ticker(f"{currency.upper()}=X").fast_info
    price = getattr(fast, "last_price", None)
    return float(price) if _is_usable(price) else None


def fx_rates(
    currencies: list[str],
    tv_fetcher: Fetcher = tradingview_rate,
    yf_fetcher: Fetcher = yfinance_rate,
) -> dict:
    """Resolve one USD rate per currency: TradingView, then yfinance, else unavailable.

    Args:
        currencies: Currency codes (case/space tolerant, deduplicated in order).
        tv_fetcher: Primary rate source (injected in tests).
        yf_fetcher: Fallback rate source (injected in tests).

    Returns:
        {"rates": {CUR: {"usd_to": float, "source": str, "as_of": iso}}, "unavailable": [CUR]}
    """
    rates: dict[str, dict] = {}
    unavailable: list[str] = []
    seen: list[str] = []
    for raw in currencies:
        code = str(raw).strip().upper()
        if code and code not in seen:
            seen.append(code)

    for code in seen:
        if code == "USD":
            rates[code] = {"usd_to": 1.0, "source": "identity", "as_of": _now_iso()}
            continue

        resolved: Optional[float] = None
        source = ""
        for fetcher, name in ((tv_fetcher, "tradingview"), (yf_fetcher, "yfinance")):
            try:
                candidate = fetcher(code)
            except Exception as exc:  # a dead CDP or a yfinance error is "no rate", not a crash
                print(f"WARNING: {name} rate for {code} failed: {exc}", file=sys.stderr)
                continue
            if _is_usable(candidate):
                resolved, source = float(candidate), name
                break

        if resolved is None:
            unavailable.append(code)
        else:
            rates[code] = {"usd_to": resolved, "source": source, "as_of": _now_iso()}

    return {"rates": rates, "unavailable": unavailable}


def main() -> None:
    parser = argparse.ArgumentParser(description="USD exchange rates for profile currencies.")
    parser.add_argument("--currencies", required=True, help="Comma-separated codes, e.g. CLP,EUR")
    args = parser.parse_args()
    print(json.dumps(fx_rates(parse_currencies(args.currencies)), indent=2))


if __name__ == "__main__":
    main()
