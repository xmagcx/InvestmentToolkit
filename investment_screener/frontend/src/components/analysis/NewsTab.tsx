/**
 * NewsTab.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Tab Noticias (S14): sentiment table (Positivas / Neutrales / Negativas × 1M/3M/6M/1A) with stacked bars, coverage
 *     and stale notes, then the headline list filtered by the period selector and a live title search. Label = symbol + text.
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <NewsTab ticker="MSFT" load={load} />
 */
import { useState } from 'react';
import { fetchNewsSentiment, type NewsSentiment, type NewsSentimentLabel, type NewsSentimentPeriod } from '../../services/api';
import { fmtGroupedEs, fmtNumEs } from '../../utils/analysisFormat';
import { Empty, Loading, Note, Pill, SectionTitle, Seg, TABLE_WRAP } from './tabUi';
import { useResource, type Loader } from './useResource';

const PERIODS: Array<{ value: NewsSentimentPeriod; text: string; days: number }> = [
    { value: '1M', text: '1M', days: 30 }, { value: '3M', text: '3M', days: 91 }, { value: '6M', text: '6M', days: 182 }, { value: '1Y', text: '1A', days: 365 },
];
const LABEL: Record<NewsSentimentLabel, { text: string; tone: string }> = {
    positive: { text: '▲ Positiva', tone: 'text-emerald-400' }, neutral: { text: '● Neutral', tone: 'text-slate-300' }, negative: { text: '▼ Negativa', tone: 'text-red-400' },
};

function SentimentBar({ period, c }: { period: string; c: Record<NewsSentimentLabel, number> }) {
    const t = c.positive + c.neutral + c.negative;
    if (t === 0) return <div role="img" aria-label={`${period}: sin artículos`} className="h-3 rounded bg-slate-800" />;
    const w = (x: number) => (x / t) * 100;
    return (
        <div role="img" aria-label={`${period}: ${fmtNumEs(w(c.positive))}% positivas, ${fmtNumEs(w(c.neutral))}% neutrales, ${fmtNumEs(w(c.negative))}% negativas`} className="flex h-3 rounded overflow-hidden">
            <i style={{ width: `${w(c.positive)}%`, background: '#34d399' }} /><i style={{ width: `${w(c.neutral)}%`, background: '#475569' }} /><i style={{ width: `${w(c.negative)}%`, background: '#f87171' }} />
        </div>
    );
}

export function NewsTab({ ticker, load }: { ticker: string; load: Loader }) {
    const { loading, data } = useResource<NewsSentiment>(load, `news:${ticker}`, () => fetchNewsSentiment(ticker));
    const [period, setPeriod] = useState<NewsSentimentPeriod>('1M');
    const [query, setQuery] = useState('');
    const [now] = useState(() => Date.now());
    if (loading) return <Loading>Cargando noticias…</Loading>;
    if (!data) return <Empty>No se pudieron cargar las noticias.</Empty>;
    const since = now - PERIODS.find((p) => p.value === period)!.days * 86_400_000;
    const q = query.trim().toLowerCase();
    const shown = data.articles.filter((a) => Date.parse(a.date) >= since && a.title.toLowerCase().includes(q));
    const row = (label: NewsSentimentLabel, name: string) => (
        <tr><th scope="row" className="px-4 py-2 text-left font-normal text-slate-300"><span className={LABEL[label].tone}>{LABEL[label].text.slice(0, 1)}</span> {name}</th>
            {PERIODS.map((p) => <td key={p.value} className="px-4 py-2 text-right font-mono">{fmtGroupedEs(data.periods[p.value][label])}</td>)}</tr>
    );
    return (
        <div className="grid lg:grid-cols-2 gap-6">
            <section aria-labelledby="h-sent">
                <h3 id="h-sent" className="text-lg font-semibold text-slate-100 mb-2">Sentimiento de las noticias</h3>
                <div className={TABLE_WRAP}>
                    <table aria-label="Sentimiento de las noticias" className="w-full text-sm">
                        <thead className="bg-slate-800 text-slate-400"><tr><th scope="col" className="px-4 py-2 text-left">Sentimiento</th>{PERIODS.map((p) => <th key={p.value} scope="col" className="px-4 py-2 text-right">{p.text}</th>)}</tr></thead>
                        <tbody className="divide-y divide-slate-700">{row('positive', 'Positivas')}{row('neutral', 'Neutrales')}{row('negative', 'Negativas')}</tbody>
                    </table>
                </div>
                <div className="mt-3 space-y-1.5">
                    {PERIODS.map((p) => <div key={p.value} className="flex items-center gap-3"><span className="font-mono text-xs text-slate-400 w-8">{p.text}</span><div className="flex-1"><SentimentBar period={p.text} c={data.periods[p.value]} /></div></div>)}
                </div>
                {data.coverage_since && <Note>Historial desde {data.coverage_since}</Note>}
                {data.stale && <Note>Datos guardados: finviz no respondió, se muestra el último historial disponible.</Note>}
                <Note>Titulares de finviz; sentimiento calculado con NLTK (VADER) sobre cada titular. Es una señal de contexto, no una razón de compra o venta.</Note>
            </section>
            <section aria-labelledby="h-news">
                <div className="flex justify-between items-baseline">
                    <SectionTitle><span id="h-news">Noticias</span></SectionTitle>
                    <span className="text-xs text-slate-400">{shown.length === 1 ? '1 artículo' : `${shown.length} artículos`}</span>
                </div>
                <div className="flex gap-2 mb-2">
                    <Seg<NewsSentimentPeriod> label="Periodo" value={period} onChange={setPeriod} options={PERIODS.map(({ value, text }) => ({ value, text }))} />
                    <input type="search" aria-label="Buscar titulares" placeholder="Buscar en titulares…" value={query} onChange={(e) => setQuery(e.target.value)}
                        className="flex-1 bg-slate-900 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder:text-slate-500" />
                </div>
                <ul aria-label="Titulares" aria-live="polite" className="max-h-[420px] overflow-auto">
                    {shown.length === 0 && <li className="text-sm text-slate-400 py-2">Ningún titular coincide con la búsqueda.</li>}
                    {shown.map((a) => (
                        <li key={a.url} className="flex items-start justify-between gap-3 py-2 border-b border-slate-800">
                            <div>
                                <a href={a.url} target="_blank" rel="noopener noreferrer" className="text-sm font-semibold text-slate-200 hover:text-primary">{a.title}</a>
                                <small className="block text-xs text-slate-400"><span className="font-mono">{ticker}</span> · {a.date} · {a.source}</small>
                            </div>
                            <Pill tone={LABEL[a.sentiment].tone}>{LABEL[a.sentiment].text}</Pill>
                        </li>
                    ))}
                </ul>
            </section>
        </div>
    );
}
