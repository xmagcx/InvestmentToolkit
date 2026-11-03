/**
 * PositionsTable.tsx - The one table component for a list of tickers.
 *
 * Purpose:
 *     Renders position rows with the columns it is given: sortable, resizable header, optional
 *     per-column filter row, row click, per-row actions, a ticker add-on (the watch star) and a
 *     totals row. It owns no data and defines no columns: rows come from the shared provider,
 *     columns from the registry (columns.ts), and the recommendation behind each row from the
 *     shared recommendations context. Every screen that lists tickers uses this component.
 *
 * Layer: Frontend / Components / Positions
 *
 * Usage Examples:
 *     <PositionsTable rows={rows} columnIds={THESIS_PRESET.columns} initialSort={THESIS_PRESET.sort} totals />
 *
 * Key Functions (Index):
 *     - PositionsTable: header with sort and resize, optional filter row, body, totals row
 *
 * Key Input Dependencies:
 *     - columns.ts, positionMath.ts, utils/riskReward (riskRewardRowAccent),
 *       contexts/useRecommendations, context/PrivacyContext
 *
 * Key Output Dependencies:
 *     - ThesisPositions, PortfolioPage
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown } from 'lucide-react';
import type { RecommendationRecord } from '../../services/api';
import { useRecommendations } from '../../contexts/useRecommendations';
import { usePrivacy } from '../../context/PrivacyContext';
import { riskRewardRowAccent } from '../../utils/riskReward';
import { COLUMNS_BY_ID, type TableRow } from './columns';
import { sortRows, totalsFor } from './positionMath';

export interface SortState {
    id: string;
    dir: 'asc' | 'desc';
}

interface PositionsTableProps {
    rows: TableRow[];
    columnIds: string[];
    initialSort: SortState;
    /** Controlled sort; when given it wins over the table's own state. */
    sort?: SortState;
    onSortChange?: (sort: SortState) => void;
    totals?: boolean;
    /** Column widths by id (falls back to the registry width) and the resize callback. */
    widths?: Record<string, number>;
    onResize?: (id: string, width: number) => void;
    /** Filter row: shown when given; text per column id. */
    filters?: Record<string, string>;
    onFilterChange?: (id: string, value: string) => void;
    onRowClick?: (row: TableRow) => void;
    /** The row driving a side panel: highlighted and marked aria-selected. None by default. */
    selectedTicker?: string | null;
    /** Text of the totals row's first cell; default is the English "TOTAL · N held". */
    totalLabel?: (heldCount: number) => string;
    /** Extra cell content before the ticker (the watch star). */
    tickerAddon?: (row: TableRow) => ReactNode;
    /** A trailing actions column. */
    renderActions?: (row: TableRow, rec?: RecommendationRecord | null) => ReactNode;
    actionsWidth?: number;
    emptyMessage?: string;
}

const ACTIONS_WIDTH = 190;

export function PositionsTable({
    rows, columnIds, initialSort, sort: controlledSort, onSortChange, totals = false, widths = {}, onResize,
    filters, onFilterChange, onRowClick, selectedTicker, totalLabel, tickerAddon, renderActions, actionsWidth = ACTIONS_WIDTH,
    emptyMessage = 'No stocks to show.',
}: PositionsTableProps) {
    const recommendations = useRecommendations();
    const { isPrivacyMode } = usePrivacy();
    const [innerSort, setInnerSort] = useState<SortState>(initialSort);
    const sort = controlledSort ?? innerSort;
    const columns = columnIds.map(id => COLUMNS_BY_ID[id]).filter(Boolean);
    const widthOf = useCallback((id: string) => widths[id] ?? COLUMNS_BY_ID[id]?.width ?? 100, [widths]);

    const sorted = useMemo(() => {
        const column = COLUMNS_BY_ID[sort.id];
        if (!column?.sort) return rows;
        const get = column.sort;
        // Rows tied on the sorted column (for example every unheld stock at 0%) keep the order of
        // largest target weight first, then ticker, so the missing allocations read in priority order.
        const base = sortRows(sortRows(rows, row => row.ticker, 'asc'), row => row.targetPct, 'desc');
        return sortRows(base, row => get(row, recommendations[row.ticker]), sort.dir);
    }, [rows, sort, recommendations]);

    const totalsRow = useMemo(() => totalsFor(rows), [rows]);

    const toggleSort = (id: string) => {
        const next: SortState = sort.id === id ? { id, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { id, dir: 'desc' };
        setInnerSort(next);
        onSortChange?.(next);
    };

    const drag = useRef<{ id: string; startX: number; startWidth: number } | null>(null);
    useEffect(() => {
        const move = (e: MouseEvent) => {
            if (!drag.current || !onResize) return;
            onResize(drag.current.id, drag.current.startWidth + (e.clientX - drag.current.startX));
        };
        const up = () => {
            drag.current = null;
            document.body.style.cursor = '';
            document.body.style.userSelect = '';
        };
        document.addEventListener('mousemove', move);
        document.addEventListener('mouseup', up);
        return () => { document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
    }, [onResize]);

    if (rows.length === 0 && !filters) {
        return <div className="rounded-lg border border-zinc-800 p-4 text-sm text-zinc-500">{emptyMessage}</div>;
    }

    const minWidth = columns.reduce((sum, c) => sum + widthOf(c.id), 0) + (renderActions ? actionsWidth : 0);

    return (
        <div className="overflow-auto rounded-lg border border-zinc-800">
            <table className="border-collapse text-sm" data-testid="positions-table"
                style={{ tableLayout: 'fixed', width: '100%', minWidth }}>
                <colgroup>
                    {columns.map(col => <col key={col.id} style={{ width: widthOf(col.id) }} />)}
                    {renderActions && <col style={{ width: actionsWidth }} />}
                </colgroup>
                <thead className="sticky top-0 z-10">
                    <tr className="border-b border-zinc-700 bg-zinc-800">
                        {columns.map(col => {
                            const active = sort.id === col.id;
                            return (
                                <th key={col.id} title={col.title} scope="col"
                                    aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                                    className={`relative select-none overflow-hidden whitespace-nowrap px-3 py-2.5 text-xs font-semibold uppercase tracking-wider ${col.align === 'right' ? 'text-right' : 'text-left'} ${active ? 'text-amber-400' : 'text-zinc-400'}`}>
                                    {col.sort ? (
                                        <button type="button" onClick={() => toggleSort(col.id)}
                                            className="inline-flex items-center gap-1 hover:text-zinc-200">
                                            {col.label}
                                            {active
                                                ? (sort.dir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />)
                                                : <ChevronsUpDown size={11} className="text-zinc-600" />}
                                        </button>
                                    ) : col.label}
                                    {onResize && (
                                        <span role="separator" aria-orientation="vertical" aria-label={`Resize ${col.label}`}
                                            className="absolute bottom-0 right-0 top-0 w-[5px] cursor-col-resize hover:bg-amber-500/40"
                                            onMouseDown={e => {
                                                e.preventDefault();
                                                e.stopPropagation();
                                                drag.current = { id: col.id, startX: e.clientX, startWidth: widthOf(col.id) };
                                                document.body.style.cursor = 'col-resize';
                                                document.body.style.userSelect = 'none';
                                            }} />
                                    )}
                                </th>
                            );
                        })}
                        {renderActions && <th className="px-2 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-zinc-500">Actions</th>}
                    </tr>
                    {filters && (
                        <tr className="border-b border-zinc-700 bg-zinc-800/80">
                            {columns.map(col => (
                                <th key={`f-${col.id}`} className="px-2 py-1.5">
                                    <input type="text" placeholder="Filter…" aria-label={`Filter ${col.label}`}
                                        value={filters[col.id] ?? ''} onChange={e => onFilterChange?.(col.id, e.target.value)}
                                        className="w-full rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-[11px] text-zinc-300 focus:border-amber-500 focus:outline-none" />
                                </th>
                            ))}
                            {renderActions && <th />}
                        </tr>
                    )}
                </thead>
                <tbody>
                    {sorted.length === 0 && (
                        <tr><td colSpan={columns.length + (renderActions ? 1 : 0)} className="px-3 py-6 text-center text-sm text-zinc-500">{emptyMessage}</td></tr>
                    )}
                    {sorted.map((row, i) => {
                        const rec = recommendations[row.ticker];
                        return (
                            <tr key={row.ticker} onClick={onRowClick ? () => onRowClick(row) : undefined}
                                aria-selected={selectedTicker != null ? row.ticker === selectedTicker : undefined}
                                className={`border-b border-zinc-800 ${riskRewardRowAccent(rec)} ${onRowClick ? 'cursor-pointer' : ''} ${row.ticker === selectedTicker ? 'bg-slate-700/40 shadow-[inset_2px_0_0_0_#94a3b8]' : i % 2 ? 'bg-zinc-900/50' : 'bg-zinc-900'} hover:bg-zinc-800/70`}>
                                {columns.map(col => (
                                    <td key={col.id}
                                        style={{ backgroundColor: col.background?.(row, rec) }}
                                        className={`overflow-hidden px-3 py-2 ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                                        {col.isTicker && tickerAddon
                                            ? <span className="flex items-center gap-1.5">{tickerAddon(row)}{col.cell(row, { rec, hidden: isPrivacyMode })}</span>
                                            : col.cell(row, { rec, hidden: isPrivacyMode })}
                                    </td>
                                ))}
                                {renderActions && (
                                    <td className="whitespace-nowrap px-2 py-1.5" onClick={e => e.stopPropagation()}>
                                        <div className="flex items-center justify-end gap-1">{renderActions(row, rec)}</div>
                                    </td>
                                )}
                            </tr>
                        );
                    })}
                </tbody>
                {totals && rows.length > 0 && (
                    <tfoot>
                        <tr className="border-t-2 border-zinc-700 bg-zinc-800/40 text-xs font-bold text-zinc-300">
                            {columns.map((col, i) => (
                                <td key={col.id} className={`px-3 py-2 ${col.align === 'right' ? 'text-right' : 'text-left'}`}>
                                    {i === 0
                                        ? <span className="whitespace-nowrap">{totalLabel ? totalLabel(totalsRow.heldCount) : `TOTAL · ${totalsRow.heldCount} held`}</span>
                                        : col.total ? col.total(totalsRow, { hidden: isPrivacyMode }) : null}
                                </td>
                            ))}
                            {renderActions && <td />}
                        </tr>
                    </tfoot>
                )}
            </table>
        </div>
    );
}
