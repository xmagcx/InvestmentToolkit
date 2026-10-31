/**
 * PortfolioMaintainerPage.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     Manual portfolio maintenance ("Portafolio", Spanish UI): portfolio profiles
 *     (create / rename / delete), a per-profile wallet with deposits and
 *     withdrawals, the positions of the profile with buy / sell / delete actions,
 *     an "Agregar acción" (buy) form and the transaction history. Every write goes
 *     through the `/api/portfolio-maintainer` client in services/api.ts; each position
 *     carries its stored market price (null when unpriced — never its cost).
 *
 * Layer: Frontend / Pages / Portfolio Maintainer
 *
 * Key Functions:
 *     - PortfolioMaintainerPage() - profile selector, wallet card, positions table,
 *       add-stock form, history table and the create/rename/delete/trade dialogs.
 */
import { useState, useCallback, useEffect } from 'react';
import {
    fetchMaintainerAccounts,
    fetchMaintainerPositions,
    fetchMaintainerTransactions,
    createMaintainerAccount,
    updateMaintainerAccount,
    deleteMaintainerAccount,
    moveMaintainerCash,
    submitMaintainerTransaction,
    deleteMaintainerPosition,
} from '../services/api';
import type { MaintainerAccount, MaintainerPosition, MaintainerTransaction } from '../services/api';

type Dialog =
    | { kind: 'create' }
    | { kind: 'rename' }
    | { kind: 'deleteProfile'; force: boolean }
    | { kind: 'trade'; side: 'BUY' | 'SELL'; position: MaintainerPosition }
    | { kind: 'deletePosition'; position: MaintainerPosition }
    | null;

const money = (n: number | null | undefined) => (n == null ? '—' : n.toFixed(2));

export default function PortfolioMaintainerPage() {
    const [accounts, setAccounts] = useState<MaintainerAccount[]>([]);
    const [positions, setPositions] = useState<MaintainerPosition[]>([]);
    const [transactions, setTransactions] = useState<MaintainerTransaction[]>([]);
    const [selected, setSelected] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    const [dialog, setDialog] = useState<Dialog>(null);
    const [profileName, setProfileName] = useState('');
    const [profileCurrency, setProfileCurrency] = useState('USD');
    const [cashAmount, setCashAmount] = useState('');
    const [cashNote, setCashNote] = useState('');
    const [stock, setStock] = useState({ ticker: '', qty: '', price: '', commission: '' });
    const [trade, setTrade] = useState({ qty: '', price: '', commission: '' });

    const account = accounts.find(a => a.accountId === selected) ?? null;
    const accountPositions = positions.filter(p => p.accountId === selected);

    const refresh = useCallback(async (accountId?: string) => {
        try {
            setError(null);
            const [accts, poss] = await Promise.all([fetchMaintainerAccounts(), fetchMaintainerPositions()]);
            setAccounts(accts);
            setPositions(poss);
            const active = accountId && accts.some(a => a.accountId === accountId)
                ? accountId
                : accts[0]?.accountId ?? '';
            setSelected(active);
            setTransactions(active ? await fetchMaintainerTransactions(active) : []);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'No se pudo cargar el portafolio');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    /** Run one write, then reload; any API error becomes the visible message. */
    const act = async (fn: () => Promise<string>, keepAccount = selected) => {
        try {
            setError(null);
            setSuccess(null);
            const message = await fn();
            setSuccess(message);
            setDialog(null);
            await refresh(keepAccount);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'La operación falló');
        }
    };

    const selectProfile = async (accountId: string) => {
        setSelected(accountId);
        try {
            setTransactions(await fetchMaintainerTransactions(accountId));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'No se pudo cargar el historial');
        }
    };

    const handleCash = (direction: 'deposit' | 'withdraw') => {
        const amount = Number(cashAmount);
        if (!account) return;
        if (!Number.isFinite(amount) || amount <= 0) {
            setError('El monto debe ser un número positivo');
            return;
        }
        act(async () => {
            const res = await moveMaintainerCash(account.accountId, direction, amount, cashNote.trim() || undefined);
            setCashAmount('');
            setCashNote('');
            return `${direction === 'deposit' ? 'Depósito' : 'Retiro'} de ${amount.toFixed(2)} ${res.currency} · saldo ${res.cash.toFixed(2)}`;
        });
    };

    const handleAddStock = (e: React.FormEvent) => {
        e.preventDefault();
        if (!account) return;
        const qty = Number(stock.qty);
        const price = Number(stock.price);
        const commission = stock.commission === '' ? 0 : Number(stock.commission);
        if (!stock.ticker.trim() || !(qty > 0) || !(price > 0) || !(commission >= 0)) {
            setError('Completa ticker, cantidad (>0) y precio (>0)');
            return;
        }
        act(async () => {
            const result = await submitMaintainerTransaction({
                accountId: account.accountId,
                ticker: stock.ticker.trim().toUpperCase(),
                side: 'BUY',
                qty,
                price,
                commission,
            });
            setStock({ ticker: '', qty: '', price: '', commission: '' });
            return `Compra registrada · efectivo ${result.cash.toFixed(2)} ${result.currency}`;
        });
    };

    const handleTrade = () => {
        if (!dialog || dialog.kind !== 'trade' || !account) return;
        const qty = Number(trade.qty);
        const price = Number(trade.price);
        const commission = trade.commission === '' ? 0 : Number(trade.commission);
        if (!(qty > 0) || !(price > 0) || !(commission >= 0)) {
            setError('Cantidad y precio deben ser mayores que cero');
            return;
        }
        const { side, position } = dialog;
        act(async () => {
            const result = await submitMaintainerTransaction({
                accountId: account.accountId,
                ticker: position.ticker,
                side,
                qty,
                price,
                commission,
            });
            setTrade({ qty: '', price: '', commission: '' });
            return `${side === 'BUY' ? 'Compra' : 'Venta'} de ${qty} ${position.ticker} · efectivo ${result.cash.toFixed(2)} ${result.currency}`;
        });
    };

    const field = 'rounded border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-sm text-slate-200';
    const label = 'block text-xs text-slate-400 mb-1';

    return (
        <div className="p-6">
            <h1 className="text-2xl font-bold mb-1">Portafolio</h1>
            <p className="text-sm text-slate-400 mb-6">
                Mantenedor manual: perfiles de portafolio, billetera en la moneda del perfil,
                compras y ventas con costo promedio ponderado e historial de movimientos.
            </p>

            {error && (
                <div role="alert" className="mb-4 rounded border border-red-800 bg-red-900/40 px-4 py-2 text-sm text-red-300">{error}</div>
            )}
            {success && (
                <div className="mb-4 rounded border border-emerald-800 bg-emerald-900/40 px-4 py-2 text-sm text-emerald-300">{success}</div>
            )}

            {/* Profile selector */}
            <div className="mb-6 flex flex-wrap items-end gap-3">
                <div>
                    <label className={label} htmlFor="pm-profile">Perfil</label>
                    <select
                        id="pm-profile"
                        value={selected}
                        onChange={e => selectProfile(e.target.value)}
                        className={field}
                    >
                        {accounts.length === 0 && <option value="">—</option>}
                        {accounts.map(a => (
                            <option key={a.accountId} value={a.accountId}>{a.name} ({a.currency})</option>
                        ))}
                    </select>
                </div>
                <button onClick={() => { setProfileName(''); setProfileCurrency('USD'); setDialog({ kind: 'create' }); }}
                    className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600">
                    Nuevo perfil
                </button>
                <button disabled={!account} onClick={() => { setProfileName(account?.name ?? ''); setDialog({ kind: 'rename' }); }}
                    className="rounded bg-slate-700 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-600 disabled:opacity-50">
                    Renombrar
                </button>
                <button disabled={!account} onClick={() => setDialog({ kind: 'deleteProfile', force: false })}
                    className="rounded bg-red-900/60 px-3 py-1.5 text-sm font-semibold text-red-300 hover:bg-red-800/60 disabled:opacity-50">
                    Eliminar perfil
                </button>
            </div>

            {/* Wallet */}
            <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <h2 className="mb-3 text-sm font-semibold text-slate-300">Billetera</h2>
                <div className="flex flex-wrap items-end gap-3">
                    <div className="mr-4">
                        <div className="text-xs text-slate-400">Saldo disponible</div>
                        <div className="font-mono text-xl text-emerald-300">
                            {money(account?.cash ?? null)} {account?.currency ?? ''}
                        </div>
                    </div>
                    <div>
                        <label className={label} htmlFor="pm-amount">Monto</label>
                        <input id="pm-amount" type="number" min="0" step="any" value={cashAmount}
                            onChange={e => setCashAmount(e.target.value)} className={`w-32 ${field}`} />
                    </div>
                    <div>
                        <label className={label} htmlFor="pm-note">Nota</label>
                        <input id="pm-note" value={cashNote} onChange={e => setCashNote(e.target.value)} className={`w-48 ${field}`} />
                    </div>
                    <button disabled={!account} onClick={() => handleCash('deposit')}
                        className="rounded bg-emerald-700 px-3 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
                        Depositar
                    </button>
                    <button disabled={!account} onClick={() => handleCash('withdraw')}
                        className="rounded bg-slate-700 px-3 py-1.5 text-sm font-semibold text-slate-200 hover:bg-slate-600 disabled:opacity-50">
                        Retirar
                    </button>
                </div>
            </div>

            {/* Positions */}
            <h2 className="mb-2 text-sm font-semibold text-slate-300">Posiciones</h2>
            <div className="mb-6 overflow-x-auto rounded-lg border border-slate-700">
                <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-slate-800 text-left text-slate-400">
                        <tr>
                            <th className="px-4 py-2">Ticker</th>
                            <th className="px-4 py-2 text-right">Cantidad</th>
                            <th className="px-4 py-2 text-right">Costo prom.</th>
                            <th className="px-4 py-2 text-right">Costo total</th>
                            <th className="px-4 py-2 text-right">Precio actual</th>
                            <th className="px-4 py-2 text-right">P/L</th>
                            <th className="px-4 py-2 text-right">Acciones</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                        {loading ? (
                            <tr><td colSpan={7} className="px-4 py-4 text-slate-400">Cargando…</td></tr>
                        ) : accountPositions.length === 0 ? (
                            <tr><td colSpan={7} className="px-4 py-4 text-slate-500">Sin posiciones — agrega una acción abajo.</td></tr>
                        ) : (
                            accountPositions.map(p => {
                                const cost = (p.avgCost ?? 0) * p.qty;
                                const price = p.price ?? null;
                                const pl = price == null || p.avgCost == null ? null : (price - p.avgCost) * p.qty;
                                return (
                                    <tr key={`${p.accountId}:${p.ticker}`} className="hover:bg-slate-800/40">
                                        <td className="px-4 py-2 font-mono text-slate-200">{p.ticker}</td>
                                        <td className="px-4 py-2 text-right text-slate-300">{p.qty}</td>
                                        <td className="px-4 py-2 text-right text-slate-300">{money(p.avgCost)}</td>
                                        <td className="px-4 py-2 text-right text-slate-300">{money(cost)}</td>
                                        <td className="px-4 py-2 text-right text-slate-300">{money(price)}</td>
                                        <td className={`px-4 py-2 text-right font-mono ${pl == null ? 'text-slate-500' : pl >= 0 ? 'text-emerald-300' : 'text-red-300'}`}>
                                            {pl == null ? '—' : `${pl >= 0 ? '+' : '-'}${Math.abs(pl).toFixed(2)}`}
                                        </td>
                                        <td className="px-4 py-2 text-right">
                                            <div className="flex justify-end gap-2">
                                                <button onClick={() => { setTrade({ qty: '', price: '', commission: '' }); setDialog({ kind: 'trade', side: 'BUY', position: p }); }}
                                                    className="rounded bg-emerald-800/60 px-2 py-1 text-xs font-semibold text-emerald-200 hover:bg-emerald-700/60">
                                                    Comprar
                                                </button>
                                                <button onClick={() => { setTrade({ qty: '', price: '', commission: '' }); setDialog({ kind: 'trade', side: 'SELL', position: p }); }}
                                                    className="rounded bg-amber-800/60 px-2 py-1 text-xs font-semibold text-amber-200 hover:bg-amber-700/60">
                                                    Vender
                                                </button>
                                                <button onClick={() => setDialog({ kind: 'deletePosition', position: p })}
                                                    className="rounded bg-red-900/60 px-2 py-1 text-xs font-semibold text-red-300 hover:bg-red-800/60">
                                                    Eliminar
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                );
                            })
                        )}
                    </tbody>
                </table>
            </div>

            {/* Add stock */}
            <h2 className="mb-2 text-sm font-semibold text-slate-300">Agregar acción</h2>
            <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <form onSubmit={handleAddStock} className="flex flex-wrap items-end gap-3">
                    <div>
                        <label className={label} htmlFor="pm-ticker">Ticker</label>
                        <input id="pm-ticker" value={stock.ticker} onChange={e => setStock(s => ({ ...s, ticker: e.target.value }))}
                            placeholder="AAPL" className={`w-32 font-mono ${field}`} />
                    </div>
                    <div>
                        <label className={label} htmlFor="pm-qty">Cantidad</label>
                        <input id="pm-qty" type="number" min="0" step="any" value={stock.qty}
                            onChange={e => setStock(s => ({ ...s, qty: e.target.value }))} className={`w-28 ${field}`} />
                    </div>
                    <div>
                        <label className={label} htmlFor="pm-price">Precio</label>
                        <input id="pm-price" type="number" min="0" step="any" value={stock.price}
                            onChange={e => setStock(s => ({ ...s, price: e.target.value }))} className={`w-28 ${field}`} />
                    </div>
                    <div>
                        <label className={label} htmlFor="pm-commission">Comisión</label>
                        <input id="pm-commission" type="number" min="0" step="any" value={stock.commission}
                            onChange={e => setStock(s => ({ ...s, commission: e.target.value }))} className={`w-28 ${field}`} />
                    </div>
                    <button type="submit" disabled={!account}
                        className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50">
                        Agregar acción
                    </button>
                </form>
            </div>

            {/* History */}
            <h2 className="mb-2 text-sm font-semibold text-slate-300">Historial</h2>
            <div className="overflow-x-auto rounded-lg border border-slate-700">
                <table className="w-full min-w-[560px] text-sm">
                    <thead className="bg-slate-800 text-left text-slate-400">
                        <tr>
                            <th className="px-4 py-2">Fecha</th>
                            <th className="px-4 py-2">Tipo</th>
                            <th className="px-4 py-2">Ticker</th>
                            <th className="px-4 py-2 text-right">Cantidad</th>
                            <th className="px-4 py-2 text-right">Precio</th>
                            <th className="px-4 py-2 text-right">Total</th>
                            <th className="px-4 py-2">Nota</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                        {transactions.length === 0 ? (
                            <tr><td colSpan={7} className="px-4 py-4 text-slate-500">Sin movimientos todavía.</td></tr>
                        ) : (
                            transactions.map(t => (
                                <tr key={t.entryId} className="hover:bg-slate-800/40">
                                    <td className="px-4 py-2 text-slate-400">{t.loggedAt?.slice(0, 19).replace('T', ' ') ?? '—'}</td>
                                    <td className="px-4 py-2 text-slate-200">{t.action}</td>
                                    <td className="px-4 py-2 font-mono text-slate-200">{t.ticker}</td>
                                    <td className="px-4 py-2 text-right text-slate-300">{t.shares ?? '—'}</td>
                                    <td className="px-4 py-2 text-right text-slate-300">{money(t.price)}</td>
                                    <td className="px-4 py-2 text-right text-slate-300">{money(t.totalCost)}</td>
                                    <td className="px-4 py-2 text-slate-400">{t.notes ?? ''}</td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {/* Dialogs */}
            {dialog && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                    <div role="dialog" aria-modal="true" className="w-full max-w-md rounded-lg border border-slate-700 bg-slate-800 p-6 shadow-xl">
                        {dialog.kind === 'create' && (
                            <>
                                <h3 className="mb-3 text-lg font-semibold text-slate-100">Nuevo perfil</h3>
                                <label className={label} htmlFor="pm-new-name">Nombre del perfil</label>
                                <input id="pm-new-name" value={profileName} onChange={e => setProfileName(e.target.value)} className={`mb-3 w-full ${field}`} />
                                <label className={label} htmlFor="pm-new-currency">Moneda</label>
                                <input id="pm-new-currency" value={profileCurrency} onChange={e => setProfileCurrency(e.target.value)} className={`mb-4 w-full ${field}`} />
                                <DialogButtons
                                    onCancel={() => setDialog(null)}
                                    confirmLabel="Crear"
                                    onConfirm={() => {
                                        const name = profileName.trim();
                                        if (!name) { setError('El nombre del perfil es obligatorio'); return; }
                                        act(async () => {
                                            await createMaintainerAccount(name, 'PROFILE', profileCurrency.trim().toUpperCase() || 'USD');
                                            return `Perfil ${name} creado`;
                                        }, name);
                                    }}
                                />
                            </>
                        )}
                        {dialog.kind === 'rename' && account && (
                            <>
                                <h3 className="mb-3 text-lg font-semibold text-slate-100">Renombrar perfil</h3>
                                <label className={label} htmlFor="pm-rename">Nuevo nombre</label>
                                <input id="pm-rename" value={profileName} onChange={e => setProfileName(e.target.value)} className={`mb-4 w-full ${field}`} />
                                <DialogButtons
                                    onCancel={() => setDialog(null)}
                                    confirmLabel="Guardar"
                                    onConfirm={() => act(async () => {
                                        await updateMaintainerAccount(account.accountId, { name: profileName.trim() });
                                        return 'Perfil actualizado';
                                    })}
                                />
                            </>
                        )}
                        {dialog.kind === 'deleteProfile' && account && (
                            <>
                                <h3 className="mb-3 text-lg font-semibold text-slate-100">¿Eliminar el perfil {account.name}?</h3>
                                <p className="mb-4 text-sm text-slate-400">
                                    Se eliminará el perfil y su billetera. No se puede eliminar mientras tenga posiciones.
                                </p>
                                <DialogButtons
                                    onCancel={() => setDialog(null)}
                                    confirmLabel="Confirmar eliminación del perfil"
                                    onConfirm={() => act(async () => {
                                        await deleteMaintainerAccount(account.accountId, dialog.force);
                                        return `Perfil ${account.name} eliminado`;
                                    }, '')}
                                    extra={!dialog.force ? {
                                        label: 'Eliminar con saldo',
                                        onClick: () => setDialog({ kind: 'deleteProfile', force: true }),
                                    } : undefined}
                                />
                            </>
                        )}
                        {dialog.kind === 'trade' && (
                            <>
                                <h3 className="mb-3 text-lg font-semibold text-slate-100">
                                    {dialog.side === 'BUY' ? 'Comprar' : 'Vender'} {dialog.position.ticker}
                                </h3>
                                <label className={label} htmlFor="pm-trade-qty">Cantidad a operar</label>
                                <input id="pm-trade-qty" type="number" min="0" step="any" value={trade.qty}
                                    onChange={e => setTrade(t => ({ ...t, qty: e.target.value }))} className={`mb-3 w-full ${field}`} />
                                <label className={label} htmlFor="pm-trade-price">Precio de la operación</label>
                                <input id="pm-trade-price" type="number" min="0" step="any" value={trade.price}
                                    onChange={e => setTrade(t => ({ ...t, price: e.target.value }))} className={`mb-3 w-full ${field}`} />
                                <label className={label} htmlFor="pm-trade-commission">Comisión de la operación</label>
                                <input id="pm-trade-commission" type="number" min="0" step="any" value={trade.commission}
                                    onChange={e => setTrade(t => ({ ...t, commission: e.target.value }))} className={`mb-4 w-full ${field}`} />
                                <DialogButtons
                                    onCancel={() => setDialog(null)}
                                    confirmLabel={dialog.side === 'BUY' ? 'Confirmar compra' : 'Confirmar venta'}
                                    onConfirm={handleTrade}
                                />
                            </>
                        )}
                        {dialog.kind === 'deletePosition' && (
                            <>
                                <h3 className="mb-3 text-lg font-semibold text-slate-100">¿Eliminar {dialog.position.ticker}?</h3>
                                <p className="mb-4 text-sm text-slate-400">
                                    Se quita la posición del perfil. El efectivo de la billetera no cambia.
                                </p>
                                <DialogButtons
                                    onCancel={() => setDialog(null)}
                                    confirmLabel="Confirmar eliminación"
                                    onConfirm={() => act(async () => {
                                        await deleteMaintainerPosition(dialog.position.accountId, dialog.position.ticker);
                                        return `${dialog.position.ticker} eliminado`;
                                    })}
                                />
                            </>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
}

/** Cancel / confirm row shared by every dialog, with an optional third action. */
function DialogButtons({ onCancel, onConfirm, confirmLabel, extra }: {
    onCancel: () => void;
    onConfirm: () => void;
    confirmLabel: string;
    extra?: { label: string; onClick: () => void };
}) {
    return (
        <div className="flex justify-end gap-3">
            <button onClick={onCancel} className="rounded bg-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-600">
                Cancelar
            </button>
            {extra && (
                <button onClick={extra.onClick} className="rounded bg-amber-800 px-4 py-2 text-sm font-semibold text-amber-100 hover:bg-amber-700">
                    {extra.label}
                </button>
            )}
            <button onClick={onConfirm} className="rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600">
                {confirmLabel}
            </button>
        </div>
    );
}
