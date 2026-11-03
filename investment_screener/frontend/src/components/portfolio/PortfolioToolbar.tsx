/**
 * PortfolioToolbar.tsx - Scope tabs, add-ticker form and the demoted filters of the Portafolio table.
 *
 * Purpose:
 *     Tenencias / Watchlist / Todo scope as quiet underline tabs, the add-ticker form, and a collapsed
 *     "Filtros y columnas" section that still holds everything the old toolbar had: the status chips
 *     (actionable, exits, trims, initiate, accumulate, gaps), the reduce-candidates chip, "prioritize
 *     actions", the sector and strategy filters, the per-column filter row, and the column picker
 *     (where the full analyst columns, such as Action and the valuation range, can be switched back on).
 *
 * Layer: Frontend / Components / Portfolio
 *
 * Usage Examples:
 *     <PortfolioToolbar filter={filter} onFilter={setFilter} ... />
 *
 * Key Functions (Index):
 *     - PortfolioToolbar(): tabs, add form, collapsible filters
 *
 * Key Input Dependencies:
 *     - positions/scope.ts (FilterState, Scope, StatusFilter), ColumnPicker, RiskRewardCell (ReduceCandidatesChip)
 *
 * Key Output Dependencies:
 *     - pages/PortfolioPage.tsx
 */
import type { ComponentProps } from 'react';
import { Filter } from 'lucide-react';
import { HelpTrigger } from '../HelpModal';
import { ReduceCandidatesChip } from '../RiskRewardCell';
import { ColumnPicker } from '../positions/ColumnPicker';
import type { countsFor, FilterState, Scope, StatusFilter } from '../positions/scope';

const SCOPES: Array<{ id: Scope; label: string }> = [
    { id: 'holdings', label: 'Tenencias' }, { id: 'watchlist', label: 'Watchlist' }, { id: 'all', label: 'Todo' },
];
const CHIPS: Array<{ id: StatusFilter; label: string; tone: string }> = [
    { id: 'actionable', label: '⚡ Actionable', tone: 'bg-cyan-600' },
    { id: 'exit', label: '🔴 Exits', tone: 'bg-red-600' },
    { id: 'trim', label: '🟠 Trims', tone: 'bg-orange-600' },
    { id: 'initiate', label: '🟢 Initiate', tone: 'bg-green-600' },
    { id: 'accumulate', label: '🔵 Accumulate', tone: 'bg-blue-600' },
    { id: 'gaps', label: '🚨 Needs valuation', tone: 'bg-rose-600' },
];

interface PortfolioToolbarProps {
    filter: FilterState;
    onFilter: (update: (f: FilterState) => FilterState) => void;
    scopeCounts: ReturnType<typeof countsFor>;
    chipCounts: ReturnType<typeof countsFor>;
    sectors: string[];
    strategies: string[];
    reduceCount: number;
    reduceActive: boolean;
    onToggleReduce: () => void;
    onToggleStatus: (status: StatusFilter) => void;
    onPrioritize: () => void;
    showFilterRow: boolean;
    onToggleFilterRow: () => void;
    onAddTicker: (ticker: string) => Promise<void>;
    picker: ComponentProps<typeof ColumnPicker>;
}

const tab = (on: boolean) => `-mb-px min-h-[44px] border-b-2 px-0.5 text-sm font-semibold ${on ? 'border-slate-200 text-white' : 'border-transparent text-slate-400 hover:text-slate-200'}`;
const select = 'rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-zinc-300';

export function PortfolioToolbar(p: PortfolioToolbarProps) {
    const { filter } = p;
    return (
        <div>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-700">
                <div role="group" aria-label="Alcance" className="flex gap-5">
                    {SCOPES.map(s => (
                        <button key={s.id} type="button" aria-pressed={filter.scope === s.id} className={tab(filter.scope === s.id)}
                            onClick={() => p.onFilter(f => ({ ...f, scope: s.id }))}>
                            {s.label} <span className="ml-0.5 text-[11px] text-slate-400">{p.scopeCounts[s.id === 'all' ? 'all' : s.id]}</span>
                        </button>
                    ))}
                </div>
                <form onSubmit={async e => {
                    e.preventDefault();
                    const input = e.currentTarget.elements.namedItem('watchlistTicker') as HTMLInputElement;
                    const ticker = input.value.trim().toUpperCase();
                    if (!ticker) return;
                    try { await p.onAddTicker(ticker); input.value = ''; } catch (err) { console.error('Error adding to watchlist:', err); }
                }} className="flex items-center rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-0.5 focus-within:border-indigo-500/50">
                    <input name="watchlistTicker" type="text" placeholder="Add ticker…" aria-label="Add ticker to watchlist"
                        className="w-24 bg-transparent px-1 py-0.5 text-xs font-bold text-white placeholder:text-slate-500 focus:outline-none" />
                    <button type="submit" className="px-2 text-xs font-black text-indigo-400 hover:text-indigo-300">+ Add</button>
                </form>
            </div>
            <details className="text-xs">
                <summary className="flex min-h-[44px] cursor-pointer items-center text-[13px] font-semibold text-slate-400 hover:text-slate-200">Filtros y columnas</summary>
                <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
                    {CHIPS.map(c => (
                        <button key={c.id} type="button" aria-pressed={filter.status === c.id} onClick={() => p.onToggleStatus(c.id)}
                            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 font-bold ${filter.status === c.id ? `${c.tone} text-white` : 'text-zinc-400 hover:text-zinc-200'}`}>
                            {c.label}
                            <span className="rounded-full bg-zinc-800 px-1.5 text-[10px] text-zinc-300">{p.chipCounts[c.id as keyof typeof p.chipCounts]}</span>
                        </button>
                    ))}
                    <HelpTrigger topicId="riskReward" size={13} />
                    <ReduceCandidatesChip count={p.reduceCount} active={p.reduceActive} onToggle={p.onToggleReduce} />
                    <button type="button" onClick={p.onPrioritize}
                        className="rounded border border-zinc-700 px-2 py-1 font-bold text-amber-400 hover:bg-zinc-800">⚡ Prioritize actions</button>
                    <label className="flex items-center gap-1 text-zinc-500">Sector
                        <select aria-label="Sector" value={filter.sector} onChange={e => p.onFilter(f => ({ ...f, sector: e.target.value }))} className={select}>
                            <option value="all">All</option>
                            {p.sectors.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </label>
                    <label className="flex items-center gap-1 text-zinc-500">Strategy
                        <select aria-label="Strategy" value={filter.strategy} onChange={e => p.onFilter(f => ({ ...f, strategy: e.target.value }))} className={select}>
                            <option value="all">All</option>
                            {p.strategies.map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </label>
                    <button type="button" onClick={p.onToggleFilterRow} aria-pressed={p.showFilterRow}
                        className={`flex items-center gap-1.5 rounded px-3 py-1 ${p.showFilterRow ? 'border border-amber-500/50 bg-amber-500/20 text-amber-400' : 'bg-zinc-800 text-zinc-300 hover:bg-zinc-700'}`}>
                        <Filter size={13} /> Filter
                    </button>
                    <ColumnPicker {...p.picker} />
                </div>
            </details>
        </div>
    );
}
