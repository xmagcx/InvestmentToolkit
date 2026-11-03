/**
 * @vitest-environment jsdom
 * Purpose: "Mejorar la cartera" lists plain-language options, shows the order list from an optimize response,
 *     a loading state, the warnings, and the error path; it never executes anything.
 * Layer: Frontend integration. Usage: vitest run tests/portfolio/ImprovePanel.test.tsx.
 * Key Functions: OrderResult rendering, option click -> optimizePortfolio, loading, error.
 * Key Input Dependencies: components/portfolio/ImprovePanel; services/api mocked; fixture shaped like POST /api/portfolio/optimize.
 */
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ImprovePanel, OrderResult } from '../../src/components/portfolio/ImprovePanel';
import type { OptimizeResponse } from '../../src/services/api';

const optimizePortfolio = vi.fn();
vi.mock('../../src/services/api', async orig => ({ ...(await orig<object>()), optimizePortfolio: (o: string) => optimizePortfolio(o) }));

afterEach(() => { cleanup(); optimizePortfolio.mockReset(); });

const response: OptimizeResponse = {
    objective: 'risk_parity', as_of: '2026-11-03',
    weights: [{ ticker: 'APP', current_pct: 20.76, target_pct: 9.1 }],
    orders: [{ action: 'SELL', ticker: 'APP', shares: 1.2, amount_usd: 290.4 }, { action: 'BUY', ticker: 'VICI', shares: 4, amount_usd: 99 }],
    effect: { volatility_before: 0.436, volatility_after: 0.391, top_risk_before: { ticker: 'APP', pct: 36.5 }, top_risk_after: { ticker: 'APP', pct: 14.2 } },
    cash_after_usd: 255, warnings: ['SFD: sin historia suficiente, excluida de la optimización'],
};

it('renders the orders, the before/after effect, the cash and the warnings', () => {
    render(<OrderResult result={response} hidden={false} />);
    expect(screen.getByText(/Vender 1,2 de APP/).textContent).toContain('290 USD');
    expect(screen.getByText(/Comprar 4 de VICI/).textContent).toContain('99 USD');
    const fx = screen.getByTestId('effect').textContent!;
    expect(fx).toContain('43,6 %');
    expect(fx).toContain('39,1 %');
    expect(fx).toContain('36,5 %');
    expect(fx).toContain('14,2 %');
    expect(fx).toContain('255 USD');
    expect(screen.getByText(/SFD: sin historia suficiente/)).toBeTruthy();
    expect(screen.getByText(/No se ejecuta nada/)).toBeTruthy();
});

it('masks dollar amounts in privacy mode', () => {
    render(<OrderResult result={response} hidden />);
    expect(screen.getByText(/Vender 1,2 de APP/).textContent).not.toContain('290');
});

it('shows user-language options and keeps the technical names inside "Cómo se calcula"', () => {
    const { container } = render(<ImprovePanel hidden={false} onResult={() => undefined} />);
    expect(screen.getByLabelText(/Que se mueva menos/)).toBeTruthy();
    expect(screen.getByLabelText(/Que no dependa de una sola/)).toBeTruthy();
    expect(screen.getByLabelText(/Que rinda más por el riesgo que corres/)).toBeTruthy();
    const outside = container.cloneNode(true) as HTMLElement;
    outside.querySelector('details')!.remove();
    expect(outside.textContent).not.toMatch(/HRP|Sharpe|volatilidad mínima|mínima volatilidad/i);
    expect(container.querySelector('details')!.textContent).toMatch(/HRP/);
});

it('choosing an option calls the API with its objective, shows loading, then the result and reports the weights', async () => {
    let resolve!: (v: OptimizeResponse) => void;
    optimizePortfolio.mockReturnValue(new Promise(r => { resolve = r; }));
    const onResult = vi.fn();
    render(<ImprovePanel hidden={false} onResult={onResult} />);
    fireEvent.click(screen.getByLabelText(/Que no dependa de una sola/));
    expect(optimizePortfolio).toHaveBeenCalledWith('risk_parity');
    expect(screen.getByRole('status').textContent).toContain('Calculando');
    resolve(response);
    await waitFor(() => expect(screen.getByText(/Vender 1,2 de APP/)).toBeTruthy());
    expect(onResult).toHaveBeenLastCalledWith(response);
});

it('surfaces an API error and clears any previous result', async () => {
    optimizePortfolio.mockRejectedValue(new Error('Sin historia suficiente'));
    const onResult = vi.fn();
    render(<ImprovePanel hidden={false} onResult={onResult} />);
    fireEvent.click(screen.getByLabelText(/Que se mueva menos/));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Sin historia suficiente'));
    expect(optimizePortfolio).toHaveBeenCalledWith('min_volatility');
    expect(onResult).toHaveBeenLastCalledWith(null);
});
