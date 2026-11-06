/**
 * SankeyChart.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Inline-SVG Sankey of where revenue goes (S8): graph from buildSankey(income_quarter). Emerald = profit,
 *     red = expense, slate = income. Has an svg <title>/<desc> that spell the flow out in text.
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <SankeyChart income={stock.overview.income_quarter} />
 */
import { useId } from 'react';
import type { StockOverviewIncome } from '../../services/api';
import { buildSankey, fmtNumEs, type SankeyKind } from '../../utils/analysisFormat';

const FILL: Record<SankeyKind, string> = { income: '#94a3b8', profit: '#34d399', expense: '#f87171' };
const compact = (v: number) => (Math.abs(v) >= 1e9 ? `${fmtNumEs(v / 1e9, 1)} B` : `${fmtNumEs(v / 1e6, 0)} M`);

export function SankeyChart({ income }: { income: StockOverviewIncome | null }) {
    const uid = useId();
    const g = buildSankey(income);
    if (!g || !income) return null;
    const W = 980, H = 410, NW = 12, GAP = 16, TOP = 25;
    const maxCol = Math.max(...g.nodes.map((n) => n.col));
    const perCol = (c: number) => g.nodes.filter((n) => n.col === c);
    const k = (H - TOP - 20 - GAP * (Math.max(...Array.from({ length: maxCol + 1 }, (_, c) => perCol(c).length)) - 1)) / g.nodes[0].value;
    const colX = (c: number) => 20 + (c * (W - 40 - 210)) / Math.max(maxCol, 1);
    const pos = new Map<string, { x: number; y: number; h: number; out: number; inn: number }>();
    for (let c = 0; c <= maxCol; c++) {
        let y = TOP;
        for (const n of perCol(c)) { const h = Math.max(n.value * k, 2); pos.set(n.id, { x: colX(c), y, h, out: 0, inn: 0 }); y += h + GAP; }
    }
    const byId = new Map(g.nodes.map((n) => [n.id, n]));
    const paths = g.links.map((l) => {
        const a = pos.get(l.from)!, b = pos.get(l.to)!, h = l.value * k;
        const x0 = a.x + NW, x1 = b.x, y0 = a.y + a.out + h / 2, y1 = b.y + b.inn + h / 2, m = (x0 + x1) / 2;
        a.out += h; b.inn += h;
        return <path key={`${l.from}-${l.to}`} d={`M${x0} ${y0} C${m} ${y0} ${m} ${y1} ${x1} ${y1}`} stroke={FILL[byId.get(l.to)!.kind]} strokeOpacity={0.35} strokeWidth={h} fill="none">
            <title>{`${byId.get(l.from)!.label} → ${byId.get(l.to)!.label}: ${compact(l.value)}`}</title>
        </path>;
    });
    const desc = `Trimestre ${income.period}. ${g.nodes.map((n) => `${n.label} ${compact(n.value)}`).join(', ')}.`;
    return (
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-labelledby={`${uid}t ${uid}d`}>
            <title id={`${uid}t`}>De dónde vienen los ingresos y a dónde van</title>
            <desc id={`${uid}d`}>{desc}</desc>
            {paths}
            {g.nodes.map((n) => {
                const p = pos.get(n.id)!;
                return (
                    <g key={n.id}>
                        <rect x={p.x} y={p.y} width={NW} height={p.h} fill={FILL[n.kind]} />
                        <text x={p.x + NW + 6} y={p.y + p.h / 2} dy={4} fontSize={12} fill="#e2e8f0">
                            {n.label} <tspan fill="#94a3b8" fontFamily="ui-monospace,monospace">{compact(n.value)}</tspan>
                        </text>
                    </g>
                );
            })}
        </svg>
    );
}
