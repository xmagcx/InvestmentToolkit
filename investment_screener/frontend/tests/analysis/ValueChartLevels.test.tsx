/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
afterEach(cleanup);
import { ValueChart } from '../../src/components/analysis/ValueChart';
import type { ValueHistory } from '../../src/services/api';

const hist = (over: Partial<ValueHistory> = {}): ValueHistory => ({
    ticker: 'ZZZ', currency: 'USD',
    points: Array.from({ length: 5 }, (_, i) => ({ date: `2025-01-0${i + 1}`, price: 56 + i * 0.1, fair_value: null, sma200: 58.88 })),
    current: { price: 56.5, fair_value: null, date: '2025-01-05', sma200: 58.88, zone: 'infravalorada', distance_pct: -3.95, confirmation: null },
    levels: { supports: [], resistances: [{ price: 57.02, basis: 'Zona de volumen $57–$60 (base)' }, { price: 59.55, basis: 'Zona de volumen $60–$62 (base)' }, { price: 59.55, basis: 'Zona de volumen $57–$60 (techo)' }] },
    ...over,
});

describe('ValueChart probes', () => {
    it('duplicate level prices do not trigger a React key warning', () => {
        const err = vi.spyOn(console, 'error').mockImplementation(() => {});
        render(<ValueChart history={hist()} range="1y" onRangeChange={() => {}} currency="USD" />);
        fireEvent.click(screen.getByRole('button', { name: 'Niveles' }));
        const msgs = err.mock.calls.map((c) => String(c[0]));
        err.mockRestore();
        expect(msgs.join('\n')).not.toMatch(/same key|unique "key"/i);
    });
    it('under 200 sessions: no sma line, no level lines, note shown', () => {
        const h = hist({
            points: Array.from({ length: 5 }, (_, i) => ({ date: `2025-01-0${i + 1}`, price: 56 + i, fair_value: null, sma200: null })),
            current: { price: 60, fair_value: null, date: '2025-01-05', sma200: null, zone: null, distance_pct: null, confirmation: null },
        });
        render(<ValueChart history={h} range="1y" onRangeChange={() => {}} currency="USD" />);
        expect(screen.queryByTestId('sma-line')).toBeNull();
        expect(screen.queryAllByTestId('resistance-line')).toHaveLength(0);
        expect(screen.getByTestId('value-reading').textContent).toContain('Menos de 200 sesiones');
    });
});
