/**
 * @vitest-environment jsdom
 * Purpose: the compact strategy donut of the summary rail renders one arc and one
 * legend entry per strategy (name, percentage, USD amount) and says so when empty.
 * Percentages are shares of the slices' own sum: the allocation API reports equity
 * pillars against the equity total and cash against the grand total, so its `pct`
 * fields do not add up to 100 and are not used.
 * Layer: Frontend unit. Usage: npx vitest run src/components/summary/AllocationDonut.test.tsx.
 */
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import AllocationDonut from './AllocationDonut';

describe('AllocationDonut', () => {
    it('renders one legend entry per strategy with its share of the slices and its amount', () => {
        const items = [
            { id: 'dividends', name: 'Dividendos', valueUSD: 750, pct: 99 },
            { id: 'growth', name: 'Crecimiento', valueUSD: 250, pct: 1 },
        ];
        const { container } = render(<AllocationDonut items={items} />);
        expect(screen.getByText('Dividendos')).toBeTruthy();
        expect(screen.getByText('75,0 %')).toBeTruthy();
        expect(screen.getByText('25,0 %')).toBeTruthy();
        expect(screen.getByText('750,00 USD')).toBeTruthy();
        expect(screen.getByText('1.000')).toBeTruthy(); // centre: total of the slices
        expect(container.querySelectorAll('circle').length).toBe(3); // ring + one arc per strategy
        expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/Dividendos 75,0 %/);
    });

    it('keeps percentages consistent when the API mixes bases (equity pillar 100 %, cash 2,2 %)', () => {
        const items = [
            { id: 'other', name: 'Other', valueUSD: 3736.85, pct: 100 },
            { id: 'cash', name: 'cash', valueUSD: 80.16, pct: 2.2 },
        ];
        render(<AllocationDonut items={items} />);
        expect(screen.getByText('97,9 %')).toBeTruthy();
        expect(screen.getByText('2,1 %')).toBeTruthy();
        expect(screen.getByText('3.817')).toBeTruthy();
        // backend ids for unassigned holdings and cash get Spanish labels
        expect(screen.getByText('Sin estrategia')).toBeTruthy();
        expect(screen.getByText('Caja')).toBeTruthy();
    });

    it('says there is no allocation data instead of drawing an empty ring', () => {
        render(<AllocationDonut items={[]} />);
        expect(screen.getByText('Sin datos de asignación.')).toBeTruthy();
    });
});
