/**
 * ProfileCard.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     One portfolio profile in ITS base currency (spec S1): total value, equities,
 *     wallet cash and unrealized P/L, with the USD equivalent as a secondary line.
 *     Positions are collapsed by default (progressive disclosure) and an unpriced
 *     ticker is shown as "Sin precio", excluded from the value, never priced at cost.
 *
 * Layer: Frontend / UI / Components / Summary
 *
 * Usage Examples:
 *     <ProfileCard profile={profile} sharePct={40.3} />
 *
 * Key Functions:
 *     - ProfileCard() - the card plus its collapsible positions table
 */
import { useState } from 'react';
import { ChevronRight, AlertTriangle } from 'lucide-react';
import type { ProfileSummary } from '../../services/api';
import { usePrivacy } from '../../context/PrivacyContext';
import { deltaClass, fmtAmount, fmtMoney, fmtPct, fmtSigned } from './format';

export default function ProfileCard({ profile, sharePct }: { profile: ProfileSummary; sharePct: number | null }) {
    const [open, setOpen] = useState(false);
    const { isPrivacyMode } = usePrivacy();
    const cur = profile.currency;
    const total = profile.marketValue + profile.cash;
    const count = profile.positions.length;

    return (
        <article className="bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-lg">
            <div className="flex items-baseline justify-between gap-3">
                <h3 className="text-lg font-semibold text-slate-100">{profile.name}</h3>
                <span className="text-[11px] font-bold tracking-widest text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded px-2 py-0.5">
                    {cur}
                </span>
            </div>

            <p className="font-mono text-3xl font-bold text-white mt-2.5 mb-0.5">
                <span>{fmtAmount(total, cur, isPrivacyMode)}</span> <span className="text-base text-slate-400">{cur}</span>
            </p>
            <p className="font-mono text-xs text-slate-400">
                {profile.valueUsd == null
                    ? 'Sin tasa de cambio'
                    : `${fmtMoney(profile.valueUsd, 'USD', isPrivacyMode)}${sharePct != null ? ` · ${sharePct.toLocaleString('es-CL', { maximumFractionDigits: 1 })} % del total` : ''}`}
            </p>

            <div className="mt-2 space-y-0.5">
                <div className="flex justify-between text-sm py-1">
                    <span className="text-slate-400">Acciones</span>
                    <span className="font-mono font-semibold text-slate-300">{fmtMoney(profile.marketValue, cur, isPrivacyMode)}</span>
                </div>
                <div className="flex justify-between text-sm py-1">
                    <span className="text-slate-400">Caja</span>
                    <span className="font-mono font-semibold text-slate-300">{fmtMoney(profile.cash, cur, isPrivacyMode)}</span>
                </div>
                <div className="flex justify-between text-sm py-1">
                    <span className="text-slate-400">P/L no realizado</span>
                    <span className={`font-mono font-semibold ${deltaClass(profile.unrealizedPnl)}`}>
                        {`${fmtSigned(profile.unrealizedPnl, cur, isPrivacyMode)} (${fmtPct(profile.unrealizedPnlPct)})`}
                    </span>
                </div>
            </div>

            {profile.unpricedTickers.length > 0 && (
                <p className="mt-2 text-xs text-amber-400 flex items-center gap-1.5" role="status">
                    <AlertTriangle size={14} aria-hidden="true" />
                    {profile.unpricedTickers.join(', ')} sin precio: queda fuera del valor de mercado.
                </p>
            )}

            {count === 0 ? (
                <p className="mt-3 border-t border-slate-800 pt-3 text-sm text-slate-400">Sin posiciones todavía.</p>
            ) : (
                <div className="mt-2.5 border-t border-slate-800 pt-1.5">
                    <button
                        type="button"
                        onClick={() => setOpen(v => !v)}
                        aria-expanded={open}
                        className="w-full min-h-11 flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-slate-400 hover:text-slate-200"
                    >
                        <ChevronRight size={14} aria-hidden="true" className={open ? 'rotate-90 transition-transform' : 'transition-transform'} />
                        {open ? 'Ocultar posiciones' : `Ver ${count} ${count === 1 ? 'posición' : 'posiciones'}`}
                    </button>

                    {open && (
                        <div className="overflow-x-auto">
                            <table className="w-full text-[13px]">
                                <thead>
                                    <tr className="bg-slate-800 text-slate-400">
                                        <th scope="col" className="text-left font-semibold px-2 py-1.5">Ticker</th>
                                        <th scope="col" className="text-right font-semibold px-2 py-1.5">Cant.</th>
                                        <th scope="col" className="text-right font-semibold px-2 py-1.5">Costo prom.</th>
                                        <th scope="col" className="text-right font-semibold px-2 py-1.5">Precio</th>
                                        <th scope="col" className="text-right font-semibold px-2 py-1.5">Valor</th>
                                        <th scope="col" className="text-right font-semibold px-2 py-1.5">P/L</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {profile.positions.map(p => (
                                        <tr key={p.ticker} className="border-t border-slate-700 hover:bg-slate-800/40">
                                            <td className="px-2 py-1.5 font-mono text-slate-200">{p.ticker}</td>
                                            <td className="px-2 py-1.5 text-right font-mono text-slate-300">{fmtAmount(p.qty, cur, isPrivacyMode)}</td>
                                            <td className="px-2 py-1.5 text-right font-mono text-slate-300">{p.avgCost == null ? '—' : fmtAmount(p.avgCost, cur, isPrivacyMode)}</td>
                                            <td className={`px-2 py-1.5 text-right font-mono ${p.price == null ? 'text-slate-400' : 'text-slate-300'}`}>
                                                {p.price == null ? 'Sin precio' : fmtAmount(p.price, p.priceCurrency ?? cur, isPrivacyMode)}
                                            </td>
                                            <td className="px-2 py-1.5 text-right font-mono text-slate-300">{p.value == null ? '—' : fmtAmount(p.value, cur, isPrivacyMode)}</td>
                                            <td className={`px-2 py-1.5 text-right font-mono ${deltaClass(p.pnl)}`}>
                                                {p.pnl == null ? '—' : fmtSigned(p.pnl, cur, isPrivacyMode)}
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            )}
        </article>
    );
}
