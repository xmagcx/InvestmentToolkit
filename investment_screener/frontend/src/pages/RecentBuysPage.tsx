/**
 * RecentBuysPage.tsx (React Page)
 * =====================================
 *
 * Purpose:
 *     "Compras recientes" page (S6/S7): two tabs over the Dataroma data — superinvestor buys
 *     of one quarter (recent_buys_q) and insider purchases (recent_buys_insider) — each row
 *     flagged with whether the instrument is available in Racional (in_platform).
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <Route path="recent-buys" element={<RecentBuysPage />} />
 *
 * Key Functions:
 *     - RecentBuysPage() - tab shell
 *     - QuarterlyTab() - quarter selector + superinvestor buys table
 *     - InsidersTab() - min amount / relationship / 10% / days filters + insider table
 *     - PlatformBadge() - "Disponible en Racional" badge
 *     - TickerLink() - public TradingView symbol page in a new tab
 *
 * Key Input Dependencies:
 *     - services/sources.ts (GET /api/recent-buys/quarterly[/quarters], /api/recent-buys/insiders)
 */
import { useCallback, useEffect, useState } from 'react';
import { ShoppingCart, ExternalLink } from 'lucide-react';
import {
    fetchQuarters,
    fetchQuarterlyBuys,
    fetchInsiderBuys,
    tradingViewUrl,
    type QuarterlyBuyRow,
    type InsiderBuyRow,
} from '../services/sources';

const num = (value: number | null | undefined, digits = 2): string =>
    value === null || value === undefined ? '—' : value.toLocaleString('es-CL', { minimumFractionDigits: digits, maximumFractionDigits: digits });

function TickerLink({ ticker }: { ticker: string }) {
    return (
        <a href={tradingViewUrl(ticker)} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline font-mono">
            {ticker}
        </a>
    );
}

function PlatformBadge({ available }: { available: boolean }) {
    if (!available) return <span className="text-xs text-gray-600">—</span>;
    return (
        <span className="px-2 py-0.5 text-[11px] font-medium rounded-md border text-emerald-400 bg-emerald-400/10 border-emerald-400/20">
            Disponible en Racional
        </span>
    );
}

function QuarterlyTab() {
    const [quarters, setQuarters] = useState<string[]>([]);
    const [quarter, setQuarter] = useState<string>('');
    const [rows, setRows] = useState<QuarterlyBuyRow[]>([]);
    const [error, setError] = useState<string | null>(null);

    useEffect(() => {
        fetchQuarters().then(setQuarters).catch(err => setError((err as Error).message));
    }, []);

    useEffect(() => {
        fetchQuarterlyBuys(quarter ? { quarter } : {})
            .then(data => {
                setRows(data.rows);
                if (!quarter && data.quarter) setQuarter(data.quarter);
                setError(null);
            })
            .catch(err => setError((err as Error).message));
    }, [quarter]);

    return (
        <div>
            <div className="flex items-center gap-3 mb-4">
                <label htmlFor="quarter" className="text-sm text-gray-400">Trimestre</label>
                <select id="quarter" value={quarter} onChange={e => setQuarter(e.target.value)}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                    {quarters.map(q => <option key={q} value={q}>{q}</option>)}
                </select>
            </div>

            {error && <p className="text-sm text-red-400 mb-3" role="alert">{error}</p>}

            <div className="overflow-x-auto bg-[#1C1C1E] border border-white/5 rounded-2xl">
                <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-gray-500 border-b border-white/5">
                        <tr>
                            <th className="text-left px-4 py-3">Ticker</th>
                            <th className="text-left px-4 py-3">Acción</th>
                            <th className="text-right px-4 py-3">% cartera</th>
                            <th className="text-right px-4 py-3">Compras</th>
                            <th className="text-right px-4 py-3">Precio compra</th>
                            <th className="text-right px-4 py-3">Precio actual</th>
                            <th className="text-right px-4 py-3">Mín. 52s</th>
                            <th className="text-right px-4 py-3">% sobre mín.</th>
                            <th className="text-right px-4 py-3">Máx. 52s</th>
                            <th className="text-left px-4 py-3">Plataforma</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(row => (
                            <tr key={`${row.quarter}-${row.ticker}`} className="border-b border-white/5 last:border-0">
                                <td className="px-4 py-2"><TickerLink ticker={row.ticker} /></td>
                                <td className="px-4 py-2 text-gray-300">{row.company_name ?? '—'}</td>
                                <td className="px-4 py-2 text-right text-gray-300">{num(row.portfolio_pct)}</td>
                                <td className="px-4 py-2 text-right text-gray-300">{row.buys_count ?? '—'}</td>
                                <td className="px-4 py-2 text-right text-gray-300">{num(row.hold_price)}</td>
                                <td className="px-4 py-2 text-right text-gray-300">{num(row.current_price)}</td>
                                <td className="px-4 py-2 text-right text-gray-400">{num(row.low_52w)}</td>
                                <td className="px-4 py-2 text-right text-gray-400">{num(row.pct_above_low_52w, 1)}</td>
                                <td className="px-4 py-2 text-right text-gray-400">{num(row.high_52w)}</td>
                                <td className="px-4 py-2"><PlatformBadge available={row.in_platform} /></td>
                            </tr>
                        ))}
                        {rows.length === 0 && (
                            <tr><td colSpan={10} className="px-4 py-6 text-center text-gray-500">Sin compras registradas para este trimestre.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

function InsidersTab() {
    const [rows, setRows] = useState<InsiderBuyRow[]>([]);
    const [minAmount, setMinAmount] = useState('');
    const [relationship, setRelationship] = useState('');
    const [tenPctOnly, setTenPctOnly] = useState(false);
    const [days, setDays] = useState('30');
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        fetchInsiderBuys({
            minAmount: minAmount ? Number(minAmount) : undefined,
            relationship: relationship || undefined,
            tenPctOnly: tenPctOnly || undefined,
            days: days ? Number(days) : undefined,
        })
            .then(data => { setRows(data.rows); setError(null); })
            .catch(err => setError((err as Error).message));
    }, [minAmount, relationship, tenPctOnly, days]);

    useEffect(() => { load(); }, [load]);

    return (
        <div>
            <div className="flex flex-wrap items-center gap-3 mb-4">
                <label className="text-sm text-gray-400">Monto mínimo (USD)
                    <input type="number" value={minAmount} onChange={e => setMinAmount(e.target.value)} placeholder="0"
                        className="ml-2 w-32 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                </label>
                <label className="text-sm text-gray-400">Relación
                    <input type="text" value={relationship} onChange={e => setRelationship(e.target.value)} placeholder="Director, CEO…"
                        className="ml-2 w-40 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                </label>
                <label className="text-sm text-gray-400">Días
                    <input type="number" value={days} onChange={e => setDays(e.target.value)}
                        className="ml-2 w-24 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white" />
                </label>
                <label className="text-sm text-gray-400 flex items-center gap-2">
                    <input type="checkbox" checked={tenPctOnly} onChange={e => setTenPctOnly(e.target.checked)} />
                    Solo dueños 10%
                </label>
            </div>

            {error && <p className="text-sm text-red-400 mb-3" role="alert">{error}</p>}

            <div className="overflow-x-auto bg-[#1C1C1E] border border-white/5 rounded-2xl">
                <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-gray-500 border-b border-white/5">
                        <tr>
                            <th className="text-left px-4 py-3">Presentación</th>
                            <th className="text-left px-4 py-3">Ticker</th>
                            <th className="text-left px-4 py-3">Instrumento</th>
                            <th className="text-left px-4 py-3">Informante</th>
                            <th className="text-left px-4 py-3">Relación</th>
                            <th className="text-left px-4 py-3">Fecha operación</th>
                            <th className="text-left px-4 py-3">Tipo</th>
                            <th className="text-right px-4 py-3">Acciones</th>
                            <th className="text-right px-4 py-3">Precio</th>
                            <th className="text-right px-4 py-3">Monto</th>
                            <th className="text-left px-4 py-3">D/I</th>
                            <th className="text-left px-4 py-3">SEC</th>
                            <th className="text-left px-4 py-3">Plataforma</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(row => (
                            <tr key={`${row.filing_at}-${row.ticker}-${row.reporting_name}`} className="border-b border-white/5 last:border-0">
                                <td className="px-4 py-2 text-gray-400">{row.filing_at}</td>
                                <td className="px-4 py-2"><TickerLink ticker={row.ticker} /></td>
                                <td className="px-4 py-2 text-gray-300">{row.security_name ?? '—'}</td>
                                <td className="px-4 py-2 text-gray-300">{row.reporting_name ?? '—'}</td>
                                <td className="px-4 py-2 text-gray-400">{row.relationship ?? '—'}{row.is_ten_pct_owner ? ' · 10%' : ''}</td>
                                <td className="px-4 py-2 text-gray-400">{row.transaction_date ?? '—'}</td>
                                <td className="px-4 py-2 text-gray-400">{row.transaction_type ?? '—'}{row.is_amendment ? ' (4/A)' : ''}</td>
                                <td className="px-4 py-2 text-right text-gray-300">{row.shares ?? '—'}</td>
                                <td className="px-4 py-2 text-right text-gray-300">{num(row.price)}</td>
                                <td className="px-4 py-2 text-right text-gray-300">{num(row.amount, 0)}</td>
                                <td className="px-4 py-2 text-gray-400">{row.ownership_type ?? '—'}</td>
                                <td className="px-4 py-2">
                                    {row.filing_url
                                        ? <a href={row.filing_url} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline inline-flex items-center gap-1">Ver <ExternalLink className="w-3 h-3" /></a>
                                        : '—'}
                                </td>
                                <td className="px-4 py-2"><PlatformBadge available={row.in_platform} /></td>
                            </tr>
                        ))}
                        {rows.length === 0 && (
                            <tr><td colSpan={13} className="px-4 py-6 text-center text-gray-500">Sin compras de insiders para estos filtros.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

export default function RecentBuysPage() {
    const [tab, setTab] = useState<'quarterly' | 'insiders'>('quarterly');

    const tabClass = (active: boolean) =>
        `px-4 py-2 rounded-xl text-sm font-medium transition-colors ${active ? 'bg-indigo-600 text-white' : 'text-gray-400 hover:text-gray-200 hover:bg-slate-800'}`;

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                    <ShoppingCart className="w-8 h-8 text-indigo-400" />
                    Compras recientes
                </h1>
                <p className="text-gray-400 mt-2">Compras publicadas por superinversionistas e insiders (Dataroma).</p>
            </div>

            <div className="flex gap-2 mb-6">
                <button className={tabClass(tab === 'quarterly')} onClick={() => setTab('quarterly')}>Superinversores (trimestre)</button>
                <button className={tabClass(tab === 'insiders')} onClick={() => setTab('insiders')}>Insiders</button>
            </div>

            {tab === 'quarterly' ? <QuarterlyTab /> : <InsidersTab />}
        </div>
    );
}
