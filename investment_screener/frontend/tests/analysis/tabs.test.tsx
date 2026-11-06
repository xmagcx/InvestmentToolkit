/**
 * @vitest-environment jsdom
 * Purpose: the eight Nivel 3 tab panels (S8–S15): key labels from mocked data, "—" for nulls, empty states,
 * Inversores filter, Filings toggle, Noticias search + period, Monte Carlo null state, Técnico reuse.
 * Layer: Frontend component tests. Usage: npx vitest run tests/analysis/tabs.test.tsx
 * Key Input Dependencies: services/api.ts is mocked; tabs get a pass-through loader (no cache).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

vi.mock('../../src/services/api', () => ({
    fetchMonteCarlo: vi.fn(), fetchNewsSentiment: vi.fn(), fetchFilings: vi.fn(), fetchSuperinvestors: vi.fn(), fetchTechnicalAnalysis: vi.fn(),
}));
vi.mock('../../src/components/TechnicalAnalysisSummaryCard', () => ({
    TechnicalAnalysisSummaryCard: ({ data }: { data: { ticker: string } }) => <div data-testid="ta-card">TA {data.ticker}</div>,
}));
vi.mock('../../src/components/TradingViewWidget', () => ({
    TradingViewWidget: ({ kind, symbol }: { kind: string; symbol: string }) => <div data-testid={`tv-${kind}`}>{symbol}</div>,
}));

import { fetchFilings, fetchMonteCarlo, fetchNewsSentiment, fetchSuperinvestors, fetchTechnicalAnalysis,
    type Filings, type MonteCarloData, type NewsSentiment, type StockData, type Superinvestors } from '../../src/services/api';
import { SankeyChart } from '../../src/components/analysis/SankeyChart';
import { DescriptionTab } from '../../src/components/analysis/DescriptionTab';
import { FinancialsTab } from '../../src/components/analysis/FinancialsTab';
import { ValuationTab } from '../../src/components/analysis/ValuationTab';
import { InvestorsTab } from '../../src/components/analysis/InvestorsTab';
import { FilingsTab } from '../../src/components/analysis/FilingsTab';
import { MonteCarloTab } from '../../src/components/analysis/MonteCarloTab';
import { NewsTab } from '../../src/components/analysis/NewsTab';
import { TechnicalTab } from '../../src/components/analysis/TechnicalTab';
import { noCache } from '../../src/components/analysis/useResource';

const income = { period: '2026-03-31', revenue: 100e9, cost_of_revenue: 32e9, gross_profit: 68e9, research_development: 10e9, sga: 8e9,
    operating_income: 50e9, tax: 10e9, net_income: 40e9, segments: null };
const nulls = <K extends string>(keys: K[]) => Object.fromEntries(keys.map((k) => [k, null])) as Record<K, null>;
const stock = {
    symbol: 'ACME', price: 100, currency: 'USD',
    overview: {
        profile: { name: 'Acme Corp', sector: 'Technology', industry: 'Software', country: 'United States', currency: 'USD', market_cap: 4.13e12,
            employees: 228000, hq: { city: 'Redmond', state: 'Washington', country: 'United States' }, website: 'https://acme.example',
            fiscal_year_end: 6, ceo: 'Ada Lovelace', cfo: null, description: 'Acme makes anvils.', isin: null },
        income_quarter: income, income_annual: null,
        balance: { total_assets: 779.4e9, total_equity: 470.5e9, long_term_debt: 31.1e9, total_debt: 39.9e9, cash_and_short_term: 44.4e9,
            net_debt: -40.9e9, net_debt_per_share: -3.33, debt_to_equity: 0.09 },
        multiples: { pe: 16.8, pb: null, ev_ebitda: 11, ev_ebit: 12.9, ev_sales: 11.3, ev_fcf: 15.3 },
        profitability: { roe: 31.2, roic: 23.8, roa: 18, rona: null, gross_margin: 67.7, ebitda_margin: 64.4, ebit_margin: 52.2, net_margin: 41.2, fcf_margin: 56.5 },
        cost_of_capital: { beta: 0.94, levered_beta: null, cost_of_equity: 9.6, cost_of_debt: 7.5, wacc: 9.6, discount_rate: 9.6 },
        growth: { revenue_hist: 3.4, ebit_hist: 4.9, net_income_hist: null, terminal: 2.6 },
        ownership: { insiders_pct: 0.1, institutions_pct: 71.8, public_pct: 28.1 },
        yields: nulls(['fcf_yield', 'dividend_yield', 'buyback_yield', 'augmented_yield']),
        benchmarks: { sector: null, industry: null },
    },
} as unknown as StockData;

beforeEach(() => vi.useRealTimers());
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('Descripción (S8)', () => {
    it('lists the five moat types and says the company is not classified yet', () => {
        render(<DescriptionTab stock={stock} />);
        const moat = screen.getByRole('region', { name: 'Tipos de foso' });
        for (const n of ['Activos intangibles', 'Costes de cambio', 'Efecto red', 'Ventaja en costes', 'Escala eficiente']) {
            expect(within(moat).getByText(n)).toBeTruthy();
        }
        expect(within(moat).getByText(/sin clasificar/i)).toBeTruthy();
    });

    it('renders the Sankey with title, desc, legend, the reading and the facts table without null rows', () => {
        render(<DescriptionTab stock={stock} />);
        expect(screen.getByRole('heading', { name: '¿De dónde vienen los ingresos y a dónde van?' })).toBeTruthy();
        const svg = screen.getByRole('img', { name: /De dónde vienen los ingresos/ });
        expect(svg.querySelector('title')?.textContent).toContain('De dónde vienen los ingresos');
        expect(svg.querySelector('desc')?.textContent).toContain('Ingresos');
        for (const t of ['Ingresos', 'Coste de ventas', 'Beneficio bruto', 'I+D', 'Ventas y administración', 'Resultado operativo', 'Impuestos', 'Beneficio neto'])
            expect(within(svg as unknown as HTMLElement).getAllByText(new RegExp(`^${t.replace('+', '\\+')}`)).length).toBeGreaterThan(0);
        expect(screen.getByText(/■ beneficio/)).toBeTruthy();
        expect(screen.getByText(/■ gasto/)).toBeTruthy();
        expect(screen.getByText(/■ ingreso/)).toBeTruthy();
        expect(screen.getByText(/De cada \$100 que factura, Acme Corp gasta \$32 en producir, \$18 en I\+D, ventas y administración y \$10 en impuestos: le quedan \$40 de beneficio neto\./)).toBeTruthy();
        expect(screen.getByText('Acme makes anvils.')).toBeTruthy();
        const facts = screen.getByRole('table', { name: 'Datos generales de la organización' });
        expect(within(facts).getByText('Technology · Software')).toBeTruthy();
        expect(within(facts).getByText('Redmond, Washington, United States')).toBeTruthy();
        expect(within(facts).getByText('228.000')).toBeTruthy();
        expect(within(facts).getByText('Ada Lovelace')).toBeTruthy();
        expect(within(facts).getByText('Junio')).toBeTruthy();
        expect(within(facts).getByText('4,13 T USD')).toBeTruthy();
        expect(within(facts).getByRole('link', { name: 'acme.example' }).getAttribute('href')).toBe('https://acme.example');
        expect(within(facts).queryByText('Director financiero')).toBeNull();
        expect(within(facts).queryByText('ISIN')).toBeNull();
    });

    it('without income data shows a note instead of the chart', () => {
        const s = { ...stock, overview: { ...stock.overview!, income_quarter: null } } as StockData;
        render(<DescriptionTab stock={s} />);
        expect(screen.getByText('Sin resultados trimestrales para dibujar el flujo de ingresos.')).toBeTruthy();
        expect(screen.queryByRole('img')).toBeNull();
    });

    it('SankeyChart draws a link per flow and skips missing lines', () => {
        const { container } = render(<SankeyChart income={{ ...income, research_development: null, operating_income: 60e9, net_income: 50e9 }} />);
        expect(container.querySelectorAll('path').length).toBe(6);
        expect(container.textContent).not.toContain('I+D');
    });
});

describe('Financieros (S9)', () => {
    it('lists income lines and the balance, "—" for nulls', () => {
        const s = { ...stock, overview: { ...stock.overview!, income_quarter: { ...income, sga: null } } } as StockData;
        render(<FinancialsTab stock={s} />);
        const inc = screen.getByRole('table', { name: 'Resultados 2026-03-31' });
        expect(within(inc).getByText('Ingresos').closest('tr')!.textContent).toContain('100,0 B USD');
        expect(within(inc).getByText('Beneficio neto').closest('tr')!.textContent).toContain('40,0 B USD');
        expect(within(inc).getByText('Beneficio neto').closest('tr')!.textContent).toContain('margen 40,0%');
        expect(within(inc).getByText('Ventas y administración').closest('tr')!.textContent).toContain('—');
        const bal = screen.getByRole('table', { name: 'Balance' });
        for (const [k, v] of [['Activos totales', '779,4 B USD'], ['Patrimonio', '470,5 B USD'], ['Deuda a largo plazo', '31,1 B USD'], ['Caja e inversiones a corto plazo', '44,4 B USD']])
            expect(within(bal).getByText(k).closest('tr')!.textContent).toContain(v);
    });
});

describe('Valoración (S10)', () => {
    it('shows our projection row with upside and type, or "—" without a fair value', () => {
        const { rerender } = render(<ValuationTab stock={stock} fairValue={125} />);
        const m = screen.getByRole('table', { name: 'Métodos de valoración' });
        const row = within(m).getByText('Proyección propia').closest('tr')!;
        expect(row.textContent).toContain('125,00 USD');
        expect(row.textContent).toContain('+25,0%');
        expect(row.textContent).toContain('Escenarios DCF');
        rerender(<ValuationTab stock={stock} fairValue={null} />);
        const row2 = within(screen.getByRole('table', { name: 'Métodos de valoración' })).getByText('Proyección propia').closest('tr')!;
        expect(row2.querySelectorAll('td')[0].textContent).toBe('—');
        expect(row2.querySelectorAll('td')[1].textContent).toBe('—');
    });

    it('renders multiples and profitability with Sector / Industria "—" and null cells "—"', () => {
        render(<ValuationTab stock={stock} fairValue={125} />);
        const mult = screen.getByRole('table', { name: 'Múltiplos de valoración' });
        expect(within(mult).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Múltiplo', 'ACME', 'Sector', 'Industria']);
        const per = within(mult).getByText('PER').closest('tr')!;
        expect([...per.querySelectorAll('td')].map((c) => c.textContent)).toEqual(['16,8x', '—', '—']);
        expect([...within(mult).getByText('P/VC').closest('tr')!.querySelectorAll('td')].map((c) => c.textContent)).toEqual(['—', '—', '—']);
        const prof = screen.getByRole('table', { name: 'Rentabilidad y retornos' });
        expect(within(prof).getByText('ROE').closest('tr')!.textContent).toContain('31,2%');
        expect(within(prof).getByText('RONA').closest('tr')!.textContent).toContain('—');
        expect(within(prof).getAllByRole('row').length).toBe(9);
    });

    it('renders the four cards and the reference note', () => {
        render(<ValuationTab stock={stock} fairValue={125} />);
        const risk = screen.getByRole('region', { name: 'Riesgo y coste de capital' });
        expect(within(risk).getByText('Beta').nextSibling!.textContent).toBe('0,94');
        expect(within(risk).getByText('Beta apalancada').nextSibling!.textContent).toBe('—');
        expect(within(risk).getByText('WACC').nextSibling!.textContent).toBe('9,6%');
        const growth = screen.getByRole('region', { name: 'Crecimiento' });
        expect(within(growth).getByText('Beneficio neto (histórico)').nextSibling!.textContent).toBe('—');
        expect(within(growth).getByText('Terminal').nextSibling!.textContent).toBe('2,6%');
        const own = screen.getByRole('region', { name: 'Accionariado' });
        expect(within(own).getByText('Institucional').nextSibling!.textContent).toBe('71,8%');
        const debt = screen.getByRole('region', { name: 'Deuda y apalancamiento' });
        expect(within(debt).getByText('Deuda neta').nextSibling!.textContent).toBe('-40,9 B USD');
        expect(within(debt).getByText('Deuda / patrimonio').nextSibling!.textContent).toBe('0,09x');
        expect(screen.getByText('* Valores referenciales.')).toBeTruthy();
    });
});

const holder = (over: Partial<Superinvestors['items'][number]>): Superinvestors['items'][number] => ({
    manager: 'Mgr', fund: 'Fund', cik: '1', portfolio_pct: 2.5, shares: 34270, quarter: "Q3'26", change_pct: null, action: 'hold', ...over,
});
const superData = (over: Partial<Superinvestors> = {}): Superinvestors => ({
    ticker: 'ACME', cusip: '123', holders: 5, buying: 2, selling: 2, quarter_latest: "Q3'26", errors: [],
    delay_note: 'Los 13F se publican con hasta 45 días de retraso.',
    items: [
        holder({ manager: 'A Add', action: 'add', change_pct: 5.23 }), holder({ manager: 'B New', action: 'new' }),
        holder({ manager: 'C Reduce', action: 'reduce', change_pct: 9.59 }), holder({ manager: 'D Sold', action: 'sold_out', change_pct: -100 }),
        holder({ manager: 'E Hold', action: 'hold' }), holder({ manager: 'F Big', action: 'add', change_pct: 31819.6 }),
    ], ...over,
});

describe('Inversores (S11)', () => {
    it('fetches lazily with a loading state that sets the ~50 s expectation, then shows stats, table and note', async () => {
        let resolve!: (v: Superinvestors) => void;
        vi.mocked(fetchSuperinvestors).mockReturnValue(new Promise((r) => { resolve = r; }));
        render(<InvestorsTab stock={stock} ticker="ACME" load={noCache} />);
        expect(screen.getByRole('status').textContent).toMatch(/50 s/);
        resolve(superData());
        expect(await screen.findByText('A Add')).toBeTruthy();
        expect(fetchSuperinvestors).toHaveBeenCalledWith('ACME');
        expect(screen.getByText('gestores con la acción').previousSibling!.textContent).toBe('5');
        expect(screen.getByText(/comprando/).previousSibling!.textContent).toBe('2');
        expect(screen.getByText(/reduciendo o vendiendo/).previousSibling!.textContent).toBe('2');
        expect(screen.getByText(/en manos institucionales/).previousSibling!.textContent).toBe('71,8%');
        expect(screen.getByText('Los 13F se publican con hasta 45 días de retraso.')).toBeTruthy();
        expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Gestor', 'Fondo', '% de su cartera', 'Acciones', 'Trimestre', 'Movimiento']);
    });

    it('labels every movement with symbol + text and caps >1000%', async () => {
        vi.mocked(fetchSuperinvestors).mockResolvedValue(superData());
        render(<InvestorsTab stock={stock} ticker="ACME" load={noCache} />);
        await screen.findByText('A Add');
        const mv = (name: string) => screen.getByText(name).closest('tr')!.lastElementChild!.textContent;
        expect(mv('A Add')).toBe('▲ Aumenta 5,2%');
        expect(mv('B New')).toBe('★ Compra nueva');
        expect(mv('C Reduce')).toBe('▼ Reduce 9,6%');
        expect(mv('D Sold')).toBe('✕ Vende todo');
        expect(mv('E Hold')).toBe('● Mantiene');
        expect(mv('F Big')).toBe('▲ Aumenta >1000%');
    });

    it('filters Todos / Comprando / Vendiendo / Mantienen with aria-pressed', async () => {
        vi.mocked(fetchSuperinvestors).mockResolvedValue(superData());
        render(<InvestorsTab stock={stock} ticker="ACME" load={noCache} />);
        await screen.findByText('A Add');
        const names = () => within(screen.getByRole('table')).getAllByRole('rowheader').map((r) => r.textContent);
        expect(screen.getByRole('button', { name: 'Todos' }).getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: 'Comprando' }));
        expect(names()).toEqual(['A Add', 'B New', 'F Big']);
        expect(screen.getByRole('button', { name: 'Comprando' }).getAttribute('aria-pressed')).toBe('true');
        expect(screen.getByRole('button', { name: 'Todos' }).getAttribute('aria-pressed')).toBe('false');
        fireEvent.click(screen.getByRole('button', { name: 'Vendiendo' }));
        expect(names()).toEqual(['C Reduce', 'D Sold']);
        fireEvent.click(screen.getByRole('button', { name: 'Mantienen' }));
        expect(names()).toEqual(['E Hold']);
    });

    it('shows the empty state without a cusip and an error when the request fails', async () => {
        vi.mocked(fetchSuperinvestors).mockResolvedValue(superData({ cusip: null, items: [], holders: 0, buying: 0, selling: 0 }));
        const { unmount } = render(<InvestorsTab stock={stock} ticker="ACME" load={noCache} />);
        expect(await screen.findByText('Sin datos 13F para este valor.')).toBeTruthy();
        unmount();
        vi.mocked(fetchSuperinvestors).mockResolvedValue(null);
        render(<InvestorsTab stock={stock} ticker="ACME" load={noCache} />);
        expect(await screen.findByText('No se pudieron cargar los superinversores.')).toBeTruthy();
    });
});

const filings = (over: Partial<Filings> = {}): Filings => ({
    ticker: 'ACME', cik: '789', earnings_calls: { available: false, reason: 'No hay fuente gratuita de transcripciones.' },
    sec_filings: { total: 3, items: [
        { form: '10-K', title: 'Informe anual 2025', filed: '2025-07-30', period: '2025-06-30', fiscal_year: 2025, fiscal_quarter: null, url: 'https://sec.example/10k' },
        { form: '10-Q', title: 'Informe trimestral', filed: '2026-04-28', period: '2026-03-31', fiscal_year: 2026, fiscal_quarter: 3, url: 'https://sec.example/10q' },
        { form: '8-K', title: 'Hecho relevante', filed: '2026-01-28', period: null, fiscal_year: 2026, fiscal_quarter: 2, url: 'https://sec.example/8k' },
    ] }, ...over,
});

describe('Filings (S12)', () => {
    it('opens on the honest empty state for calls, then toggles to SEC filings grouped by fiscal year (desc)', async () => {
        vi.mocked(fetchFilings).mockResolvedValue(filings());
        render(<FilingsTab ticker="ACME" load={noCache} />);
        expect(await screen.findByText('No hay fuente gratuita de transcripciones.')).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Llamadas de resultados' }).getAttribute('aria-pressed')).toBe('true');
        fireEvent.click(screen.getByRole('button', { name: 'Informes a la SEC (3)' }));
        expect(screen.queryByText('No hay fuente gratuita de transcripciones.')).toBeNull();
        const heads = screen.getAllByRole('heading', { level: 4 }).map((h) => h.textContent);
        expect(heads[0]).toContain('Año fiscal 2026');
        expect(heads[1]).toContain('Año fiscal 2025');
        const row = screen.getByText('Informe trimestral').closest('li')!;
        expect(within(row).getByText('10-Q')).toBeTruthy();
        expect(row.textContent).toContain('2026-04-28');
        const link = within(row).getByRole('link', { name: /Abrir/ });
        expect(link.textContent).toBe('Abrir');
        expect(link.getAttribute('href')).toBe('https://sec.example/10q');
        expect(link.getAttribute('target')).toBe('_blank');
        expect(link.getAttribute('rel')).toContain('noopener');
    });

    it('shows the EDGAR empty state without a cik', async () => {
        vi.mocked(fetchFilings).mockResolvedValue(filings({ cik: null, sec_filings: { total: 0, items: [] } }));
        render(<FilingsTab ticker="ACME" load={noCache} />);
        await screen.findByText('No hay fuente gratuita de transcripciones.');
        fireEvent.click(screen.getByRole('button', { name: 'Informes a la SEC (0)' }));
        expect(screen.getByText('Sin informes en EDGAR para este valor.')).toBeTruthy();
    });
});

const mc = (): MonteCarloData => ({
    ticker: 'ACME', n: 10000, seed: 42, price: 535.93,
    scenarios: { bear: { growthRate: 7, netMargin: 30, exitPE: 20, presentValue: 213.66 }, base: { growthRate: 13, netMargin: 36, exitPE: 28, presentValue: 580.41 },
        bull: { growthRate: 19, netMargin: 40, exitPE: 36, presentValue: 1101.77 } },
    result: { p10: 450, p25: 503, p50: 567, p75: 637, p90: 702, mean: 573, min: 312, max: 972, probabilityOvervalued: 0.377, probabilityUndervalued: 0.623, n: 10000, seed: 42,
        histogram: { bins: [300, 400, 500, 600, 700, 800, 900, 1000], counts: [10, 40, 90, 120, 80, 40, 20] } },
});

describe('Monte Carlo (S13)', () => {
    it('draws the histogram (red below price, green above), marks and non-overlapping price label', async () => {
        vi.mocked(fetchMonteCarlo).mockResolvedValue(mc());
        render(<MonteCarloTab ticker="ACME" company="Acme Corp" load={noCache} />);
        expect(await screen.findByTestId('mc-histogram')).toBeTruthy();
        expect(fetchMonteCarlo).toHaveBeenCalledWith('ACME');
        const bars = screen.getAllByTestId('mc-bar');
        expect(bars.length).toBe(7);
        expect(bars.map((b) => b.getAttribute('fill'))).toEqual(['#f87171', '#f87171', '#34d399', '#34d399', '#34d399', '#34d399', '#34d399']);
        for (const k of ['p10', 'p50', 'p90']) expect(screen.getByTestId(`mc-label-${k}`)).toBeTruthy();
        expect(screen.getByTestId('mc-label-p50').textContent).toBe('P50 567');
        expect(screen.getByTestId('mc-label-price').textContent).toContain('Precio');
        expect(screen.getByTestId('mc-label-price').getAttribute('y')).not.toBe(screen.getByTestId('mc-label-p50').getAttribute('y'));
        expect(screen.getByRole('img', { name: /Mediana 567/ })).toBeTruthy();
    });

    it('lists the stats, the reading and the bear/base/bull assumptions', async () => {
        vi.mocked(fetchMonteCarlo).mockResolvedValue(mc());
        render(<MonteCarloTab ticker="ACME" company="Acme Corp" load={noCache} />);
        await screen.findByTestId('mc-histogram');
        const stat = (k: string) => screen.getByText(k).nextSibling!.textContent;
        expect(stat('Probabilidad de que esté sobrevalorada')).toBe('37,7%');
        expect(stat('Probabilidad de que esté infravalorada')).toBe('62,3%');
        expect(stat('Mediana (P50)')).toBe('567,00');
        expect(stat('Media')).toBe('573,00');
        expect(stat('Rango P10 – P90')).toBe('450,00 – 702,00');
        expect(stat('Rango intercuartil')).toBe('503,00 – 637,00');
        expect(stat('Mínimo – máximo')).toBe('312,00 – 972,00');
        expect(stat('Simulaciones')).toBe('10.000');
        expect(screen.getByText(/En 62 de cada 100 simulaciones el valor justo supera el precio actual; la mitad central está entre 503,00 y 637,00\./)).toBeTruthy();
        const details = screen.getByText(/Supuestos simulados/).closest('details')!;
        const row = (k: string) => within(details).getByText(k).closest('tr')!.textContent;
        expect(row('Crecimiento de ingresos')).toContain('7,0%13,0%19,0%');
        expect(row('Margen neto')).toContain('30,0%36,0%40,0%');
        expect(row('PER de salida')).toContain('20,0x28,0x36,0x');
        expect(row('Valor por escenario')).toContain('213,66580,411.101,77');
    });

    it('null → "Sin proyección guardada…"', async () => {
        vi.mocked(fetchMonteCarlo).mockResolvedValue(null);
        render(<MonteCarloTab ticker="ACME" company="Acme Corp" load={noCache} />);
        expect(await screen.findByText('Sin proyección guardada: la simulación necesita los escenarios de una proyección.')).toBeTruthy();
        expect(screen.queryByTestId('mc-histogram')).toBeNull();
    });
});

const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * DAY).toISOString().slice(0, 10);
const news = (over: Partial<NewsSentiment> = {}): NewsSentiment => ({
    ticker: 'ACME', stale: false, fetched_at: '2026-05-01T00:00:00Z', coverage_since: '2025-01-01', total: 5,
    periods: { '1M': { positive: 6, neutral: 3, negative: 1 }, '3M': { positive: 10, neutral: 5, negative: 5 }, '6M': { positive: 1, neutral: 1, negative: 2 }, '1Y': { positive: 0, neutral: 0, negative: 0 } },
    articles: [
        { title: 'Azure grows fast', date: iso(5), source: 'cnbc.com', url: 'https://n.example/1', sentiment: 'positive', score: 0.6 },
        { title: 'Regulators open probe', date: iso(10), source: 'ft.com', url: 'https://n.example/2', sentiment: 'negative', score: -0.5 },
        { title: 'Capex rises', date: iso(60), source: 'bloomberg.com', url: 'https://n.example/3', sentiment: 'neutral', score: 0 },
        { title: 'Old news', date: iso(150), source: 'reuters.com', url: 'https://n.example/4', sentiment: 'neutral', score: 0 },
    ], ...over,
});

describe('Noticias (S14)', () => {
    it('shows the sentiment table, stacked bars with aria-label %, coverage note and stale flag', async () => {
        vi.mocked(fetchNewsSentiment).mockResolvedValue(news({ stale: true }));
        render(<NewsTab ticker="ACME" load={noCache} />);
        const table = await screen.findByRole('table', { name: 'Sentimiento de las noticias' });
        expect(fetchNewsSentiment).toHaveBeenCalledWith('ACME');
        expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Sentimiento', '1M', '3M', '6M', '1A']);
        expect([...within(table).getByText(/Positivas/).closest('tr')!.querySelectorAll('td')].map((c) => c.textContent)).toEqual(['6', '10', '1', '0']);
        expect([...within(table).getByText(/Negativas/).closest('tr')!.querySelectorAll('td')].map((c) => c.textContent)).toEqual(['1', '5', '2', '0']);
        expect(screen.getByRole('img', { name: '1M: 60,0% positivas, 30,0% neutrales, 10,0% negativas' })).toBeTruthy();
        expect(screen.getByRole('img', { name: '1A: sin artículos' })).toBeTruthy();
        expect(screen.getByText('Historial desde 2025-01-01')).toBeTruthy();
        expect(screen.getByText(/finviz no respondió/)).toBeTruthy();
    });

    it('lists articles with link, meta and label; period selector filters the list and the count', async () => {
        vi.mocked(fetchNewsSentiment).mockResolvedValue(news());
        render(<NewsTab ticker="ACME" load={noCache} />);
        const list = await screen.findByRole('list', { name: 'Titulares' });
        expect(screen.getByRole('button', { name: '1M' }).getAttribute('aria-pressed')).toBe('true');
        expect(within(list).getAllByRole('listitem').length).toBe(2);
        expect(screen.getByText('2 artículos')).toBeTruthy();
        const a = within(list).getByRole('link', { name: 'Azure grows fast' });
        expect(a.getAttribute('href')).toBe('https://n.example/1');
        expect(a.getAttribute('target')).toBe('_blank');
        expect(a.getAttribute('rel')).toContain('noopener');
        const item = a.closest('li')!;
        expect(item.textContent).toContain(`ACME · ${iso(5)} · cnbc.com`);
        expect(item.textContent).toContain('▲ Positiva');
        expect(within(list).getByText('Regulators open probe').closest('li')!.textContent).toContain('▼ Negativa');
        fireEvent.click(screen.getByRole('button', { name: '3M' }));
        expect(screen.getByRole('button', { name: '3M' }).getAttribute('aria-pressed')).toBe('true');
        expect(within(list).getAllByRole('listitem').length).toBe(3);
        expect(screen.getByText('3 artículos')).toBeTruthy();
        expect(within(list).getByText('Capex rises').closest('li')!.textContent).toContain('● Neutral');
        fireEvent.click(screen.getByRole('button', { name: '1A' }));
        expect(screen.getByText('4 artículos')).toBeTruthy();
    });

    it('search filters titles live and shows an empty note', async () => {
        vi.mocked(fetchNewsSentiment).mockResolvedValue(news());
        render(<NewsTab ticker="ACME" load={noCache} />);
        await screen.findByRole('list', { name: 'Titulares' });
        fireEvent.click(screen.getByRole('button', { name: '1A' }));
        fireEvent.change(screen.getByLabelText('Buscar titulares'), { target: { value: 'capex' } });
        expect(screen.getAllByRole('listitem').map((l) => l.textContent)).toEqual([expect.stringContaining('Capex rises')]);
        expect(screen.getByText('1 artículo')).toBeTruthy();
        fireEvent.change(screen.getByLabelText('Buscar titulares'), { target: { value: 'zzz' } });
        expect(screen.getByText('Ningún titular coincide con la búsqueda.')).toBeTruthy();
    });

    it('failed request shows an error', async () => {
        vi.mocked(fetchNewsSentiment).mockResolvedValue(null);
        render(<NewsTab ticker="ACME" load={noCache} />);
        expect(await screen.findByText('No se pudieron cargar las noticias.')).toBeTruthy();
    });
});

describe('Técnico (S15)', () => {
    it('reuses the technical summary card and the opt-in TradingView widgets', async () => {
        vi.mocked(fetchTechnicalAnalysis).mockResolvedValue({ ticker: 'ACME' } as never);
        render(<TechnicalTab stock={stock} load={noCache} />);
        expect(await screen.findByTestId('ta-card')).toBeTruthy();
        expect(fetchTechnicalAnalysis).toHaveBeenCalledWith('ACME');
        expect(screen.queryByTestId('tv-advanced-chart')).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: /TradingView \(público, sin cuenta\)/ }));
        expect(screen.getByTestId('tv-advanced-chart').textContent).toBe('ACME');
        expect(screen.getByTestId('tv-symbol-overview')).toBeTruthy();
    });

    it('without technical data shows an empty state', async () => {
        vi.mocked(fetchTechnicalAnalysis).mockResolvedValue(null);
        render(<TechnicalTab stock={stock} load={noCache} />);
        await waitFor(() => expect(screen.getByText('Sin análisis técnico disponible para este valor.')).toBeTruthy());
    });
});
