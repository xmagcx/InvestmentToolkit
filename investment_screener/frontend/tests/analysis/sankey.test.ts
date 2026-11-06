/**
 * Purpose: the Sankey arithmetic of the Descripción tab (S8): "De cada $100…" reading and the flow graph built
 * from income_quarter (missing lines skipped, every node = sum of its outgoing links).
 * Layer: Frontend unit. Usage: npx vitest run tests/analysis/sankey.test.ts
 */
import { describe, expect, it } from 'vitest';
import { buildSankey, sankeyReading } from '../../src/utils/analysisFormat';
import type { StockOverviewIncome } from '../../src/services/api';

const inc = (over: Partial<StockOverviewIncome> = {}): StockOverviewIncome => ({
    period: '2026-03-31', revenue: 100, cost_of_revenue: 32, gross_profit: 68, research_development: 10, sga: 8,
    operating_income: 50, tax: 10, net_income: 40, segments: null, ...over,
});

describe('sankeyReading', () => {
    it('computes the cents per $100 from the data', () => {
        expect(sankeyReading('Acme', inc())).toBe(
            'De cada $100 que factura, Acme gasta $32 en producir, $18 en I+D, ventas y administración y $10 en impuestos: le quedan $40 de beneficio neto.');
    });
    it('rounds to whole dollars', () => {
        const r = sankeyReading('Acme', inc({ revenue: 92.3, cost_of_revenue: 29.7, gross_profit: 62.6, research_development: 9, sga: 7.6, tax: 9.3, net_income: 36.6 }));
        expect(r).toContain('$32 en producir');
        expect(r).toContain('$18 en I+D');
        expect(r).toContain('$10 en impuestos');
        expect(r).toContain('$40 de beneficio neto');
    });
    it('derives cost from gross profit when cost is missing and treats missing R&D/SG&A/tax as zero', () => {
        const r = sankeyReading('Acme', inc({ cost_of_revenue: null, research_development: null, sga: null, tax: null }));
        expect(r).toContain('$32 en producir');
        expect(r).toContain('$0 en I+D, ventas y administración y $0 en impuestos');
    });
    it('is null without revenue or net income', () => {
        expect(sankeyReading('Acme', inc({ revenue: null }))).toBeNull();
        expect(sankeyReading('Acme', inc({ net_income: null }))).toBeNull();
        expect(sankeyReading('Acme', null)).toBeNull();
    });
});

describe('buildSankey', () => {
    const sums = (s: NonNullable<ReturnType<typeof buildSankey>>) => s.nodes.map((n) => ({
        id: n.id, out: s.links.filter((l) => l.from === n.id).reduce((a, l) => a + l.value, 0), inn: s.links.filter((l) => l.to === n.id).reduce((a, l) => a + l.value, 0), value: n.value,
    }));
    it('builds revenue → cost/gross → R&D, SG&A/operating → tax/net with a single Ingresos source', () => {
        const s = buildSankey(inc())!;
        expect(s.nodes.map((n) => n.label)).toEqual(['Ingresos', 'Beneficio bruto', 'Coste de ventas', 'Resultado operativo', 'I+D', 'Ventas y administración', 'Beneficio neto', 'Impuestos']);
        expect(s.nodes.find((n) => n.id === 'rev')!.kind).toBe('income');
        expect(s.nodes.find((n) => n.id === 'ni')!.kind).toBe('profit');
        expect(s.nodes.find((n) => n.id === 'tax')!.kind).toBe('expense');
    });
    it('keeps every flow consistent: inflow = outflow for inner nodes', () => {
        for (const over of [{}, { research_development: null }, { sga: null, tax: null }, { cost_of_revenue: null, gross_profit: null }, { operating_income: null }]) {
            const s = buildSankey(inc(over))!;
            for (const n of sums(s)) {
                if (n.id !== 'rev') expect(n.inn).toBeCloseTo(n.value, 6);
                if (n.out > 0) expect(n.out).toBeCloseTo(n.value, 6);
            }
        }
    });
    it('skips missing lines instead of inventing them', () => {
        const s = buildSankey(inc({ research_development: null }))!;
        expect(s.nodes.some((n) => n.id === 'rd')).toBe(false);
        expect(s.nodes.some((n) => n.id === 'sga')).toBe(true);
    });
    it('adds an "Otros gastos" node when reported operating income leaves an unexplained gap', () => {
        const s = buildSankey(inc({ operating_income: 45 }))!;
        expect(s.nodes.find((n) => n.id === 'opex_other')!.value).toBeCloseTo(5, 6);
    });
    it('is null without revenue', () => {
        expect(buildSankey(inc({ revenue: null }))).toBeNull();
        expect(buildSankey(null)).toBeNull();
    });
});
