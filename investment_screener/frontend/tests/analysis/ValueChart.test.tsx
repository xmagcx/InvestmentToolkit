/**
 * @vitest-environment jsdom
 * Purpose: the Precio vs valor chart (S6 rewritten after L12): price area against the 200-day mean split at crossings,
 * Infravalorada / Sobrevalorada by colour AND text, confirmation reading for both zones, labelled support/resistance
 * lines, the "less than 200 sessions" note, the two "?" tips and the unchanged "Ocultar valoración" toggle.
 * Layer: Frontend integration. Usage: npx vitest run tests/analysis/ValueChart.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ValueChart } from '../../src/components/analysis/ValueChart';
import { zoneRuns, valueReading } from '../../src/utils/analysisFormat';
import type { ValueHistory } from '../../src/services/api';

afterEach(cleanup);

const pt = (date: string, price: number, sma200: number | null, fair_value: number | null = null) => ({ date, price, sma200, fair_value });
const CROSSING = [pt('2025-01-01', 90, 100), pt('2025-02-01', 95, 100), pt('2025-03-01', 105, 100), pt('2025-04-01', 110, 101)];

const hist = (over: Partial<ValueHistory> = {}, cur: Partial<ValueHistory['current']> = {}): ValueHistory => ({
    ticker: 'ACME', currency: 'USD', points: CROSSING,
    current: { price: 110, fair_value: null, date: '2025-04-01', sma200: 101, zone: 'sobrevalorada', distance_pct: 8.91,
        confirmation: { price: 118, basis: 'Zona de volumen $116–$118 (techo)', distance_pct: 7.27 }, ...cur },
    levels: { supports: [{ price: 104, basis: 'Fibonacci 0.618' }], resistances: [{ price: 118, basis: 'Zona de volumen $116–$118 (techo)' }, { price: 400, basis: 'EMA 200 días' }] },
    ...over,
});

const show = (h: ValueHistory) => render(<ValueChart history={h} range="1y" onRangeChange={vi.fn()} currency="USD" />);

describe('zoneRuns', () => {
    it('cuts at the interpolated crossing: one run per side', () => {
        const runs = zoneRuns(CROSSING);
        expect(runs.map((r) => r.over)).toEqual([false, true]);
        // crossing between index 1 (d=-5) and 2 (d=+5): halfway, at the mean value 100
        expect(runs[0].price.at(-1)).toEqual([1.5, 100]);
        expect(runs[1].price[0]).toEqual([1.5, 100]);
        expect(runs[0].sma.at(-1)).toEqual([1.5, 100]);
    });
    it('skips points without a mean', () => {
        expect(zoneRuns([pt('a', 1, null), pt('b', 2, null)])).toEqual([]);
    });
});

describe('valueReading', () => {
    it('infravalorada reads distance to the mean and the nearest support', () => {
        const text = valueReading(hist({}, { price: 94, sma200: 100.2, zone: 'infravalorada', distance_pct: -6.19,
            confirmation: { price: 91, basis: 'Fibonacci 0.618', distance_pct: -3.19 } }).current);
        expect(text).toBe('Precio 6,2% bajo su media de 200 días (infravalorada), cerca del soporte $91,00 (Fibonacci 0.618, a 3,2%).');
    });
    it('sobrevalorada reads distance and the nearest resistance', () => {
        expect(valueReading(hist().current)).toBe('Precio 8,9% sobre su media de 200 días (sobrevalorada), próxima resistencia $118 (Zona de volumen $116–$118 (techo), a 7,3%).');
    });
    it('says so when no level confirms the zone, and when there is no mean', () => {
        expect(valueReading(hist({}, { confirmation: null }).current)).toContain('sin una resistencia del gráfico sobre el precio');
        expect(valueReading(hist({}, { sma200: null, zone: null, distance_pct: null, confirmation: null }).current)).toBe('Menos de 200 sesiones: sin media de 200 días.');
    });
});

describe('ValueChart', () => {
    it('draws one emerald Infravalorada and one red Sobrevalorada area with a text legend', () => {
        const { container } = show(hist());
        const under = container.querySelectorAll('[data-zone="infravalorada"]');
        const over = container.querySelectorAll('[data-zone="sobrevalorada"]');
        expect(under.length).toBe(1);
        expect(over.length).toBe(1);
        expect(under[0].getAttribute('class')).toContain('emerald');
        expect(over[0].getAttribute('class')).toContain('red');
        expect(screen.getByText(/Infravalorada \(precio bajo/)).toBeTruthy();
        expect(screen.getByText(/Sobrevalorada \(precio sobre/)).toBeTruthy();
        expect(screen.getByTestId('sma-line').getAttribute('stroke-dasharray')).toBeTruthy();
        expect(screen.getAllByText('Media 200 días').length).toBeGreaterThan(0);
    });

    it('shows the reading line above the chart', () => {
        show(hist());
        expect(screen.getByTestId('value-reading').textContent).toContain('Precio 8,9% sobre su media de 200 días (sobrevalorada)');
    });

    it('draws labelled levels inside the range and leaves out the far one', () => {
        const { container } = show(hist());
        expect(container.querySelectorAll('[data-testid="support-line"]').length).toBe(1);
        expect(container.querySelectorAll('[data-testid="resistance-line"]').length).toBe(1);
        expect(screen.getByText('Soporte $104 · Fibonacci 0.618')).toBeTruthy();
        expect(screen.getByText('Resistencia $118 · Zona de volumen $116–$118 (techo)')).toBeTruthy();
        expect(screen.queryByText(/EMA 200 días/)).toBeNull();   // $400 is far outside the range
        expect(screen.getByTestId('support-line').getAttribute('class')).toContain('emerald');
        expect(screen.getByTestId('resistance-line').getAttribute('class')).toContain('red');
    });

    it('keeps in-chart level tags at least 13px apart and lists the full levels below the chart', () => {
        const h = hist();
        const near = { ...h, levels: { supports: [{ price: 104, basis: 'Fibonacci 0.618' }, { price: 103.9, basis: 'EMA 50 días' }], resistances: h.levels!.resistances } };
        const { container } = show(near);
        const ys = [...container.querySelectorAll('[data-testid="level-tag"]')].map((t) => Number(t.getAttribute('y'))).sort((a, b) => a - b);
        expect(ys.length).toBe(3);
        ys.slice(1).forEach((v, i) => expect(v - ys[i]).toBeGreaterThanOrEqual(13));
        const list = screen.getByRole('list', { name: 'Soportes y resistencias' });
        expect(list.textContent).toContain('Soporte $104 · Fibonacci 0.618');
    });

    it('without a 200-day mean shows the price only plus the note', () => {
        const h = hist({ points: CROSSING.map((p) => ({ ...p, sma200: null })) },
            { sma200: null, zone: null, distance_pct: null, confirmation: null });
        const { container } = show(h);
        expect(screen.getByTestId('price-line')).toBeTruthy();
        expect(screen.queryByTestId('sma-line')).toBeNull();
        expect(container.querySelectorAll('[data-zone]').length).toBe(0);
        expect(container.querySelectorAll('[data-testid$="-line"]:not([data-testid="price-line"])').length).toBe(0);
        expect(screen.getAllByText('Menos de 200 sesiones: sin media de 200 días.').length).toBeGreaterThan(0);
    });

    it('has a "?" for the 200-day mean and for supports and resistances', () => {
        show(hist());
        for (const name of ['¿Qué es Media de 200 días?', '¿Qué es Soportes y resistencias?']) {
            fireEvent.focus(screen.getByRole('button', { name }));
            const tip = screen.getByRole('tooltip');
            for (const t of ['Qué es', 'Cómo se lee', 'En ACME', 'Fuente / cálculo']) expect(within(tip).getByText(t)).toBeTruthy();
            fireEvent.keyDown(document, { key: 'Escape' });
        }
    });

    it('"Ocultar valoración" still hides the amber fair-value line only', () => {
        const h = hist({ points: CROSSING.map((p) => ({ ...p, fair_value: 108 })) }, { fair_value: 108 });
        show(h);
        expect(screen.getByTestId('value-line')).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: 'Ocultar valoración' }));
        expect(screen.queryByTestId('value-line')).toBeNull();
        expect(screen.getByTestId('sma-line')).toBeTruthy();
        expect(screen.getByTestId('price-line')).toBeTruthy();
    });
});
