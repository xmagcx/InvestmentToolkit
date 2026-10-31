/**
 * PortfolioSummaryPage.tsx (React Page)
 * =====================================
 *
 * Purpose:
 *     Portfolio summary as an analyst table (specs S1/S2, artboard "03 Tabla de
 *     analista"). A header card carries the consolidated USD total with today's
 *     delta, the FX details actually used, the price stamp with the refresh action
 *     and the compact invertido / P/L / caja. Below it ONE table lists every
 *     profile in ITS base currency (no CAD unless a profile is CAD), expandable to
 *     its positions, with a warning row per profile that has unpriced tickers and a
 *     final "Total consolidado" row in USD. The right rail holds the 1D/1S/1M/3M
 *     performance of that total and the strategy allocation donut.
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <PortfolioSummaryPage />
 *
 * Key Functions:
 *     - PortfolioSummaryPage() - loads summary + performance + allocation
 *     - ProfileRows() - one profile row, its warning row and its position rows
 *     - fxLine() - "1 USD = 948,20 CLP · tradingview, 14:32"
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import {
    fetchProfilesSummary,
    fetchPortfolioPerformance,
    fetchStrategyAllocation,
    refreshPrices,
    type ProfileSummary,
    type ProfilesSummary,
    type PortfolioPerformance,
    type StrategyAllocation,
} from '../services/api';
import AllocationDonut from '../components/summary/AllocationDonut';
import { deltaClass, fmtAmount, fmtMoney, fmtPct, fmtSigned, timeAgo } from '../components/summary/format';
import { usePrivacy } from '../context/PrivacyContext';

const PERIODS: Array<{ key: keyof PortfolioPerformance; label: string }> = [
    { key: '1d', label: '1D' },
    { key: '1w', label: '1S' },
    { key: '1m', label: '1M' },
    { key: '3m', label: '3M' },
];

const COLUMNS = ['Cant.', 'Costo prom.', 'Precio', 'Acciones', 'Caja', 'Invertido', 'P/L', 'Valor perfil', 'En USD'];

/** FX rates keep 2 decimals even for zero-decimal currencies: 948,20 CLP, not 948. */
function fmtRate(value: number): string {
    return value.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function hhmm(iso: string): string {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return 'sin hora';
    return d.toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' });
}

function fxLine(rate: { currency: string; usdTo: number; source: string; asOf: string }): string {
    return `1 USD = ${fmtRate(rate.usdTo)} ${rate.currency} · ${rate.source}, ${hhmm(rate.asOf)}`;
}

/** Table cells carry no currency code (the column header and the badge say it). */
function fmtCell(value: number | null | undefined, currency: string, isPrivacy: boolean): string {
    if (value == null) return '—';
    return fmtAmount(value, currency, isPrivacy);
}

function fmtCellSigned(value: number | null | undefined, currency: string, isPrivacy: boolean): string {
    if (value == null) return '—';
    return `${value < 0 ? '−' : '+'}${fmtAmount(Math.abs(value), currency, isPrivacy)}`;
}

/** Share counts are not money: no forced decimals, fractional shares still readable. */
function fmtQty(qty: number, isPrivacy: boolean): string {
    if (isPrivacy) return '••••';
    return qty.toLocaleString('es-CL', { maximumFractionDigits: 4 });
}

function Num({ children, className = '' }: { children: React.ReactNode; className?: string }) {
    return <td className={`px-2 py-2 text-right font-mono whitespace-nowrap ${className}`}>{children}</td>;
}

function ProfileRows({ profile, open, onToggle }: { profile: ProfileSummary; open: boolean; onToggle: () => void }) {
    const { isPrivacyMode } = usePrivacy();
    const cur = profile.currency;
    const rowIds = profile.positions.map((_, i) => `pos-${profile.accountId}-${i}`);

    return (
        <>
            <tr className="border-t border-slate-700 bg-slate-800/35 hover:bg-slate-800/50">
                <td className="px-3 py-1 whitespace-nowrap">
                    <button
                        type="button"
                        onClick={onToggle}
                        aria-expanded={open}
                        aria-controls={rowIds.join(' ')}
                        className="min-h-11 inline-flex items-center gap-2 px-1 text-slate-400 hover:text-slate-200"
                    >
                        <ChevronRight size={14} aria-hidden="true" className={`transition-transform ${open ? 'rotate-90' : ''}`} />
                        <span className="font-semibold text-slate-100">{profile.name}</span>
                        <span className="text-[11px] font-bold tracking-widest text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-1.5 py-0.5">
                            {cur}
                        </span>
                    </button>
                </td>
                <Num className="text-slate-500">—</Num>
                <Num className="text-slate-500">—</Num>
                <Num className="text-slate-500">—</Num>
                <Num>{fmtCell(profile.marketValue, cur, isPrivacyMode)}</Num>
                <Num>{fmtCell(profile.cash, cur, isPrivacyMode)}</Num>
                <Num>{fmtCell(profile.invested, cur, isPrivacyMode)}</Num>
                <Num className={deltaClass(profile.unrealizedPnl)}>{fmtCellSigned(profile.unrealizedPnl, cur, isPrivacyMode)}</Num>
                <Num className="text-white font-bold">{fmtCell(profile.marketValue + profile.cash, cur, isPrivacyMode)}</Num>
                <Num>{fmtCell(profile.valueUsd, 'USD', isPrivacyMode)}</Num>
            </tr>

            {profile.unpricedCount > 0 && (
                <tr className="border-t border-slate-700 bg-slate-900/60">
                    <td colSpan={10} className="px-3 py-2 text-xs text-amber-400">
                        <AlertTriangle size={12} aria-hidden="true" className="inline mr-1.5 -mt-0.5" />
                        {profile.unpricedCount} de {profile.positions.length} posiciones sin precio
                        {' '}({profile.unpricedTickers.join(', ')}): queda fuera del valor de mercado y del P/L.
                    </td>
                </tr>
            )}

            {open && profile.positions.map((p, i) => {
                const invested = p.avgCost != null ? p.avgCost * p.qty : null;
                const valueUsd = p.value != null && profile.usdRate ? p.value / profile.usdRate : null;
                return (
                    <tr key={p.ticker} id={rowIds[i]} className="border-t border-slate-700 hover:bg-slate-800/40">
                        <td className="pl-9 pr-3 py-2 font-mono text-slate-200 whitespace-nowrap">{p.ticker}</td>
                        <Num>{fmtQty(p.qty, isPrivacyMode)}</Num>
                        <Num>{fmtCell(p.avgCost, cur, isPrivacyMode)}</Num>
                        <Num className={p.price == null ? 'text-amber-400' : ''}>
                            {p.price == null ? 'Sin precio' : fmtCell(p.price, cur, isPrivacyMode)}
                        </Num>
                        <Num>{fmtCell(p.value, cur, isPrivacyMode)}</Num>
                        <Num className="text-slate-500">—</Num>
                        <Num>{fmtCell(invested, cur, isPrivacyMode)}</Num>
                        <Num className={deltaClass(p.pnl)}>{fmtCellSigned(p.pnl, cur, isPrivacyMode)}</Num>
                        <Num>{fmtCell(p.value, cur, isPrivacyMode)}</Num>
                        <Num className="text-slate-400">{fmtCell(valueUsd, 'USD', isPrivacyMode)}</Num>
                    </tr>
                );
            })}
        </>
    );
}

export default function PortfolioSummaryPage() {
    const { isPrivacyMode } = usePrivacy();
    const [summary, setSummary] = useState<ProfilesSummary | null>(null);
    const [perf, setPerf] = useState<PortfolioPerformance | null>(null);
    const [allocation, setAllocation] = useState<StrategyAllocation | null>(null);
    const [openProfiles, setOpenProfiles] = useState<Record<string, boolean>>({});
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [refreshing, setRefreshing] = useState(false);
    const [refreshNote, setRefreshNote] = useState<{ text: string; ok: boolean } | null>(null);

    const load = useCallback(() => {
        setLoading(true);
        fetchProfilesSummary()
            .then(data => { setSummary(data); setError(null); })
            .catch(err => setError(err instanceof Error ? err.message : String(err)))
            .finally(() => setLoading(false));
        fetchPortfolioPerformance().then(setPerf).catch(() => setPerf(null));
    }, []);

    useEffect(() => { load(); }, [load]);

    useEffect(() => {
        fetchStrategyAllocation().then(setAllocation).catch(() => setAllocation(null));
    }, []);

    async function onRefresh() {
        setRefreshing(true);
        setRefreshNote(null);
        try {
            const result = await refreshPrices();
            const missing = result.missingPrices ?? [];
            setRefreshNote({
                text: `${result.updated} precios actualizados`
                    + (missing.length ? ` · sin cotización: ${missing.join(', ')}` : ''),
                ok: result.success && missing.length === 0,
            });
        } catch (e) {
            setRefreshNote({ text: `No se pudieron actualizar los precios: ${e instanceof Error ? e.message : String(e)}`, ok: false });
        } finally {
            setRefreshing(false);
            load();
        }
    }

    const today = perf?.['1d'] ?? null;
    const totals = summary?.totals;
    const profiles = summary?.profiles ?? [];
    /** The first profile is expanded by default; the rest stay collapsed. */
    const isOpen = (p: ProfileSummary, index: number) => openProfiles[p.accountId] ?? index === 0;

    const refreshControls = (
        <div className="text-right shrink-0">
            <p className="text-xs text-slate-400" role="status">
                Precios actualizados {timeAgo(summary?.lastPriceAt)}
            </p>
            <button
                type="button"
                onClick={onRefresh}
                disabled={refreshing}
                className="mt-2 min-h-11 px-4 rounded bg-zinc-800 text-zinc-300 text-xs font-semibold hover:bg-zinc-700 disabled:opacity-50 inline-flex items-center gap-2"
            >
                <RefreshCw size={14} aria-hidden="true" className={refreshing ? 'animate-spin' : ''} />
                {refreshing ? 'Actualizando…' : 'Actualizar precios'}
            </button>
            {refreshNote && (
                <p className={`mt-2 text-xs ${refreshNote.ok ? 'text-emerald-400' : 'text-amber-400'}`} role="status">
                    {refreshNote.text}
                </p>
            )}
        </div>
    );

    const headerCard = (
        <section
            aria-labelledby="summary-title"
            className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-lg flex items-start justify-between gap-4 flex-wrap"
        >
            <div className="min-w-0">
                <h1 id="summary-title" className="text-xl font-bold text-white mb-0.5">Resumen de portafolio</h1>
                <p className="text-sm text-slate-400">Cada perfil en su moneda base · total consolidado en USD</p>
                {totals && (
                    <>
                        <p className="flex items-baseline gap-3 mt-2 flex-wrap">
                            <span className="font-mono text-4xl font-bold text-white">{fmtAmount(totals.valueUsd, 'USD', isPrivacyMode)}</span>
                            <span className="text-base text-slate-400">USD</span>
                            {today && (
                                <span className={`font-mono text-sm font-semibold ${deltaClass(today.change)}`}>
                                    {fmtCellSigned(today.change, 'USD', isPrivacyMode)} ({fmtPct(today.changePct)}) hoy
                                </span>
                            )}
                        </p>
                        {summary && summary.fx.length > 0 && (
                            <details className="mt-1">
                                <summary className="cursor-pointer text-xs text-slate-400 hover:text-slate-200 min-h-11 flex items-center">
                                    {summary.fx.map(fxLine).join(' · ')}
                                </summary>
                                <div className="text-xs text-slate-300 leading-relaxed border-l-2 border-slate-800 pl-2.5 ml-1">
                                    {profiles
                                        .filter(p => p.currency.toUpperCase() !== 'USD' && p.usdRate && p.valueUsd != null)
                                        .map(p => (
                                            <p key={p.accountId}>
                                                {p.name}: {fmtAmount(p.marketValue + p.cash, p.currency, isPrivacyMode)} {p.currency} ÷{' '}
                                                {fmtRate(p.usdRate as number)} = {fmtMoney(p.valueUsd, 'USD', isPrivacyMode)}.
                                            </p>
                                        ))}
                                    <p>Solo los perfiles cuya moneda base no es USD se convierten.</p>
                                </div>
                            </details>
                        )}
                        {(totals.partial || (summary?.fxUnavailable.length ?? 0) > 0) && (
                            <p className="mt-2 text-xs text-amber-400 flex items-center gap-1.5" role="status">
                                <AlertTriangle size={14} aria-hidden="true" />
                                Total parcial: sin tasa de cambio para {summary?.fxUnavailable.join(', ') || 'una moneda'};
                                esos perfiles quedan fuera del total.
                            </p>
                        )}
                    </>
                )}
            </div>
            <div className="flex flex-col items-end gap-3 text-right">
                {refreshControls}
                {totals && (
                    <div className="space-y-2">
                        <div>
                            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Invertido</span>
                            <div className="font-mono text-base font-semibold text-slate-200">{fmtMoney(totals.investedUsd, 'USD', isPrivacyMode)}</div>
                        </div>
                        <div>
                            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">P/L no realizado</span>
                            <div className={`font-mono text-base font-semibold ${deltaClass(totals.unrealizedPnlUsd)}`}>
                                {fmtSigned(totals.unrealizedPnlUsd, 'USD', isPrivacyMode)} ({fmtPct(totals.unrealizedPnlPct)})
                            </div>
                        </div>
                        <div>
                            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Caja</span>
                            <div className="font-mono text-base font-semibold text-slate-200">{fmtMoney(totals.cashUsd, 'USD', isPrivacyMode)}</div>
                        </div>
                    </div>
                )}
            </div>
        </section>
    );

    if (loading && !summary) {
        return (
            <div className="p-4 h-full space-y-4">
                {headerCard}
                <div className="h-40 bg-slate-900/80 border border-slate-800 rounded-xl animate-pulse" />
                <p className="text-sm text-slate-400">Cargando resumen…</p>
            </div>
        );
    }

    if (error || !summary || !totals) {
        return (
            <div className="p-4 h-full space-y-4">
                {headerCard}
                <p className="text-sm text-red-400" role="alert">{error ?? 'No hay datos disponibles.'}</p>
            </div>
        );
    }

    if (profiles.length === 0) {
        return (
            <div className="p-4 h-full space-y-4">
                {headerCard}
                <p className="text-sm text-slate-400">
                    Aún no hay perfiles de portafolio. Crea uno en la página Portafolio para ver el resumen.
                </p>
            </div>
        );
    }

    return (
        <div className="p-4 h-full overflow-y-auto grid gap-3.5 items-start lg:grid-cols-[minmax(0,1fr)_300px]">
            <div className="space-y-3.5 min-w-0">
                {headerCard}

                <div className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-900/80">
                    <table className="w-full text-xs">
                        <caption className="text-left px-3 py-2.5 text-xs text-slate-400">
                            Perfiles y sus posiciones · valores en la moneda base de cada perfil
                        </caption>
                        <thead>
                            <tr className="bg-slate-800 text-slate-400">
                                <th scope="col" className="px-3 py-2 text-left font-semibold whitespace-nowrap">Perfil / posición</th>
                                {COLUMNS.map(c => (
                                    <th key={c} scope="col" className="px-2 py-2 text-right font-semibold whitespace-nowrap">{c}</th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {profiles.map((profile, index) => (
                                <ProfileRows
                                    key={profile.accountId}
                                    profile={profile}
                                    open={isOpen(profile, index)}
                                    onToggle={() => setOpenProfiles(prev => ({
                                        ...prev,
                                        [profile.accountId]: !isOpen(profile, index),
                                    }))}
                                />
                            ))}
                            <tr className="border-t border-slate-700 bg-slate-800 text-white font-bold">
                                <td className="px-3 py-2.5 whitespace-nowrap">Total consolidado</td>
                                <Num>—</Num>
                                <Num>—</Num>
                                <Num>—</Num>
                                <Num>{fmtCell(totals.marketValueUsd, 'USD', isPrivacyMode)}</Num>
                                <Num>{fmtCell(totals.cashUsd, 'USD', isPrivacyMode)}</Num>
                                <Num>{fmtCell(totals.investedUsd, 'USD', isPrivacyMode)}</Num>
                                <Num className={deltaClass(totals.unrealizedPnlUsd)}>{fmtCellSigned(totals.unrealizedPnlUsd, 'USD', isPrivacyMode)}</Num>
                                <Num>—</Num>
                                <Num>{fmtCell(totals.valueUsd, 'USD', isPrivacyMode)}</Num>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>

            <aside className="space-y-3.5 min-w-0">
                <section aria-label="Rendimiento (USD)" className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-lg">
                    <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Rendimiento (USD)</span>
                    <div className="flex flex-col gap-2 mt-2.5">
                        {PERIODS.map(({ key, label }) => {
                            const p = perf?.[key] ?? null;
                            return (
                                <div key={key} className="flex items-center justify-between gap-2 bg-slate-900 border border-slate-800 rounded-lg px-3 py-2">
                                    <span className="text-xs font-bold uppercase tracking-widest text-slate-400">{label}</span>
                                    {p ? (
                                        <span className="flex items-baseline gap-2">
                                            <span className={`font-mono text-lg font-bold ${deltaClass(p.change)}`}>{fmtPct(p.changePct)}</span>
                                            <span className="font-mono text-xs text-slate-400">{fmtCellSigned(p.change, 'USD', isPrivacyMode)}</span>
                                        </span>
                                    ) : (
                                        <span className="text-sm text-slate-400">Sin datos</span>
                                    )}
                                </div>
                            );
                        })}
                        <p className="border border-dashed border-slate-700 rounded-lg px-3 py-2.5 text-xs text-slate-400 text-center">
                            YTD sin datos: el rendimiento se calcula sobre 1D, 1S, 1M y 3M.
                        </p>
                    </div>
                </section>

                <section aria-label="Asignación por estrategia" className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-lg">
                    <span className="text-xs font-bold uppercase tracking-widest text-slate-400">Asignación por estrategia</span>
                    <AllocationDonut items={allocation?.allocation ?? []} />
                </section>
            </aside>
        </div>
    );
}
