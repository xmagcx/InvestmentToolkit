/**
 * @vitest-environment jsdom
 * Purpose: the right panel shows Riesgo first with three verdict figures and a criterion footnote, keeps the extra
 *     risk inside a collapsible, and Valoración is a calm empty state with "Analizar X" until a fair value exists.
 * Layer: Frontend integration. Usage: vitest run tests/portfolio/RiskPanel.test.tsx.
 * Key Input Dependencies: components/portfolio/RiskPanel; PortfolioRisk fixture shaped like GET /api/portfolio/risk.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { RiskPanel } from '../../src/components/portfolio/RiskPanel';
import type { TableRow } from '../../src/components/positions/columns';
import type { PortfolioRisk, RecommendationRecord } from '../../src/services/api';

afterEach(cleanup);

const mk = (ticker: string, dd: number): PortfolioRisk['rows'][number] => ({
    ticker, market_value: 100, weight_pct: 5, volatility_ann: 0.3, max_drawdown_3y: dd, sharpe_3y: 1, sortino_3y: 1.6,
    downside_beta_3y: 2.2, risk_contribution_pct: 5, estimated: false,
});
const app = { ...mk('APP', -0.6885), weight_pct: 20.76, volatility_ann: 0.7677, risk_contribution_pct: 36.5 };
const risk: PortfolioRisk = {
    as_of: '2026-11-03',
    portfolio: { volatility_ann: 0.436, holdings_with_history: 12, holdings_total: 13, market_value_usd: 3908.6, cash_usd: 124.38 },
    medians: { volatility_ann: 0.352, max_drawdown_3y: -0.492 },
    rows: [app, mk('VITL', -0.844), mk('NVO', -0.747), mk('SFM', -0.733), mk('AXP', -0.2)],
};
const row = { ticker: 'APP', name: 'Applovin', held: true, shares: 3.4015, averageCost: 283.51, currentPrice: 238.51 } as TableRow;

it('opens on Riesgo with three figures, verdict chips, bases and the criterion footnote', () => {
    render(<RiskPanel row={row} riskRow={app} risk={risk} hidden={false} onAnalyze={() => undefined} />);
    expect(screen.getByRole('tab', { name: 'Riesgo' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('76,8 %')).toBeTruthy();
    expect(screen.getAllByText('Alto')).toHaveLength(3);
    expect(screen.getByText(/2,2× la mediana de tu cartera \(35,2 %\)/)).toBeTruthy();
    expect(screen.getByText(/Alto, medio o bajo se mide contra tus otras 11 posiciones con historia, no contra el mercado/)).toBeTruthy();
});

it('keeps Sortino, downside beta, the other big drawdowns and the naive-volatility caveat in the collapsible', () => {
    const { container } = render(<RiskPanel row={row} riskRow={app} risk={risk} hidden={false} onAnalyze={() => undefined} />);
    const details = container.querySelector('details')!;
    expect(details.textContent).toContain('Sortino 1,60 y beta bajista 2,20');
    expect(details.textContent).toContain('VITL −84,4 %, NVO −74,7 %, SFM −73,3 %');
    expect(details.textContent).toContain('sin correlaciones');
});

it('Valoración is an empty state with Analizar <TICKER> when nothing is saved, and the button navigates', () => {
    const onAnalyze = vi.fn();
    render(<RiskPanel row={row} riskRow={app} risk={risk} hidden={false} onAnalyze={onAnalyze} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Valoración' }));
    expect(screen.getByText(/nunca se ha analizado/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Analizar APP' }));
    expect(onAnalyze).toHaveBeenCalled();
});

it('Valoración shows the saved range, fair value, upside and reward:risk when a recommendation has a fair value', () => {
    const rec = {
        ticker: 'APP', action: 'MAINTAIN', fair_value: 300, price: 238.51, scenarios: { bear: 100, base: 280, bull: 500 },
        risk_reward: { premium_pct: -20, reward_risk: 2.4, verdict: 'FAVOURABLE', no_modelled_downside: false, reduce_candidate: false,
            alignment: { status: 'ALIGNED', note: '' } },
    } as unknown as RecommendationRecord;
    render(<RiskPanel row={row} riskRow={app} risk={risk} rec={rec} hidden={false} onAnalyze={() => undefined} />);
    fireEvent.click(screen.getByRole('tab', { name: 'Valoración' }));
    expect(screen.queryByText(/nunca se ha analizado/)).toBeNull();
    expect(screen.getByText('2.4×')).toBeTruthy();
    expect(screen.getByText('+26%')).toBeTruthy();
});

it('says so plainly when there is no risk data for the ticker', () => {
    render(<RiskPanel row={{ ...row, held: false }} risk={null} hidden={false} onAnalyze={() => undefined} />);
    expect(screen.getByText(/Aún no hay datos de riesgo para APP/)).toBeTruthy();
});
