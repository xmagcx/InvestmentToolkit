/**
 * PortfolioSummaryPage.tsx (React Page)
 * =====================================
 *
 * Purpose:
 *     Redesigned portfolio summary (specs S1/S2, artboard "01 Total primero"):
 *     the consolidated total in USD comes first with the FX rates actually used,
 *     then the KPI row (invertido, P/L no realizado, caja, acciones), the 1D/1S/1M/3M
 *     performance of that total, one card per profile in ITS base currency (no CAD
 *     unless a profile is CAD) and the strategy allocation, collapsed and fetched
 *     only when opened. An unpriced ticker is listed and excluded from value; a
 *     currency without an FX rate makes the total explicitly partial.
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <PortfolioSummaryPage />
 *
 * Key Functions:
 *     - PortfolioSummaryPage() - loads the summary + performance, lazy-loads allocation
 *     - PeriodCard() - one 1D/1S/1M/3M performance card of the USD total
 *     - fxLine() - "1 USD = 948,20 CLP · tradingview, 14:32"
 */
import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronRight, RefreshCw } from 'lucide-react';
import {
    fetchProfilesSummary,
    fetchPortfolioPerformance,
    fetchStrategyAllocation,
    refreshPrices,
    type ProfilesSummary,
    type PortfolioPerformance,
    type StrategyAllocation,
} from '../services/api';
import StrategyAllocationChart from '../components/StrategyAllocationChart';
import ProfileCard from '../components/summary/ProfileCard';
import { deltaClass, fmtAmount, fmtMoney, fmtPct, fmtSigned, timeAgo } from '../components/summary/format';
import { usePrivacy } from '../context/PrivacyContext';

const PERIODS: Array<{ key: keyof PortfolioPerformance; label: string }> = [
    { key: '1d', label: '1D' },
    { key: '1w', label: '1S' },
    { key: '1m', label: '1M' },
    { key: '3m', label: '3M' },
];

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

function Kpi({ label, value, caption, valueClass = 'text-slate-100' }: {
    label: string; value: string; caption: string; valueClass?: string;
}) {
    return (
        <div className="bg-slate-900 border border-slate-800 rounded-lg px-3 py-2.5">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400">{label}</span>
            <div className={`font-mono text-xl font-bold mt-1 ${valueClass}`}>{value}</div>
            <div className="font-mono text-xs text-slate-400 mt-0.5">{caption}</div>
        </div>
    );
}

function PeriodCard({ label, perf }: { label: string; perf: { change: number; changePct: number } | null }) {
    return (
        <div className="bg-slate-900/80 border border-slate-800 rounded-xl px-4 py-3 shadow-lg flex items-center gap-4">
            <span className="text-xs font-bold uppercase tracking-widest text-slate-400 w-7 shrink-0">{label}</span>
            {perf ? (
                <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
                    <span className={`font-mono text-xl font-bold whitespace-nowrap ${deltaClass(perf.change)}`}>{fmtPct(perf.changePct)}</span>
                    <span className={`font-mono text-sm font-semibold whitespace-nowrap ${deltaClass(perf.change)}`}>
                        {fmtSigned(perf.change, 'USD')}
                    </span>
                </div>
            ) : (
                <span className="text-sm text-slate-400">Sin datos</span>
            )}
        </div>
    );
}

export default function PortfolioSummaryPage() {
    const { isPrivacyMode } = usePrivacy();
    const [summary, setSummary] = useState<ProfilesSummary | null>(null);
    const [perf, setPerf] = useState<PortfolioPerformance | null>(null);
    const [allocation, setAllocation] = useState<StrategyAllocation | null>(null);
    const [allocOpen, setAllocOpen] = useState(false);
    const [allocLoading, setAllocLoading] = useState(false);
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

    function openAllocation() {
        const next = !allocOpen;
        setAllocOpen(next);
        if (!next || allocation || allocLoading) return;
        setAllocLoading(true);
        fetchStrategyAllocation()
            .then(setAllocation)
            .catch(() => setAllocation(null))
            .finally(() => setAllocLoading(false));
    }

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

    const header = (
        <div className="flex items-start justify-between gap-4">
            <div>
                <h1 className="text-xl font-bold text-white mb-0.5">Resumen de portafolio</h1>
                <p className="text-sm text-slate-400">Cada perfil en su moneda base · total consolidado en USD</p>
            </div>
            <div className="flex items-center gap-3">
                <p className="text-xs text-slate-400" role="status">
                    Precios actualizados {timeAgo(summary?.lastPriceAt)}
                </p>
                <button
                    type="button"
                    onClick={onRefresh}
                    disabled={refreshing}
                    className="min-h-11 px-4 rounded bg-zinc-800 text-zinc-300 text-xs font-semibold hover:bg-zinc-700 disabled:opacity-50 flex items-center gap-2"
                >
                    <RefreshCw size={14} aria-hidden="true" className={refreshing ? 'animate-spin' : ''} />
                    {refreshing ? 'Actualizando…' : 'Actualizar precios'}
                </button>
            </div>
        </div>
    );

    const note = refreshNote && (
        <p className={`text-xs ${refreshNote.ok ? 'text-emerald-400' : 'text-amber-400'}`} role="status">
            {refreshNote.text}
        </p>
    );

    if (loading && !summary) {
        return (
            <div className="p-4 h-full space-y-4">
                {header}
                <div className="h-40 bg-slate-900/80 border border-slate-800 rounded-xl animate-pulse" />
                <p className="text-sm text-slate-400">Cargando resumen…</p>
            </div>
        );
    }

    if (error || !summary) {
        return (
            <div className="p-4 h-full space-y-4">
                {header}
                <p className="text-sm text-red-400" role="alert">{error ?? 'No hay datos disponibles.'}</p>
            </div>
        );
    }

    const { totals, profiles } = summary;

    if (profiles.length === 0) {
        return (
            <div className="p-4 h-full space-y-4">
                {header}
                {note}
                <p className="text-sm text-slate-400">
                    Aún no hay perfiles de portafolio. Crea uno en la página Portafolio para ver el resumen.
                </p>
            </div>
        );
    }

    const today = perf?.['1d'] ?? null;
    const pricedCount = profiles.reduce((s, p) => s + p.pricedCount, 0);
    const unpricedCount = profiles.reduce((s, p) => s + p.unpricedCount, 0);
    const cashBreakdown = profiles.map(p => fmtMoney(p.cash, p.currency, isPrivacyMode)).join(' + ');

    return (
        <div className="p-4 h-full space-y-4 overflow-y-auto">
            {header}
            {note}

            {/* Hero: the consolidated USD total first, with the FX rates it used. */}
            <section className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-lg grid gap-6 lg:grid-cols-[1fr_420px] lg:items-center" aria-labelledby="total-consolidado">
                <div>
                    <h2 id="total-consolidado" className="text-xs font-bold uppercase tracking-widest text-slate-400">
                        Valor total consolidado
                    </h2>
                    <p className="my-1.5">
                        <span className="font-mono text-5xl font-bold text-white">{fmtAmount(totals.valueUsd, 'USD', isPrivacyMode)}</span>
                        <span className="font-mono text-2xl text-slate-400 ml-2">USD</span>
                    </p>
                    <p className="text-sm text-slate-400">
                        {today && (
                            <>
                                Hoy <b className={`font-mono ${deltaClass(today.change)}`}>{fmtSigned(today.change, 'USD')}</b>{' '}
                                <b className={`font-mono ${deltaClass(today.change)}`}>({fmtPct(today.changePct)})</b> ·{' '}
                            </>
                        )}
                        {pricedCount} {pricedCount === 1 ? 'posición' : 'posiciones'} con precio
                        {unpricedCount > 0 ? `, ${unpricedCount} sin precio` : ''}
                    </p>
                    {summary.fx.map(rate => (
                        <p key={rate.currency} className="mt-2 text-xs text-slate-400">{fxLine(rate)}</p>
                    ))}
                    {(totals.partial || summary.fxUnavailable.length > 0) && (
                        <p className="mt-2 text-xs text-amber-400 flex items-center gap-1.5" role="status">
                            <AlertTriangle size={14} aria-hidden="true" />
                            Total parcial: sin tasa de cambio para {summary.fxUnavailable.join(', ') || 'una moneda'};
                            esos perfiles quedan fuera del total.
                        </p>
                    )}
                </div>
                <div className="grid grid-cols-2 gap-2.5">
                    <Kpi label="Invertido" value={fmtMoney(totals.investedUsd, 'USD', isPrivacyMode)} caption="costo de posiciones con precio" />
                    <Kpi
                        label="P/L no realizado"
                        value={fmtSigned(totals.unrealizedPnlUsd, 'USD', isPrivacyMode)}
                        caption={fmtPct(totals.unrealizedPnlPct)}
                        valueClass={deltaClass(totals.unrealizedPnlUsd)}
                    />
                    <Kpi label="Caja disponible" value={fmtMoney(totals.cashUsd, 'USD', isPrivacyMode)} caption={cashBreakdown} />
                    <Kpi
                        label="Acciones (mercado)"
                        value={fmtMoney(totals.marketValueUsd, 'USD', isPrivacyMode)}
                        caption={unpricedCount > 0 ? `excluye ${unpricedCount} sin precio` : 'todas las posiciones con precio'}
                    />
                </div>
            </section>

            <section className="grid grid-cols-2 md:grid-cols-4 gap-3" aria-label="Rendimiento del total consolidado en USD">
                {PERIODS.map(p => <PeriodCard key={p.key} label={p.label} perf={perf?.[p.key] ?? null} />)}
            </section>

            <section className="grid gap-3 lg:grid-cols-2" aria-label="Desglose por perfil">
                {profiles.map(profile => (
                    <ProfileCard
                        key={profile.accountId}
                        profile={profile}
                        sharePct={profile.valueUsd != null && totals.valueUsd > 0 ? (profile.valueUsd / totals.valueUsd) * 100 : null}
                    />
                ))}
            </section>

            {/* Collapsed by default; the allocation is only fetched when opened. */}
            <section className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-lg">
                <button
                    type="button"
                    onClick={openAllocation}
                    aria-expanded={allocOpen}
                    className="w-full min-h-11 flex items-center justify-between gap-3 text-left"
                >
                    <span className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-400">
                        <ChevronRight size={14} aria-hidden="true" className={allocOpen ? 'rotate-90 transition-transform' : 'transition-transform'} />
                        Asignación por estrategia
                    </span>
                    <span className="text-xs text-slate-400">base {fmtMoney(totals.valueUsd, 'USD', isPrivacyMode)}</span>
                </button>
                {allocOpen && (
                    allocLoading ? (
                        <p className="text-sm text-slate-400 py-6 text-center">Cargando asignación…</p>
                    ) : allocation && allocation.allocation.length > 0 ? (
                        <StrategyAllocationChart data={allocation.allocation} totalUSD={allocation.totalUSD} />
                    ) : (
                        <p className="text-sm text-slate-400 py-6 text-center">Sin datos de asignación.</p>
                    )
                )}
            </section>
        </div>
    );
}
