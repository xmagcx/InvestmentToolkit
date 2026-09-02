/**
 * PortfolioMaintainerMath.ts — pure weighted-average-cost + cash arithmetic.
 *
 * Purpose:
 *   Pure, side-effect-free helpers for the portfolio maintainer's buy/sell math
 *   (REQ-1 weighted average cost, REQ-2 sell keeps avg + oversell rejection,
 *   REQ-3 cash buy-deduct/sell-add + overspend rejection). Keeping these pure
 *   makes them trivially unit-testable and keeps the single `db.transaction()`
 *   writes in `PortfolioMaintainerService` free of inline arithmetic.
 *
 *   All amounts are in the account's base currency — currency isolation is a
 *   caller concern (the position/cash rows carry the account's `base_currency`),
 *   never converted here.
 *
 * Layer:
 *   Backend / Services / Domain Math (pure functions)
 *
 * Key Functions:
 *   - computeFirstBuyAvg / computeSubsequentBuyAvg - weighted-average cost
 *   - computeBuyCash / computeSellCash - cash buy-deduct / sell-add
 *   - computeSellQuantity / computeSellAvg - sell qty reduction + invariant avg
 *
 * Sentinel results:
 *   RESULT_OVERSPENT / RESULT_OVERSOLD — returned (not thrown) by the numeric
 *   helpers so callers can decide how to surface the reject (the service throws
 *   `PortfolioMaintainerError` with the spec'd 400 message).
 */
export const RESULT_OVERSPENT = Number.MIN_SAFE_INTEGER;
export const RESULT_OVERSOLD = Number.MIN_SAFE_INTEGER;

/** REQ-1 first buy: avg = (qty*price + commission)/qty. */
export function computeFirstBuyAvg(qty: number, price: number, commission = 0): number {
    return (qty * price + commission) / qty;
}

/** REQ-1 subsequent buy: newAvg = (oldQty*oldAvg + qty*price + commission)/newQty. */
export function computeSubsequentBuyAvg(
    oldQty: number,
    oldAvg: number,
    qty: number,
    price: number,
    commission = 0
): number {
    const newQty = oldQty + qty;
    return (oldQty * oldAvg + qty * price + commission) / newQty;
}

/** REQ-3 buy: cash deducts qty*price + commission; reject (RESULT_OVERSPENT) if it would go negative. */
export function computeBuyCash(oldCash: number, qty: number, price: number, commission = 0): number {
    const cost = qty * price + commission;
    const newCash = oldCash - cost;
    return newCash < 0 ? RESULT_OVERSPENT : newCash;
}

/** REQ-2 sell quantity: newQty = oldQty - qty; reject (RESULT_OVERSOLD) if qty > oldQty. */
export function computeSellQuantity(oldQty: number, qty: number): number {
    if (qty > oldQty) return RESULT_OVERSOLD;
    return oldQty - qty;
}

/** REQ-2 sell keeps avg cost UNCHANGED. */
export function computeSellAvg(oldAvg: number): number {
    return oldAvg;
}

/** REQ-3 sell: cash adds qty*price - commission. */
export function computeSellCash(oldCash: number, qty: number, price: number, commission = 0): number {
    return oldCash + qty * price - commission;
}
