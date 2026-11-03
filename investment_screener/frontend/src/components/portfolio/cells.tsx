/**
 * cells.tsx - The cell components of the four accounting columns on the Portafolio page.
 *
 * Purpose:
 *     Market value, "Peso y riesgo" (two thin stacked bars on one 0-40 %
 *     scale: weight in grey, risk contribution in the accent; a hatched bar and "est." when the risk is
 *     estimated; the optimizer's target weight beside the weight) and Ganancia (price minus average cost).
 *     Ganancia is the only place colour encodes sign. The registry (positions/columns.ts) only holds thin
 *     entries that render these.
 *
 * Layer: Frontend / Components / Portfolio
 *
 * Usage Examples:
 *     createElement(WeightRiskCell, { row })
 *
 * Key Functions (Index):
 *     - ValueCell(), WeightRiskCell(), GainCell()
 *
 * Key Input Dependencies:
 *     - portfolioMath.ts, TableRow risk fields (riskContributionPct, riskEstimated, optimizedTargetPct)
 *
 * Key Output Dependencies:
 *     - positions/columns.ts (acc_* columns)
 */
import type { TableRow } from '../positions/columns';
import { barWidthPct, esNum, esPct, esUsd, holdingGain } from './portfolioMath';

export function ValueCell({ row, hidden }: { row: TableRow; hidden: boolean }) {
    const value = row.marketValue;
    return <span className="font-mono text-slate-200">{value == null ? '—' : esUsd(value, hidden, 2)}</span>;
}

function Bar({ pct, fill, hatched, testId }: { pct: number | null | undefined; fill: string; hatched?: boolean; testId?: string }) {
    return (
        <span data-testid={testId} data-estimated={testId ? String(!!hatched) : undefined}
            className={`block h-1 w-[120px] rounded-sm bg-slate-800 ${hatched ? 'outline outline-1 outline-dashed outline-slate-400' : ''}`}>
            <i className={`block h-full rounded-sm ${hatched ? '' : fill}`}
                style={{ width: `${barWidthPct(pct)}%`, ...(hatched ? { background: 'repeating-linear-gradient(90deg,#94a3b8 0 3px,transparent 3px 6px)' } : {}) }} />
        </span>
    );
}

/** Weight (grey) over risk contribution (accent) on one 0-40 % scale, each with its number. */
export function WeightRiskCell({ row }: { row: TableRow }) {
    const weight = row.actualPct;
    const risk = row.riskContributionPct;
    const target = row.optimizedTargetPct;
    const estimated = !!row.riskEstimated;
    return (
        <span className="inline-flex flex-col items-end gap-1.5 text-xs text-slate-300">
            <span className="sr-only">
                {`Peso ${weight == null ? 'desconocido' : esPct(weight)}, riesgo ${risk == null ? 'sin datos' : `${estimated ? 'estimado ' : ''}${esPct(risk)}`}`}
            </span>
            <span aria-hidden="true" className="grid grid-cols-[120px_56px_44px] items-center justify-end gap-2">
                <Bar pct={weight} fill="bg-slate-600" />
                <span className="text-right font-mono">{weight == null ? '—' : esPct(weight)}</span>
                {target != null && weight != null
                    ? <span title="Peso objetivo sugerido" className="rounded border border-dashed border-slate-500 px-1 text-center font-mono text-[11px]">{`→ ${esNum(target, 1)}`}</span>
                    : <span />}
            </span>
            <span aria-hidden="true" className="grid grid-cols-[120px_56px_44px] items-center justify-end gap-2">
                <Bar pct={risk} fill="bg-amber-400" hatched={estimated && risk != null} testId={`risk-bar-${row.ticker}`} />
                <span className="text-right font-mono" title={estimated ? 'Sin historia suficiente: riesgo estimado' : undefined}>
                    {risk == null ? '—' : `${estimated ? '~' : ''}${esPct(risk)}`}
                </span>
                <span className="text-[11px] text-slate-400">{estimated ? 'est.' : ''}</span>
            </span>
        </span>
    );
}

/** Gain since purchase: price minus average cost. Green above zero, red below, grey at zero or unknown. */
export function GainCell({ row, hidden }: { row: TableRow; hidden: boolean }) {
    const gain = holdingGain(row);
    if (!gain) return <span data-testid={`gain-${row.ticker}`} className="text-slate-500">—</span>;
    const tone = gain.amount > 0 ? 'text-emerald-400' : gain.amount < 0 ? 'text-red-400' : 'text-slate-400';
    const sign = gain.amount > 0 ? '+' : '';
    return (
        <span data-testid={`gain-${row.ticker}`} className={`flex flex-col items-end font-mono ${tone}`}>
            <span>{hidden ? '••••' : `${sign}${esNum(gain.amount, 2)}`}</span>
            <span className="text-xs text-slate-400">{`${sign}${esNum(gain.pct, 1)} %`}</span>
        </span>
    );
}
