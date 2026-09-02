/**
 * PortfolioMaintainerPage.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     Manual web portfolio buy/sell entry + maintenance. Creates accounts,
 *     sets initial cash, records weighted-average-cost buy/sell transactions,
 *     and removes positions — replacing broken TV/CDP sync as the manual entry
 *     path. Reads/writes via the `/api/portfolio-maintainer` API client.
 *
 * Layer: Frontend / Pages / Portfolio Maintainer
 *
 * Key Functions:
 *     - PortfolioMaintainerPage() - Renders accounts, positions table, buy/sell
 *       form, account-creation + initial-cash controls, and delete confirmation.
 */
import { useState, useCallback, useEffect } from 'react';
import {
    fetchMaintainerAccounts,
    createMaintainerAccount,
    setMaintainerInitialCash,
    fetchMaintainerPositions,
    submitMaintainerTransaction,
    deleteMaintainerPosition,
} from '../services/api';
import type { MaintainerAccount, MaintainerPosition, MaintainerAccountType } from '../services/api';

const ACCOUNT_TYPES: MaintainerAccountType[] = ['TFSA', 'RRSP', 'CASH'];

export default function PortfolioMaintainerPage() {
    const [accounts, setAccounts] = useState<MaintainerAccount[]>([]);
    const [positions, setPositions] = useState<MaintainerPosition[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [success, setSuccess] = useState<string | null>(null);

    // Task 3.1-adjacent: account creation + initial cash
    const [newAccountName, setNewAccountName] = useState('');
    const [newAccountType, setNewAccountType] = useState<MaintainerAccountType>('TFSA');
    const [cashInputs, setCashInputs] = useState<Record<string, string>>({});

    // Task 3.1-adjacent: transaction form
    const [tx, setTx] = useState({
        accountId: '',
        ticker: '',
        side: 'BUY' as 'BUY' | 'SELL',
        qty: '',
        price: '',
        commission: '0',
    });

    const [pendingDelete, setPendingDelete] = useState<MaintainerPosition | null>(null);

    const refresh = useCallback(async () => {
        try {
            setError(null);
            const [accts, poss] = await Promise.all([fetchMaintainerAccounts(), fetchMaintainerPositions()]);
            setAccounts(accts);
            setPositions(poss);
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load portfolio data');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const handleCreateAccount = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!newAccountName.trim()) return;
        try {
            setError(null);
            setSuccess(null);
            await createMaintainerAccount(newAccountName.trim(), newAccountType);
            setNewAccountName('');
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to create account');
        }
    };

    const handleSetCash = async (accountId: string) => {
        const amount = Number(cashInputs[accountId]);
        if (!Number.isFinite(amount) || amount < 0) {
            setError('Cash amount must be a non-negative number');
            return;
        }
        try {
            setError(null);
            setSuccess(null);
            await setMaintainerInitialCash(accountId, amount);
            setCashInputs((prev) => ({ ...prev, [accountId]: '' }));
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to set initial cash');
        }
    };

    const handleTransaction = async (e: React.FormEvent) => {
        e.preventDefault();
        const qty = Number(tx.qty);
        const price = Number(tx.price);
        const commission = tx.commission === '' ? 0 : Number(tx.commission);
        if (!tx.accountId || !tx.ticker.trim() || !Number.isFinite(qty) || qty <= 0 || !Number.isFinite(price) || price < 0) {
            setError('Fill account, ticker (qty>0) and price (>=0)');
            return;
        }
        try {
            setError(null);
            setSuccess(null);
            const result = await submitMaintainerTransaction({
                accountId: tx.accountId,
                ticker: tx.ticker.trim().toUpperCase(),
                side: tx.side,
                qty,
                price,
                commission: commission >= 0 ? commission : 0,
            });
            setSuccess(
                `${tx.side} ${qty} ${tx.ticker.trim().toUpperCase()} @ ${price}` +
                (result.position ? ` → avg ${result.position.avgCost?.toFixed(2)}` : ' → position closed') +
                ` · ${result.currency} cash ${result.cash.toFixed(2)}`
            );
            setTx((prev) => ({ ...prev, ticker: '', qty: '', price: '', commission: '0' }));
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Transaction failed');
        }
    };

    const handleDelete = async () => {
        if (!pendingDelete) return;
        try {
            setError(null);
            setSuccess(null);
            await deleteMaintainerPosition(pendingDelete.accountId, pendingDelete.ticker);
            setSuccess(`Deleted ${pendingDelete.ticker} in ${pendingDelete.accountId}`);
            setPendingDelete(null);
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Delete failed');
            setPendingDelete(null);
        }
    };

    const isBusy = loading;

    return (
        <div className="p-6">
            <h1 className="text-2xl font-bold mb-1">Portfolio Maintainer</h1>
            <p className="text-sm text-slate-400 mb-6">
                Manual buy/sell entry with weighted-average cost and per-account cash
                (replaces broken TV sync). Sells keep average cost; oversell / spending
                more cash than available is rejected.
            </p>

            {error && (
                <div className="mb-4 rounded border border-red-800 bg-red-900/40 px-4 py-2 text-sm text-red-300">{error}</div>
            )}
            {success && (
                <div className="mb-4 rounded border border-emerald-800 bg-emerald-900/40 px-4 py-2 text-sm text-emerald-300">{success}</div>
            )}

            {/* Account creation */}
            <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <h2 className="mb-3 text-sm font-semibold text-slate-300">Create Account</h2>
                <form onSubmit={handleCreateAccount} className="flex flex-wrap items-end gap-3">
                    <div>
                        <label className="block text-xs text-slate-400 mb-1">Name</label>
                        <input
                            value={newAccountName}
                            onChange={(e) => setNewAccountName(e.target.value)}
                            placeholder="e.g. TFSA One"
                            className="rounded border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-200 focus:outline-none focus:ring-1 focus:ring-emerald-500"
                        />
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400 mb-1">Type</label>
                        <select
                            value={newAccountType}
                            onChange={(e) => setNewAccountType(e.target.value as MaintainerAccountType)}
                            className="rounded border border-slate-700 bg-slate-900/60 px-3 py-1.5 text-sm text-slate-200"
                        >
                            {ACCOUNT_TYPES.map((t) => (
                                <option key={t} value={t}>{t}</option>
                            ))}
                        </select>
                    </div>
                    <button
                        type="submit"
                        className="rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600"
                    >
                        Create
                    </button>
                </form>
            </div>

            {/* Accounts + initial cash */}
            <div className="mb-6 overflow-x-auto rounded-lg border border-slate-700">
                <table className="w-full min-w-[520px] text-sm">
                    <thead className="bg-slate-800 text-left text-slate-400">
                        <tr>
                            <th className="px-4 py-2">Account</th>
                            <th className="px-4 py-2">Type</th>
                            <th className="px-4 py-2">Currency</th>
                            <th className="px-4 py-2 text-right">Cash</th>
                            <th className="px-4 py-2">Set Initial Cash</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                        {loading ? (
                            <tr><td colSpan={5} className="px-4 py-4 text-slate-400">Loading…</td></tr>
                        ) : accounts.length === 0 ? (
                            <tr><td colSpan={5} className="px-4 py-4 text-slate-500">No accounts yet — create one above.</td></tr>
                        ) : (
                            accounts.map((a) => (
                                <tr key={a.accountId} className="hover:bg-slate-800/40">
                                    <td className="px-4 py-2 font-mono text-slate-200">{a.accountId}</td>
                                    <td className="px-4 py-2 text-slate-400">{a.type}</td>
                                    <td className="px-4 py-2 text-slate-400">{a.currency}</td>
                                    <td className="px-4 py-2 text-right font-mono text-emerald-300">{a.cash.toFixed(2)}</td>
                                    <td className="px-4 py-2">
                                        <div className="flex items-center gap-2">
                                            <input
                                                type="number"
                                                min="0"
                                                step="0.01"
                                                value={cashInputs[a.accountId] ?? ''}
                                                onChange={(e) => setCashInputs((prev) => ({ ...prev, [a.accountId]: e.target.value }))}
                                                placeholder="amount"
                                                className="w-28 rounded border border-slate-700 bg-slate-900/60 px-2 py-1 text-sm text-slate-200"
                                            />
                                            <button
                                                onClick={() => handleSetCash(a.accountId)}
                                                className="rounded bg-slate-700 px-3 py-1 text-xs font-semibold text-slate-200 hover:bg-slate-600"
                                            >
                                                Set
                                            </button>
                                        </div>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {/* Positions table */}
            <h2 className="mb-2 text-sm font-semibold text-slate-300">Positions</h2>
            <div className="mb-6 overflow-x-auto rounded-lg border border-slate-700">
                <table className="w-full min-w-[560px] text-sm">
                    <thead className="bg-slate-800 text-left text-slate-400">
                        <tr>
                            <th className="px-4 py-2">Account</th>
                            <th className="px-4 py-2">Ticker</th>
                            <th className="px-4 py-2 text-right">Qty</th>
                            <th className="px-4 py-2 text-right">Avg Cost</th>
                            <th className="px-4 py-2">Currency</th>
                            <th className="px-4 py-2 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                        {loading ? (
                            <tr><td colSpan={6} className="px-4 py-4 text-slate-400">Loading…</td></tr>
                        ) : positions.length === 0 ? (
                            <tr><td colSpan={6} className="px-4 py-4 text-slate-500">No positions yet — record a buy below.</td></tr>
                        ) : (
                            positions.map((p) => (
                                <tr key={`${p.accountId}:${p.ticker}`} className="hover:bg-slate-800/40">
                                    <td className="px-4 py-2 font-mono text-slate-200">{p.accountId}</td>
                                    <td className="px-4 py-2 font-mono text-slate-200">{p.ticker}</td>
                                    <td className="px-4 py-2 text-right text-slate-300">{p.qty}</td>
                                    <td className="px-4 py-2 text-right text-slate-300">{p.avgCost?.toFixed(2) ?? '—'}</td>
                                    <td className="px-4 py-2 text-slate-400">{p.currency}</td>
                                    <td className="px-4 py-2 text-right">
                                        <button
                                            onClick={() => setPendingDelete(p)}
                                            className="rounded bg-red-900/60 px-2 py-1 text-xs font-semibold text-red-300 hover:bg-red-800/60"
                                        >
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>

            {/* Buy/sell form */}
            <h2 className="mb-2 text-sm font-semibold text-slate-300">Record Transaction</h2>
            <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <form onSubmit={handleTransaction} className="grid grid-cols-2 gap-3 md:grid-cols-7">
                    <div className="col-span-2 md:col-span-1">
                        <label className="block text-xs text-slate-400 mb-1">Account</label>
                        <select
                            value={tx.accountId}
                            onChange={(e) => setTx((prev) => ({ ...prev, accountId: e.target.value }))}
                            className="w-full rounded border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-sm text-slate-200"
                        >
                            <option value="">—</option>
                            {accounts.map((a) => (
                                <option key={a.accountId} value={a.accountId}>{a.accountId}</option>
                            ))}
                        </select>
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400 mb-1">Side</label>
                        <div className="flex rounded border border-slate-700 overflow-hidden">
                            {(['BUY', 'SELL'] as const).map((s) => (
                                <button
                                    key={s}
                                    type="button"
                                    onClick={() => setTx((prev) => ({ ...prev, side: s }))}
                                    className={`flex-1 px-3 py-1.5 text-xs font-semibold ${
                                        tx.side === s
                                            ? s === 'BUY' ? 'bg-emerald-700 text-white' : 'bg-red-700 text-white'
                                            : 'bg-slate-900/60 text-slate-400 hover:bg-slate-800'
                                    }`}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400 mb-1">Ticker</label>
                        <input
                            value={tx.ticker}
                            onChange={(e) => setTx((prev) => ({ ...prev, ticker: e.target.value }))}
                            placeholder="AAPL"
                            className="w-full rounded border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-sm font-mono text-slate-200"
                        />
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400 mb-1">Qty</label>
                        <input
                            type="number"
                            min="0"
                            step="any"
                            value={tx.qty}
                            onChange={(e) => setTx((prev) => ({ ...prev, qty: e.target.value }))}
                            className="w-full rounded border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-sm text-slate-200"
                        />
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400 mb-1">Price</label>
                        <input
                            type="number"
                            min="0"
                            step="any"
                            value={tx.price}
                            onChange={(e) => setTx((prev) => ({ ...prev, price: e.target.value }))}
                            className="w-full rounded border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-sm text-slate-200"
                        />
                    </div>
                    <div>
                        <label className="block text-xs text-slate-400 mb-1">Commission</label>
                        <input
                            type="number"
                            min="0"
                            step="any"
                            value={tx.commission}
                            onChange={(e) => setTx((prev) => ({ ...prev, commission: e.target.value }))}
                            className="w-full rounded border border-slate-700 bg-slate-900/60 px-2 py-1.5 text-sm text-slate-200"
                        />
                    </div>
                    <div className="flex items-end">
                        <button
                            type="submit"
                            disabled={isBusy}
                            className="w-full rounded bg-emerald-700 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-600 disabled:opacity-50"
                        >
                            Submit
                        </button>
                    </div>
                </form>
            </div>

            {/* Delete confirmation dialog */}
            {pendingDelete && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
                    <div className="rounded-lg border border-slate-700 bg-slate-800 p-6 shadow-xl max-w-md">
                        <h3 className="text-lg font-semibold text-slate-100 mb-2">Delete position?</h3>
                        <p className="text-sm text-slate-400 mb-4">
                            Remove <span className="font-mono text-slate-200">{pendingDelete.ticker}</span> from{' '}
                            <span className="font-mono text-slate-200">{pendingDelete.accountId}</span>? This does not
                            change account cash.
                        </p>
                        <div className="flex justify-end gap-3">
                            <button
                                onClick={() => setPendingDelete(null)}
                                className="rounded bg-slate-700 px-4 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-600"
                            >
                                Cancel
                            </button>
                            <button
                                onClick={handleDelete}
                                className="rounded bg-red-700 px-4 py-2 text-sm font-semibold text-white hover:bg-red-600"
                            >
                                Delete
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
