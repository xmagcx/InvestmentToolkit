/**
 * MonteCarloTab.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Tab Monte Carlo (S13): histogram of simulated fair values (red bars below the price, green above), P10/P50/P90 and
 *     price marks (price label sits one row lower so it never overlaps P50), stats, reading and the bear/base/bull assumptions.
 *     null (no saved projection) → explanatory empty state.
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <MonteCarloTab ticker="MSFT" company="Microsoft" load={load} />
 */
import { fetchMonteCarlo, type MonteCarloData } from '../../services/api';
import { fmtGroupedEs, fmtNumEs, fmtPctEs } from '../../utils/analysisFormat';
import { Empty, Loading, SectionTitle, TH } from './tabUi';
import { useResource, type Loader } from './useResource';

const money = (v: number) => fmtGroupedEs(v, 2);

function Histogram({ d }: { d: MonteCarloData }) {
    const { bins, counts } = d.result.histogram;
    const W = 760, H = 240, L = 40, R = 16, T = 24, B = 34;
    const lo = bins[0], hi = bins[bins.length - 1], mx = Math.max(...counts, 1);
    const X = (v: number) => L + ((v - lo) / (hi - lo)) * (W - L - R);
    const Y = (n: number) => T + (1 - n / mx) * (H - T - B);
    const bw = (W - L - R) / counts.length;
    const r = d.result;
    const mark = (id: string, v: number, text: string, color: string, row: 0 | 1) => (
        <g key={id}>
            <line x1={X(v)} x2={X(v)} y1={T - 6} y2={H - B} stroke={color} strokeWidth={2} strokeDasharray={id === 'price' ? undefined : '4 3'} />
            <text data-testid={`mc-label-${id}`} x={row ? X(v) - 6 : X(v)} y={T - 10 + row * 14} fill={color} fontSize={11} textAnchor={row ? 'end' : 'middle'}>{text}</text>
        </g>
    );
    const ticks = [0, 1, 2, 3, 4, 5, 6].map((i) => lo + ((hi - lo) * i) / 6);
    const label = `Distribución de ${fmtGroupedEs(r.n)} valores justos simulados entre ${fmtNumEs(r.min, 0)} y ${fmtNumEs(r.max, 0)}. Mediana ${fmtNumEs(r.p50, 0)}. Precio actual ${fmtNumEs(d.price, 2)}. ${fmtPctEs(r.probabilityOvervalued * 100)} de las simulaciones quedan por debajo del precio.`;
    return (
        <svg data-testid="mc-histogram" viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label={label}>
            <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke="#334155" />
            {counts.map((n, k) => (
                <rect key={bins[k]} data-testid="mc-bar" x={X(bins[k]) + 1} y={Y(n)} width={bw - 2} height={H - B - Y(n)} fill={bins[k + 1] <= d.price ? '#f87171' : '#34d399'} opacity={0.75}>
                    <title>{`${fmtNumEs(bins[k], 0)}–${fmtNumEs(bins[k + 1], 0)}: ${fmtGroupedEs(n)} simulaciones`}</title>
                </rect>
            ))}
            {ticks.map((v) => <text key={v} x={X(v)} y={H - 14} fill="#94a3b8" fontSize={11} textAnchor="middle">{fmtNumEs(v, 0)}</text>)}
            {mark('p10', r.p10, `P10 ${fmtNumEs(r.p10, 0)}`, '#94a3b8', 0)}
            {mark('p90', r.p90, `P90 ${fmtNumEs(r.p90, 0)}`, '#94a3b8', 0)}
            {mark('p50', r.p50, `P50 ${fmtNumEs(r.p50, 0)}`, '#fbbf24', 0)}
            {mark('price', d.price, `Precio ${fmtNumEs(d.price, 2)}`, '#e2e8f0', 1)}
        </svg>
    );
}

export function MonteCarloTab({ ticker, company, load }: { ticker: string; company: string; load: Loader }) {
    const { loading, data } = useResource<MonteCarloData>(load, `mc:${ticker}`, () => fetchMonteCarlo(ticker));
    if (loading) return <Loading>Simulando…</Loading>;
    if (!data) return <Empty>Sin proyección guardada: la simulación necesita los escenarios de una proyección.</Empty>;
    const r = data.result;
    const stat = (k: string, v: string, tone = '') => <div className="flex justify-between py-1.5 border-b border-slate-800 text-sm"><span className="text-slate-400">{k}</span><b className={`font-mono ${tone}`}>{v}</b></div>;
    const sc = data.scenarios;
    const arow = (k: string, f: (s: typeof sc.base) => string) => (
        <tr><th scope="row" className="px-3 py-1.5 text-left font-normal text-slate-300">{k}</th>{[sc.bear, sc.base, sc.bull].map((s, i) => <td key={i} className="px-3 py-1.5 text-right font-mono">{f(s)}</td>)}</tr>
    );
    return (
        <div>
            <div className="grid lg:grid-cols-[1fr_300px] gap-6">
                <section aria-label={`¿Cuánto podría valer ${company}?`}>
                    <SectionTitle>¿Cuánto podría valer {company}?</SectionTitle>
                    <p className="text-xs text-slate-400 mb-2"><span className="text-red-400">■</span> valor justo por debajo del precio · <span className="text-emerald-400">■</span> por encima</p>
                    <Histogram d={data} />
                    <p className="text-sm text-slate-200 mt-2">
                        En {Math.round(r.probabilityUndervalued * 100)} de cada 100 simulaciones el valor justo supera el precio actual; la mitad central está entre {money(r.p25)} y {money(r.p75)}.
                    </p>
                </section>
                <aside aria-label="Estadísticas de la simulación">
                    {stat('Probabilidad de que esté sobrevalorada', fmtPctEs(r.probabilityOvervalued * 100), 'text-amber-400')}
                    {stat('Probabilidad de que esté infravalorada', fmtPctEs(r.probabilityUndervalued * 100), 'text-emerald-400')}
                    {stat('Mediana (P50)', money(r.p50))}
                    {stat('Media', money(r.mean))}
                    {stat('Rango P10 – P90', `${money(r.p10)} – ${money(r.p90)}`)}
                    {stat('Rango intercuartil', `${money(r.p25)} – ${money(r.p75)}`)}
                    {stat('Mínimo – máximo', `${money(r.min)} – ${money(r.max)}`)}
                    {stat('Simulaciones', fmtGroupedEs(r.n))}
                </aside>
            </div>
            <details className="mt-4">
                <summary className="cursor-pointer text-sm text-slate-300">Supuestos simulados (bajista · base · alcista)</summary>
                <table className="mt-2 text-sm w-full max-w-xl">
                    <thead className="text-slate-400"><tr><th scope="col" className={TH}>Variable</th><th scope="col" className={`${TH} text-right`}>Bajista</th><th scope="col" className={`${TH} text-right`}>Base</th><th scope="col" className={`${TH} text-right`}>Alcista</th></tr></thead>
                    <tbody>
                        {arow('Crecimiento de ingresos', (s) => fmtPctEs(s.growthRate))}
                        {arow('Margen neto', (s) => fmtPctEs(s.netMargin))}
                        {arow('PER de salida', (s) => `${fmtNumEs(s.exitPE, 1)}x`)}
                        {arow('Valor por escenario', (s) => money(s.presentValue))}
                    </tbody>
                </table>
            </details>
        </div>
    );
}
