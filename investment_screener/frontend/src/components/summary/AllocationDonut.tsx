/**
 * AllocationDonut.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     Compact strategy allocation for the summary rail (artboard "03 Tabla de
 *     analista"): a small SVG donut plus a legend with name, percentage and USD
 *     amount. The big interactive StrategyAllocationChart stays for other pages.
 *
 * Layer: Frontend / UI / Components / Summary
 *
 * Usage Examples:
 *     <AllocationDonut items={allocation.allocation} />
 *
 * Key Functions:
 *     - AllocationDonut() - donut + legend, or an explicit empty message
 */
import { usePrivacy } from '../../context/PrivacyContext';
import { fmtAmount, fmtMoney } from './format';

export interface AllocationSlice {
    id: string;
    name: string;
    valueUSD: number;
    pct: number;
}

/** Strategy colours, in the order of the artboard legend. */
const COLORS = ['#34d399', '#f59e0b', '#94a3b8', '#334155', '#60a5fa', '#f472b6'];

const RADIUS = 70;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Spanish labels for the allocation API's built-in buckets. */
const LABELS: Record<string, string> = { other: 'Sin estrategia', cash: 'Caja' };

function fmtSlicePct(pct: number): string {
    return `${pct.toLocaleString('es-CL', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

export default function AllocationDonut({ items }: { items: AllocationSlice[] }) {
    const { isPrivacyMode } = usePrivacy();

    if (items.length === 0) {
        return <p className="text-sm text-slate-400 py-4 text-center">Sin datos de asignación.</p>;
    }

    // Shares of the slices' own sum: the API's `pct` mixes bases (equity pillars vs the equity
    // total, cash vs the grand total), so it can add up to more than 100 %.
    const totalUSD = items.reduce((sum, i) => sum + Math.max(i.valueUSD, 0), 0);
    const slices = items.map(i => ({
        ...i,
        name: LABELS[i.id.toLowerCase()] ?? i.name,
        pct: totalUSD > 0 ? (Math.max(i.valueUSD, 0) / totalUSD) * 100 : 0,
    }));
    const arcLength = (pct: number) => (pct / 100) * CIRCUMFERENCE;
    const arcs = slices.map((item, i) => ({
        item,
        color: COLORS[i % COLORS.length],
        length: arcLength(item.pct),
        // Each arc starts where the previous ones end (a handful of slices, no mutation).
        offset: slices.slice(0, i).reduce((sum, prev) => sum + arcLength(prev.pct), 0),
    }));

    return (
        <div className="flex items-center gap-3.5 mt-2.5 flex-wrap">
            <svg
                width="132"
                height="132"
                viewBox="0 0 180 180"
                role="img"
                aria-label={slices.map(i => `${i.name} ${fmtSlicePct(i.pct)}`).join(', ')}
            >
                <circle cx="90" cy="90" r={RADIUS} fill="none" stroke="#1e293b" strokeWidth="22" />
                <g transform="rotate(-90 90 90)" fill="none" strokeWidth="22">
                    {arcs.map(arc => (
                        <circle
                            key={arc.item.id}
                            cx="90"
                            cy="90"
                            r={RADIUS}
                            stroke={arc.color}
                            strokeDasharray={`${arc.length} ${CIRCUMFERENCE - arc.length}`}
                            strokeDashoffset={-arc.offset}
                        />
                    ))}
                </g>
                <text x="90" y="84" textAnchor="middle" fill="#ffffff" fontSize="20" fontWeight="700" className="font-mono">
                    {fmtAmount(Math.round(totalUSD), 'CLP', isPrivacyMode)}
                </text>
                <text x="90" y="104" textAnchor="middle" fill="#94a3b8" fontSize="12">USD total</text>
            </svg>
            <ul className="flex flex-col gap-1.5 text-sm text-slate-300 min-w-0">
                {arcs.map(arc => (
                    <li key={arc.item.id}>
                        <span className="flex items-center gap-2">
                            <span className="inline-block w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: arc.color }} aria-hidden="true" />
                            <span className="truncate">{arc.item.name}</span>
                            <b className="font-mono text-slate-100">{fmtSlicePct(arc.item.pct)}</b>
                        </span>
                        <span className="block ml-[18px] font-mono text-[11px] text-slate-400">
                            {fmtMoney(arc.item.valueUSD, 'USD', isPrivacyMode)}
                        </span>
                    </li>
                ))}
            </ul>
        </div>
    );
}
