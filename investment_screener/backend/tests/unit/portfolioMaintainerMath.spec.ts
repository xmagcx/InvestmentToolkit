/**
 * portfolioMaintainerMath.spec.ts — RED phase tests for the pure weighted-average
 * cost + cash arithmetic in `services/PortfolioMaintainerMath.ts`.
 *
 * These are the acceptance criteria for REQ-1 (weighted avg cost), REQ-2 (sell
 * keeps avg), REQ-3 (cash per account), and REQ-6 (currency-isolated cash math).
 * Pure functions, no DB, no mocks — the numbers come straight from the spec
 * scenarios (S1..S3 of REQ-1, S1..S3 of REQ-2/REQ-3, S3 of REQ-6).
 */
import { expect } from 'chai';
import {
    computeFirstBuyAvg,
    computeSubsequentBuyAvg,
    computeBuyCash,
    computeSellQuantity,
    computeSellCash,
    computeSellAvg,
    RESULT_OVERSOLD,
    RESULT_OVERSPENT,
} from '../../src/services/PortfolioMaintainerMath';

describe('PortfolioMaintainerMath (pure avg-cost + cash)', () => {
    describe('weighted average cost', () => {
        it('REQ-1 S1: first buy avg = (qty*price + commission)/qty → 55', () => {
            // qty=2, price=50, commission=10 → (2*50 + 10)/2 = 110/2 = 55
            expect(computeFirstBuyAvg(2, 50, 10)).to.equal(55);
        });

        it('REQ-1 S3: commission omitted defaults to 0 → first buy avg 25', () => {
            // qty=4, price=25, commission omitted (0) → (4*25 + 0)/4 = 25
            expect(computeFirstBuyAvg(4, 25, 0)).to.equal(25);
        });

        it('REQ-1 S2: subsequent buy weighted avg = (oldQty*oldAvg + qty*price + commission)/newQty → 56.67', () => {
            // old 2@55, buy 1@60, cc=0 → (2*55 + 1*60)/3 = 170/3 = 56.666…
            expect(computeSubsequentBuyAvg(2, 55, 1, 60, 0)).to.be.closeTo(56.67, 0.01);
        });

        it('REQ-1 S2 (triangulation): different inputs, commission included', () => {
            // old 10@20, buy 2@30, cc=10 → (10*20 + 2*30 + 10)/12 = 270/12 = 22.5
            expect(computeSubsequentBuyAvg(10, 20, 2, 30, 10)).to.equal(22.5);
        });
    });

    describe('cash math', () => {
        it('REQ-3 S1: buy deducts qty*price + commission → 1000 - 110 = 890', () => {
            expect(computeBuyCash(1000, 2, 50, 10)).to.equal(890);
        });

        it('REQ-3 S2: overspend rejected (buy exceeds cash)', () => {
            const r = computeBuyCash(50, 2, 50, 10); // need 110, have 50
            expect(r).to.equal(RESULT_OVERSPENT);
        });

        it('REQ-2 S1 / REQ-3 S3: sell adds qty*price - commission → 1000 + 115 = 1115', () => {
            // sell 4@30, cc=5 → proceeds 4*30 - 5 = 115
            expect(computeSellCash(1000, 4, 30, 5)).to.equal(1115);
        });

        it('REQ-6 S3: USD cash account sell has no FX conversion (currency isolation)', () => {
            // same math, currency is a caller concern; 5000 + 95 = 5095
            expect(computeSellCash(5000, 1, 100, 5)).to.equal(5095);
        });
    });

    describe('sell quantity', () => {
        it('REQ-2: partial sell reduces qty, avg unchanged', () => {
            expect(computeSellQuantity(10, 4)).to.equal(6);
            expect(computeSellAvg(20)).to.equal(20);
        });

        it('REQ-2: full exit (qty sold == held) → 0 (caller deletes the row)', () => {
            expect(computeSellQuantity(3, 3)).to.equal(0);
        });

        it('REQ-2 S2: oversell rejected', () => {
            expect(computeSellQuantity(5, 6)).to.equal(RESULT_OVERSOLD);
        });
    });
});
