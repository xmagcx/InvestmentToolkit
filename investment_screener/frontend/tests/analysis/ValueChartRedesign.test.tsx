/**
 * @vitest-environment jsdom
 * Purpose: T9 / S6b - the Precio vs valor chart redesigned after the SVI references: SMA200 segments coloured by state,
 * hatched band per state, nice-number right axis with non-overlapping tags, volume bars, range pills incl. YTD / 10A,
 * "Ocultar media" and "Niveles", the navigator (keyboard), the crosshair tooltip and the svg summary.
 * Layer: Frontend integration. Usage: npx vitest run tests/analysis/ValueChartRedesign.test.tsx
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ValueChart } from '../../src/components/analysis/ValueChart';
import { fmtDateEs, niceTicks, spreadTags, timeTicks } from '../../src/components/analysis/valueChart/geometry';
import { fmtVolumeEs } from '../../src/utils/analysisFormat';
import type { ValueHistory } from '../../src/services/api';

afterEach(cleanup);

const pt = (date: string, price: number, sma200: number | null, volume: number | null = 1e6) => ({ date, price, sma200, fair_value: null, volume });
const CROSSING = [pt('2025-01-01', 90, 100), pt('2025-02-01', 95, 100), pt('2025-03-01', 105, 100), pt('2025-04-01', 110, 101, 174_240_000)];

const hist = (points = CROSSING, cur: Partial<ValueHistory['current']> = {}, over: Partial<ValueHistory> = {}): ValueHistory => ({
    ticker: 'ACME', currency: 'USD', points,
    current: { price: points.at(-1)!.price, fair_value: null, date: points.at(-1)!.date, sma200: points.at(-1)!.sma200, zone: 'sobrevalorada', distance_pct: 8.91,
        confirmation: { price: 118, basis: 'Zona de volumen $116–$118 (techo)', distance_pct: 7.27 }, ...cur },
    levels: { supports: [{ price: 104, basis: 'Fibonacci 0.618' }], resistances: [{ price: 118, basis: 'Zona de volumen $116–$118 (techo)' }] },
    overview: points.map((p) => ({ date: p.date, price: p.price })),
    ...over,
});

/** 30 daily points oscillating around a flat mean of 100. */
const LONG = Array.from({ length: 30 }, (_, i) => pt(`2025-03-${String(i + 1).padStart(2, '0')}`, 100 + 10 * Math.sin(i / 3), 100, 1000 + i));

const show = (h: ValueHistory, onRange = vi.fn(), range: 'ytd' | '1y' | '5y' = '1y') =>
    render(<ValueChart history={h} range={range} onRangeChange={onRange} currency="USD" />);

describe('geometry helpers', () => {
    it('niceTicks are 1 / 2 / 2.5 / 5 x 10^k steps, inside the range, at most 6', () => {
        for (const [lo, hi] of [[88, 112], [0.31, 0.57], [412, 538], [3, 4.2], [18000, 91000]]) {
            const t = niceTicks(lo, hi);
            expect(t.length).toBeGreaterThanOrEqual(3);
            expect(t.length).toBeLessThanOrEqual(6);
            expect(t[0]).toBeGreaterThanOrEqual(lo);
            expect(t.at(-1)!).toBeLessThanOrEqual(hi);
            const step = t[1] - t[0];
            const mant = step / Math.pow(10, Math.floor(Math.log10(step)));
            expect([1, 2, 2.5, 5]).toContain(+mant.toFixed(6));
        }
        expect(niceTicks(90, 110)).toEqual([90, 95, 100, 105, 110]);
    });
    it('spreadTags keeps neighbours at least `gap` apart inside the bounds and keeps the input order', () => {
        const out = spreadTags([100, 101, 102], 18, 10, 200);
        const s = [...out].sort((a, b) => a - b);
        s.slice(1).forEach((v, i) => expect(v - s[i]).toBeGreaterThanOrEqual(18));
        expect(out[0]).toBeLessThan(out[2]);
        const edge = spreadTags([199, 200], 18, 10, 200);
        expect(Math.max(...edge)).toBeLessThanOrEqual(200);
        expect(Math.abs(edge[0] - edge[1])).toBeGreaterThanOrEqual(18);
    });
    it('timeTicks: months (Spanish abbreviations) up to ~1 year, years beyond', () => {
        const months = timeTicks(['2025-01-02', '2025-01-20', '2025-02-03', '2025-03-03']);
        expect(months.map((t) => t.label)).toEqual(['ene', 'feb', 'mar']);
        const years = timeTicks(['2020-01-06', '2021-01-04', '2022-01-03', '2023-01-02']);
        expect(years.map((t) => t.label)).toEqual(['2020', '2021', '2022', '2023']);
        expect(fmtDateEs('2026-06-05')).toBe('5 jun 2026');
    });
    it('fmtVolumeEs abbreviates like the references', () => {
        expect(fmtVolumeEs(174_240_000)).toBe('174,24M');
        expect(fmtVolumeEs(6_980_000)).toBe('6,98M');
        expect(fmtVolumeEs(12_300)).toBe('12,3K');
        expect(fmtVolumeEs(2_500_000_000)).toBe('2,50B');
        expect(fmtVolumeEs(850)).toBe('850');
    });
});

describe('price, SMA200 and band', () => {
    it('draws the price as a blue line over a soft area', () => {
        const { container } = show(hist());
        expect(screen.getByTestId('price-line').getAttribute('class')).toContain('stroke-sky');
        expect(container.querySelector('[data-testid="price-area"]')).toBeTruthy();
    });

    it('colours the dotted SMA200 line per state across a crossing: emerald where price is under it, red where over', () => {
        show(hist());
        const segs = screen.getAllByTestId('sma-line');
        expect(segs.map((s) => s.getAttribute('data-state'))).toEqual(['infravalorada', 'sobrevalorada']);
        expect(segs[0].getAttribute('class')).toContain('emerald');
        expect(segs[1].getAttribute('class')).toContain('red');
        segs.forEach((s) => expect(s.getAttribute('stroke-dasharray')).toBeTruthy());
    });

    it('fills each band with the hatch pattern of its own state', () => {
        const { container } = show(hist());
        const under = container.querySelector('[data-zone="infravalorada"]')!;
        const over = container.querySelector('[data-zone="sobrevalorada"]')!;
        const id = (el: Element) => /^url\(#(.+)\)$/.exec(el.getAttribute('fill') ?? '')![1];
        expect(id(under)).not.toBe(id(over));
        expect(container.querySelector(`pattern[id="${id(under)}"]`)!.innerHTML).toContain('emerald');
        expect(container.querySelector(`pattern[id="${id(over)}"]`)!.innerHTML).toContain('red');
    });
});

describe('right axis and tags', () => {
    it('has nice-number ticks and the current price tag on the axis', () => {
        show(hist(LONG));
        const ticks = screen.getAllByTestId('y-tick').map((t) => Number((t.textContent ?? '').replace(/\./g, '').replace(',', '.')));
        expect(ticks.length).toBeGreaterThanOrEqual(4);
        expect(ticks.length).toBeLessThanOrEqual(6);
        const step = ticks[1] - ticks[0];
        expect([1, 2, 2.5, 5]).toContain(+(step / Math.pow(10, Math.floor(Math.log10(step)))).toFixed(6));
        expect(screen.getByTestId('price-tag').textContent).toBe(fmtP(LONG.at(-1)!.price));
        expect(screen.getByTestId('sma-tag').textContent).toBe('100,00');
    });

    it('colours the SMA tag by the current zone and never overlaps the price tag', () => {
        show(hist([...CROSSING.slice(0, 3), pt('2025-04-01', 100.4, 100.5)], { price: 100.4, sma200: 100.5, zone: 'infravalorada', distance_pct: -0.1, confirmation: null }));
        const p = Number(screen.getByTestId('price-tag').getAttribute('data-y'));
        const m = Number(screen.getByTestId('sma-tag').getAttribute('data-y'));
        expect(Math.abs(p - m)).toBeGreaterThanOrEqual(16);
        expect(screen.getByTestId('sma-tag-bg').getAttribute('class')).toContain('emerald');
        cleanup();
        show(hist());
        expect(screen.getByTestId('sma-tag-bg').getAttribute('class')).toContain('red');
    });
});

const fmtP = (v: number) => v.toFixed(2).replace('.', ',');

describe('volume', () => {
    it('draws one bar per point and tags the last volume abbreviated', () => {
        const { container } = show(hist());
        expect(container.querySelectorAll('[data-testid="volume-bar"]').length).toBe(CROSSING.length);
        expect(screen.getByTestId('volume-tag').textContent).toBe('174,24M');
    });
});

describe('x axis', () => {
    it('drops a partial first month label that would sit on top of the next one', () => {
        const days = Array.from({ length: 40 }, (_, i) => { const d = new Date(Date.UTC(2025, 0, 30 + i)); return pt(d.toISOString().slice(0, 10), 100 + (i % 5), 100); });
        show(hist(days));
        const labels = screen.getAllByTestId('x-tick').map((t) => t.textContent);
        expect(labels).toEqual(['feb', 'mar']);
    });
});

describe('legend, toggles and pills', () => {
    it('shows the legend with text and the Ocultar media toggle hides the line, the band and the tag', () => {
        const { container } = show(hist());
        expect(screen.getByText('Infravalorada')).toBeTruthy();
        expect(screen.getByText('Sobrevalorada')).toBeTruthy();
        const toggle = screen.getByRole('button', { name: 'Ocultar media' });
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(toggle);
        expect(screen.queryAllByTestId('sma-line')).toHaveLength(0);
        expect(container.querySelectorAll('[data-zone]').length).toBe(0);
        expect(screen.queryByTestId('sma-tag')).toBeNull();
        expect(screen.getByTestId('price-line')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Ocultar media' }).getAttribute('aria-pressed')).toBe('true');
    });

    it('"Niveles" is off by default and then shows the level lines and the list', () => {
        const { container } = show(hist());
        const toggle = screen.getByRole('button', { name: 'Niveles' });
        expect(toggle.getAttribute('aria-pressed')).toBe('false');
        expect(container.querySelectorAll('[data-testid$="support-line"],[data-testid="resistance-line"]').length).toBe(0);
        expect(screen.queryByRole('list', { name: 'Soportes y resistencias' })).toBeNull();
        fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByTestId('support-line')).toBeTruthy();
        expect(screen.getByTestId('resistance-line')).toBeTruthy();
        expect(screen.getByRole('list', { name: 'Soportes y resistencias' }).textContent).toContain('Soporte $104 · Fibonacci 0.618');
    });

    it('range pills: YTD 1A 3A 5A 10A MÁX call onRangeChange; the active one is filled and aria-pressed', () => {
        const onRange = vi.fn();
        show(hist(), onRange, '5y');
        const labels = ['YTD', '1A', '3A', '5A', '10A', 'MÁX'];
        const pills = labels.map((l) => screen.getByRole('button', { name: l }));
        expect(pills.map((b) => b.getAttribute('aria-pressed'))).toEqual(['false', 'false', 'false', 'true', 'false', 'false']);
        expect(pills[3].getAttribute('class')).toContain('bg-sky-');
        expect(pills[3].getAttribute('class')).toContain('text-white');
        expect(pills[0].getAttribute('class')).toContain('text-slate-400');
        labels.forEach((l, i) => { fireEvent.click(pills[i]); });
        expect(onRange.mock.calls.map((c) => c[0])).toEqual(['ytd', '1y', '3y', '5y', '10y', 'max']);
    });
});

describe('navigator', () => {
    const bars = (c: HTMLElement) => c.querySelectorAll('[data-testid="volume-bar"]').length;

    it('moves the visible window with the arrow keys on its two handles', () => {
        const { container } = show(hist(LONG));
        const start = screen.getByRole('slider', { name: 'Inicio de la ventana' });
        const end = screen.getByRole('slider', { name: 'Fin de la ventana' });
        expect(start.getAttribute('aria-valuetext')).toBe('1 mar 2025');
        expect(end.getAttribute('aria-valuetext')).toBe('30 mar 2025');
        expect(bars(container)).toBe(30);
        fireEvent.keyDown(start, { key: 'ArrowRight' });
        const startAfter = start.getAttribute('aria-valuetext');
        expect(startAfter).not.toBe('1 mar 2025');
        const n1 = bars(container);
        expect(n1).toBeLessThan(30);
        fireEvent.keyDown(end, { key: 'ArrowLeft' });
        expect(end.getAttribute('aria-valuetext')).not.toBe('30 mar 2025');
        expect(bars(container)).toBeLessThan(n1);
        fireEvent.keyDown(end, { key: 'ArrowRight' });
        fireEvent.keyDown(end, { key: 'ArrowRight' });
        expect(end.getAttribute('aria-valuetext')).toBe('30 mar 2025');   // never beyond the loaded data
        fireEvent.keyDown(start, { key: 'ArrowLeft' });
        fireEvent.keyDown(start, { key: 'ArrowLeft' });
        expect(start.getAttribute('aria-valuetext')).toBe('1 mar 2025');
    });

    it('keeps a minimum window and selecting a range pill resets it', () => {
        const onRange = vi.fn();
        const { container } = show(hist(LONG), onRange);
        const start = screen.getByRole('slider', { name: 'Inicio de la ventana' });
        for (let i = 0; i < 60; i++) fireEvent.keyDown(start, { key: 'ArrowRight' });
        expect(bars(container)).toBeGreaterThanOrEqual(2);
        expect(bars(container)).toBeLessThan(10);
        fireEvent.click(screen.getByRole('button', { name: '1A' }));
        expect(bars(container)).toBe(30);
        expect(onRange).toHaveBeenCalledWith('1y');
    });

    it('draws the overview line of the full history', () => {
        show(hist(LONG, {}, { overview: Array.from({ length: 50 }, (_, i) => ({ date: `${1990 + i}-01-01`, price: 10 + i })) }));
        expect(screen.getByTestId('overview-line')).toBeTruthy();
    });
});

describe('crosshair, keyboard and accessibility', () => {
    it('ArrowLeft on the focused chart region shows the tooltip of that point', () => {
        show(hist());
        const region = screen.getByRole('group', { name: /Gráfico de precio/ });
        expect(screen.queryByTestId('crosshair-tooltip')).toBeNull();
        fireEvent.keyDown(region, { key: 'ArrowLeft' });   // starts from the last point (110 / 101) and steps back to 105 / 100
        const tip = screen.getByTestId('crosshair-tooltip');
        expect(within(tip).getByText('1 mar 2025')).toBeTruthy();
        expect(tip.textContent).toContain('Precio');
        expect(tip.textContent).toContain('105,00');
        expect(tip.textContent).toContain('Media 200 días');
        expect(tip.textContent).toContain('100,00');
        expect(tip.textContent).toContain('Diferencia');
        expect(tip.textContent).toContain('+5,0% · Sobrevalorada');
        fireEvent.keyDown(region, { key: 'ArrowLeft' });
        expect(screen.getByTestId('crosshair-tooltip').textContent).toContain('95,00');
        expect(screen.getByTestId('crosshair-tooltip').textContent).toContain('-5,0% · Infravalorada');
        fireEvent.keyDown(region, { key: 'Escape' });
        expect(screen.queryByTestId('crosshair-tooltip')).toBeNull();
    });

    it('the svg has role img with a summary of range, price, mean and zone; no transitions are declared', () => {
        const { container } = show(hist());
        const svg = screen.getByRole('img', { name: /ACME/ });
        const label = svg.getAttribute('aria-label')!;
        for (const part of ['1A', '110,00', '101,00', 'sobrevalorada']) expect(label).toContain(part);
        expect(container.innerHTML).not.toMatch(/transition-(all|transform|opacity)|animate-/);
    });

    it('scales with the container: viewBox and no fixed width', () => {
        show(hist());
        const svg = screen.getByRole('img', { name: /ACME/ });
        expect(svg.getAttribute('viewBox')).toBeTruthy();
        expect(svg.getAttribute('width')).toBeNull();
        expect(svg.getAttribute('preserveAspectRatio')).toBe('xMidYMid meet');
    });
});
