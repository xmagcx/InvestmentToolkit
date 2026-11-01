/**
 * SentimentBlock.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     The "Sentimiento" block of an expanded opportunity row (S13): the market's Fear & Greed as
 *     a small banner and the ticker's headline sentiment with its five latest news links. It is
 *     fetched lazily the first time the row is opened and cached per ticker for the session; a
 *     part the backend could not read is shown as "No disponible ahora", never invented.
 *
 * Layer: Frontend / UI / Opportunities
 *
 * Usage Examples:
 *     <SentimentBlock ticker="TMO" />
 *
 * Key Input Dependencies:
 *     - services/opportunities.ts (fetchSentiment, GET /api/sentiment/:ticker)
 */
import { useEffect, useState } from 'react';
import Verdict from './Verdict';
import { num } from './format';
import { sentimentCache as cache } from './sentimentCache';
import { fetchSentiment, type SentimentResponse } from '../../services/opportunities';

const TONES = { Positivo: 'ok', Neutral: 'mid', Negativo: 'bad' } as const;

function headlineDate(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return iso;
    return date.toLocaleDateString('es-CL', { day: '2-digit', month: 'short' });
}

function Missing() {
    return <p className="text-xs text-slate-400">No disponible ahora</p>;
}

export default function SentimentBlock({ ticker }: { ticker: string }) {
    const [data, setData] = useState<SentimentResponse | null>(() => cache.get(ticker) ?? null);
    const [loading, setLoading] = useState(!cache.has(ticker));

    // One read per ticker per session; the row is remounted on every expand, so the cached
    // answer is taken by the state initializer above and the effect does nothing.
    useEffect(() => {
        if (cache.has(ticker)) return;
        let cancelled = false;
        fetchSentiment(ticker)
            .then(response => {
                cache.set(ticker, response);
                if (!cancelled) setData(response);
            })
            .catch(() => {
                if (!cancelled) setData({ market: null, ticker: null });
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [ticker]);

    const market = data?.market ?? null;
    const news = data?.ticker ?? null;

    return (
        <section className="mt-3">
            <h4 className="mb-2 text-[13px] font-semibold text-slate-100">Sentimiento</h4>
            {loading ? (
                <p role="status" className="text-xs text-slate-400">Leyendo noticias…</p>
            ) : (
                <>
                    {market ? (
                        <div className="mb-2 rounded-lg border border-slate-700 bg-slate-800/60 px-2.5 py-2">
                            <p className="flex items-baseline gap-2 text-xs text-slate-300">
                                <span className="font-mono text-base font-bold text-amber-400">{market.score}</span>
                                <b className="text-white">{market.rating}</b>
                                <span className="text-[11px] text-slate-400">miedo y codicia del mercado (0–100)</span>
                            </p>
                            <span aria-hidden="true" className="my-1 block h-1.5 w-full rounded-full bg-slate-700">
                                <span
                                    className="block h-1.5 rounded-full bg-amber-400"
                                    style={{ width: `${Math.max(0, Math.min(100, market.score))}%` }}
                                />
                            </span>
                            <p className="text-xs leading-relaxed text-slate-300">{market.label}</p>
                        </div>
                    ) : (
                        <Missing />
                    )}

                    {news ? (
                        <>
                            <p className="mb-1.5 flex items-center gap-2 text-xs text-slate-300">
                                <Verdict tone={TONES[news.label]}>{news.label}</Verdict>
                                <span className="font-mono text-slate-200">{num(news.score, 2)}</span>
                                <span className="text-[11px] text-slate-400">en sus titulares recientes</span>
                            </p>
                            <ul className="flex flex-col gap-1">
                                {news.headlines.slice(0, 5).map(headline => (
                                    <li key={headline.url} className="text-xs leading-snug">
                                        <a
                                            href={headline.url}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            className="text-slate-200 underline hover:text-amber-400"
                                        >
                                            {headline.title}
                                        </a>
                                        <span className="text-[11px] text-slate-400">
                                            {' '}· {headline.publisher} · {headlineDate(headline.publishedAt)}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        </>
                    ) : (
                        <Missing />
                    )}
                </>
            )}
            <p className="mt-2 text-[11px] leading-snug text-slate-400">
                El sentimiento es informativo: no suma estrellas ni filtra.
            </p>
        </section>
    );
}
