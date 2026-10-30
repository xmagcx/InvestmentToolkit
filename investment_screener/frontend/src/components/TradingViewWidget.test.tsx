/**
 * @vitest-environment jsdom
 * TradingViewWidget.test.tsx (Vitest component test)
 * =====================================
 * Purpose: prove the public TradingView embed is injected anonymously, once, and cleaned up.
 * Layer: Frontend / Components / Tests
 * Key Input Dependencies: src/components/TradingViewWidget.tsx, jsdom, @testing-library/react.
 * Key Functions: script src test, config test, symbol-change test, unmount cleanup test, caption test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TradingViewWidget } from './TradingViewWidget';

afterEach(cleanup);

function scripts(container: HTMLElement): HTMLScriptElement[] {
    return Array.from(container.querySelectorAll('script'));
}

describe('TradingViewWidget', () => {
    it('injects exactly one official embed script carrying the mapped symbol', () => {
        const { container } = render(<TradingViewWidget kind="advanced-chart" symbol="ry.to" />);
        const injected = scripts(container);
        expect(injected).toHaveLength(1);
        expect(injected[0].src).toBe(
            'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js',
        );
        const config = JSON.parse(injected[0].innerHTML);
        expect(config.symbol).toBe('TSX:RY');
        expect(config.locale).toBe('es');
        expect(config.colorTheme).toBe('dark');
        expect(config.autosize).toBe(true);
        expect(config.hide_side_toolbar).toBe(true);
        expect(config.allow_symbol_change).toBe(false);
    });

    it('uses the widget name of the requested kind', () => {
        const { container } = render(<TradingViewWidget kind="symbol-overview" symbol="AAPL" />);
        expect(scripts(container)[0].src).toContain('embed-widget-symbol-overview.js');
    });

    it('replaces the script when the symbol changes', () => {
        const { container, rerender } = render(<TradingViewWidget kind="advanced-chart" symbol="AAPL" />);
        const first = scripts(container)[0];
        rerender(<TradingViewWidget kind="advanced-chart" symbol="MSFT" />);
        const after = scripts(container);
        expect(after).toHaveLength(1);
        expect(after[0]).not.toBe(first);
        expect(JSON.parse(after[0].innerHTML).symbol).toBe('MSFT');
    });

    it('empties its container on unmount', () => {
        const { container, unmount } = render(<TradingViewWidget kind="advanced-chart" symbol="AAPL" />);
        const host = container.querySelector('[data-testid="tradingview-widget-host"]');
        expect(host?.childElementCount).toBeGreaterThan(0);
        unmount();
        expect(host?.childElementCount).toBe(0);
    });

    it('renders the delayed-data caption and the TradingView attribution link', () => {
        render(<TradingViewWidget kind="advanced-chart" symbol="AAPL" />);
        expect(screen.getByText(/Datos de TradingView, pueden estar diferidos/)).toBeTruthy();
        const link = screen.getByRole('link', { name: /TradingView/i }) as HTMLAnchorElement;
        expect(link.href).toContain('tradingview.com');
        expect(link.rel).toContain('noopener');
    });

    it('renders nothing but the caption when the symbol is unusable', () => {
        const { container } = render(<TradingViewWidget kind="advanced-chart" symbol="  " />);
        expect(scripts(container)).toHaveLength(0);
    });
});
