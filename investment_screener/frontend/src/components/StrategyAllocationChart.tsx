/**
 * StrategyAllocationChart.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     Donut chart visualization of portfolio allocation across pillars, 
 *     sub-strategies, and sectors. Supports drill-down into holdings.
 *
 * Layer: Frontend / UI / Components
 *
 * Usage Examples:
 *     <StrategyAllocationChart data={allocationData} totalUSD={1350} />
 *
 * Key Functions:
 *     - shortLabel() - Maps long IDs/names to display labels
 *     - slice colours: utils/themeColors.assignCategoryColors (shared, distinct per chart)
 *     - fmtUSD() - Formats currency with US$ prefix
 *     - groupBySector() - Aggregates holdings by industry sector
 *     - groupBySubStrategy() - Aggregates holdings by sub-strategy tags
 *     - renderDonut() - Main D3 rendering for the allocation ring
 *     - renderHoldings() - Secondary visualization for individual positions
 */
import { useEffect, useRef, useState, useMemo } from 'react';
import * as d3 from 'd3';
import type { StrategyAllocationItem, StrategyHolding } from '../services/api';
import { assignCategoryColors } from '../utils/themeColors';
import { usePrivacy } from '../context/PrivacyContext';


const PILLAR_SHORT: Record<string, string> = {
    compute:   'Compute',
    titans:    'AI Titans',
    sovfin:    'Sov Finance',
    datainfra: 'Data Infra',
    power:     'Power',
    security:  'Security',
    applied:   'Applied AI',
    cash:      'Cash',
    quantum:   'Quantum',
    biohealth: 'BioHealth',
    other:     'Other',
};

const SUB_STRATEGY_NAMES: Record<string, string> = {
    'sa-asi-race':       'SA / ASI Race',
    'cybersecurity':     'AI Cybersecurity',
    'sovereign-finance': 'Sovereign Finance',
    'quality-saas':      'Quality SaaS',
    'frontier-bets':     'Frontier Bets',
    'quantum-compute':   'Quantum',
    'cash':              'Cash Reserve',
    'other':             'Unclassified',
};

const SUB_STRATEGY_SHORT: Record<string, string> = {
    'sa-asi-race':       'ASI Race',
    'cybersecurity':     'Cybersec',
    'sovereign-finance': 'Sov Finance',
    'quality-saas':      'SaaS',
    'frontier-bets':     'Frontier',
    'quantum-compute':   'Quantum',
    'cash':              'Cash',
    'other':             'Other',
};

type GroupBy = 'pillar' | 'sub-strategy' | 'sector';

function shortLabel(id: string, name: string, mode: GroupBy): string {
    if (mode === 'pillar') return PILLAR_SHORT[id] ?? name.split(' ')[0];
    if (mode === 'sub-strategy') return SUB_STRATEGY_SHORT[id] ?? name.split(' ').slice(0, 2).join(' ');
    if (name.length <= 12) return name;
    return name.split(' ').slice(0, 2).join(' ');
}


// ── formatting ────────────────────────────────────────────────────────────────

function fmtUSD(v: number, compact = false, isPrivacy = false): string {
    if (isPrivacy) return 'US$••••';
    if (compact && Math.abs(v) >= 1_000) return `US$${Math.round(v / 1_000)}k`;
    if (Math.abs(v) >= 1_000) return `US$${Math.round(v).toLocaleString()}`;
    return `US$${v.toFixed(0)}`;
}

// ── grouping helpers ──────────────────────────────────────────────────────────

interface ChartItem {
    id: string;
    name: string;
    valueUSD: number;
    pct: number;
    holdings: StrategyHolding[];
}

function groupBySector(data: StrategyAllocationItem[]): ChartItem[] {
    const totalUSD = data.reduce((s, d) => s + d.valueUSD, 0);
    const map: Record<string, { holdings: StrategyHolding[]; total: number }> = {};
    for (const pillar of data) {
        for (const h of pillar.holdings) {
            const sec = h.sector || 'Other';
            (map[sec] ??= { holdings: [], total: 0 }).holdings.push(h);
            map[sec].total += h.valueUSD;
        }
    }
    return Object.entries(map)
        .map(([sec, { holdings, total }]) => ({
            id: sec, name: sec,
            valueUSD: Math.round(total * 100) / 100,
            pct: totalUSD > 0 ? Math.round((total / totalUSD) * 10000) / 100 : 0,
            holdings: holdings.sort((a, b) => b.valueUSD - a.valueUSD),
        }))
        .sort((a, b) => b.valueUSD - a.valueUSD);
}

function groupBySubStrategy(data: StrategyAllocationItem[]): ChartItem[] {
    const totalUSD = data.reduce((s, d) => s + d.valueUSD, 0);
    const map: Record<string, { holdings: StrategyHolding[]; total: number }> = {};
    for (const pillar of data) {
        for (const h of pillar.holdings) {
            const subId = h.subStrategyId || 'other';
            (map[subId] ??= { holdings: [], total: 0 }).holdings.push(h);
            map[subId].total += h.valueUSD;
        }
    }
    return Object.entries(map)
        .map(([id, { holdings, total }]) => ({
            id,
            name: SUB_STRATEGY_NAMES[id] ?? id,
            valueUSD: Math.round(total * 100) / 100,
            pct: totalUSD > 0 ? Math.round((total / totalUSD) * 10000) / 100 : 0,
            holdings: holdings.sort((a, b) => b.valueUSD - a.valueUSD),
        }))
        .sort((a, b) => b.valueUSD - a.valueUSD);
}

// ── component ─────────────────────────────────────────────────────────────────

interface Props {
    data: StrategyAllocationItem[];
    /** Single source of truth for the portfolio's USD total — must come from
     * the same payload the page's total reads, never re-derived with an FX
     * rate. Slice values are already USD, so no conversion happens here. */
    totalUSD: number;
}

// GroupBy is declared above alongside the helpers

export default function StrategyAllocationChart({ data, totalUSD }: Props) {
    const { isPrivacyMode } = usePrivacy();
    const [groupBy, setGroupBy] = useState<GroupBy>('pillar');
    const [selectedId, setSelectedId] = useState<string | null>(null);

    const donutWrapRef    = useRef<HTMLDivElement>(null);
    const holdingsWrapRef = useRef<HTMLDivElement>(null);
    const donutSvgRef     = useRef<SVGSVGElement>(null);
    const holdingsSvgRef  = useRef<SVGSVGElement>(null);

    // Reset selection when mode switches
    useEffect(() => { setSelectedId(null); }, [groupBy]);

    // Derived chart data
    const chartData: ChartItem[] = useMemo(() => {
        if (groupBy === 'pillar') return data;
        if (groupBy === 'sub-strategy') return groupBySubStrategy(data);
        return groupBySector(data);
    }, [data, groupBy]);

    // One colour per slice, distinct within the chart (shared with the heatmap).
    const sliceColors = useMemo(
        () => assignCategoryColors(groupBy, chartData.map(d => d.id)),
        [chartData, groupBy],
    );

    // ── 1. Donut chart ───────────────────────────────────────────────────────
    useEffect(() => {
        const wrap  = donutWrapRef.current;
        const svgEl = donutSvgRef.current;
        if (!wrap || !svgEl || chartData.length === 0) return;

        const W         = wrap.getBoundingClientRect().width || 460;
        const H         = 280;
        const LABEL_PAD = 60;
        const radius    = Math.min((W - LABEL_PAD * 2) / 2, (H - 20) / 2);
        const innerR    = radius * 0.54;

        const svg = d3.select(svgEl);
        svg.selectAll('*').remove();
        svg.attr('width', W).attr('height', H);

        const g = svg.append('g').attr('transform', `translate(${W / 2},${H / 2})`);

        const pie = d3.pie<ChartItem>()
            .value(d => d.valueUSD)
            .sort((a, b) => b.valueUSD - a.valueUSD)
            .padAngle(0.016);

        const arc = d3.arc<d3.PieArcDatum<ChartItem>>()
            .innerRadius(innerR).outerRadius(radius).cornerRadius(3);
        const arcActive = d3.arc<d3.PieArcDatum<ChartItem>>()
            .innerRadius(innerR - 4).outerRadius(radius + 10).cornerRadius(3);

        const pieData = pie(chartData);

        // ── slices ───────────────────────────────────────────────────────────
        const slices = g.selectAll<SVGPathElement, d3.PieArcDatum<ChartItem>>('path.s')
            .data(pieData, d => d.data.id)
            .enter().append('path').attr('class', 's')
            .attr('d', d => arc(d) ?? '')
            .attr('fill', d => sliceColors[d.data.id])
            .attr('stroke', '#0a0f1a')
            .attr('stroke-width', 1.5)
            .attr('opacity', d => !selectedId || d.data.id === selectedId ? 1 : 0.25)
            .style('cursor', 'pointer');

        // Keep selected slice expanded
        if (selectedId) {
            const sel = pieData.find(d => d.data.id === selectedId);
            if (sel) slices.filter(d => d.data.id === selectedId).attr('d', arcActive(sel) ?? '');
        }

        // ── centre labels ────────────────────────────────────────────────────
        const selD = selectedId ? chartData.find(d => d.id === selectedId) : null;

        const cTitle = g.append('text').attr('text-anchor', 'middle').attr('y', -18)
            .attr('fill', '#475569').attr('font-size', '9.5px').attr('font-weight', '700')
            .attr('letter-spacing', '1.8px')
            .text(selD ? shortLabel(selD.id, selD.name, groupBy).toUpperCase() : 'PORTFOLIO');

        const cValue = g.append('text').attr('text-anchor', 'middle').attr('y', 4)
            .attr('fill', '#f1f5f9').attr('font-size', '18px').attr('font-weight', '700')
            .text(selD ? fmtUSD(selD.valueUSD, false, isPrivacyMode) : fmtUSD(totalUSD, false, isPrivacyMode));

        const cPct = g.append('text').attr('text-anchor', 'middle').attr('y', 21)
            .attr('fill', '#64748b').attr('font-size', '11px')
            .text(selD ? `${selD.pct.toFixed(1)}%` : '');

        g.append('text').attr('text-anchor', 'middle').attr('y', 37)
            .attr('fill', '#1e3048').attr('font-size', '8.5px').attr('letter-spacing', '1px')
            .text('USD');

        // ── hover & click ────────────────────────────────────────────────────
        slices
            .on('mouseenter', function(_ev, d) {
                if (d.data.id !== selectedId)
                    d3.select(this).raise().transition().duration(90).attr('d', arcActive(d) ?? '');
                cTitle.text(shortLabel(d.data.id, d.data.name, groupBy).toUpperCase());
                cValue.text(fmtUSD(d.data.valueUSD, false, isPrivacyMode));
                cPct.text(`${d.data.pct.toFixed(1)}%`);
            })
            .on('mouseleave', function(_ev, d) {
                if (d.data.id !== selectedId)
                    d3.select(this).transition().duration(90).attr('d', arc(d) ?? '');
                const s = selectedId ? chartData.find(x => x.id === selectedId) : null;
                cTitle.text(s ? shortLabel(s.id, s.name, groupBy).toUpperCase() : 'PORTFOLIO');
                cValue.text(s ? fmtUSD(s.valueUSD, false, isPrivacyMode) : fmtUSD(totalUSD, false, isPrivacyMode));
                cPct.text(s ? `${s.pct.toFixed(1)}%` : '');
            })
            .on('click', (_ev, d) => setSelectedId(p => p === d.data.id ? null : d.data.id));

        // ── arc labels with leader lines ─────────────────────────────────────
        const labelG = g.append('g');

        pieData.forEach(d => {
            if (d.data.pct < 1.5) return;

            const mid      = (d.startAngle + d.endAngle) / 2;
            const isRight  = Math.sin(mid) >= 0;
            const anchor   = isRight ? 'start' : 'end';
            const isActive = !selectedId || d.data.id === selectedId;
            const col      = sliceColors[d.data.id];

            const ex = Math.sin(mid) * (radius + 10);
            const ey = -Math.cos(mid) * (radius + 10);
            const tx = Math.sin(mid) * (radius + 28) + (isRight ? 6 : -6);
            const ty = -Math.cos(mid) * (radius + 28);

            labelG.append('polyline')
                .attr('points', `${Math.sin(mid) * radius},${-Math.cos(mid) * radius} ${ex},${ey} ${tx},${ty}`)
                .attr('fill', 'none')
                .attr('stroke', col).attr('stroke-width', 0.8)
                .attr('opacity', isActive ? 0.5 : 0.1);

            labelG.append('text')
                .attr('x', tx).attr('y', ty - 2)
                .attr('text-anchor', anchor)
                .attr('fill', isActive ? '#94a3b8' : '#253040')
                .attr('font-size', '10px')
                .text(shortLabel(d.data.id, d.data.name, groupBy));

            labelG.append('text')
                .attr('x', tx).attr('y', ty + 10)
                .attr('text-anchor', anchor)
                .attr('fill', isActive ? col : '#253040')
                .attr('font-size', '10.5px').attr('font-weight', '700')
                .text(`${d.data.pct.toFixed(1)}%`);
        });

    }, [chartData, sliceColors, groupBy, selectedId, totalUSD]);

    // ── 2. Holdings bar chart ─────────────────────────────────────────────────
    useEffect(() => {
        const wrap  = holdingsWrapRef.current;
        const svgEl = holdingsSvgRef.current;
        if (!wrap || !svgEl) return;

        const W   = wrap.getBoundingClientRect().width || 360;
        const svg = d3.select(svgEl);
        svg.selectAll('*').remove();

        const pillar = selectedId ? chartData.find(d => d.id === selectedId) : null;

        if (!pillar) {
            const H = 280;
            svg.attr('width', W).attr('height', H);
            const mid = H / 2;

            svg.append('circle')
                .attr('cx', W / 2).attr('cy', mid - 20).attr('r', 32)
                .attr('fill', 'none').attr('stroke', '#1e293b').attr('stroke-width', 2)
                .attr('stroke-dasharray', '4 3');

            svg.append('text')
                .attr('x', W / 2).attr('y', mid - 20)
                .attr('text-anchor', 'middle').attr('dominant-baseline', 'middle')
                .attr('fill', '#334155').attr('font-size', '22px').text('←');

            svg.append('text')
                .attr('x', W / 2).attr('y', mid + 18)
                .attr('text-anchor', 'middle').attr('fill', '#334155').attr('font-size', '12px')
                .text('Click a strategy slice');

            svg.append('text')
                .attr('x', W / 2).attr('y', mid + 33)
                .attr('text-anchor', 'middle').attr('fill', '#1e2d3d').attr('font-size', '12px')
                .text('to explore its holdings');
            return;
        }

        const holdings = pillar.holdings;
        const col      = sliceColors[pillar.id];

        const ROW_H    = 34;
        const LABEL_W  = 78;
        const VAL_W    = 78;
        const TOP      = 58;
        const PAD      = 5;
        const BAR_AREA = W - LABEL_W - VAL_W - 20;
        const H        = TOP + holdings.length * (ROW_H + PAD) + 20;

        svg.attr('width', W).attr('height', H);

        const maxVal = d3.max(holdings, h => h.valueUSD) ?? 1;
        const xScale = d3.scaleLinear().domain([0, maxVal]).range([0, BAR_AREA]);

        // Header
        const headLine = pillar.name.split(' — ')[0].split(' / ')[0];
        svg.append('text')
            .attr('x', LABEL_W).attr('y', 22)
            .attr('fill', col).attr('font-size', '13px').attr('font-weight', '700')
            .text(headLine);

        svg.append('text')
            .attr('x', LABEL_W).attr('y', 40)
            .attr('fill', '#475569').attr('font-size', '10.5px')
            .text(`${holdings.length} position${holdings.length !== 1 ? 's' : ''} · ${fmtUSD(pillar.valueUSD)} total`);

        const rows = svg.selectAll<SVGGElement, StrategyHolding>('g.row')
            .data(holdings)
            .enter().append('g').attr('class', 'row')
            .attr('transform', (_d, i) => `translate(0,${TOP + i * (ROW_H + PAD)})`);

        rows.append('text')
            .attr('x', LABEL_W - 8).attr('y', ROW_H / 2 + 4)
            .attr('text-anchor', 'end')
            .attr('fill', '#64748b').attr('font-size', '11px').attr('font-weight', '600')
            .text(d => d.symbol);

        rows.append('rect')
            .attr('x', LABEL_W).attr('y', 6)
            .attr('width', BAR_AREA).attr('height', ROW_H - 12)
            .attr('fill', '#0d1626').attr('rx', 3);

        rows.append('rect')
            .attr('x', LABEL_W).attr('y', 6)
            .attr('width', 0).attr('height', ROW_H - 12)
            .attr('fill', col).attr('opacity', 0.72).attr('rx', 3)
            .transition().duration(450).ease(d3.easeCubicOut)
            .attr('width', d => xScale(d.valueUSD));

        rows.append('text')
            .attr('x', LABEL_W + BAR_AREA + 8).attr('y', ROW_H / 2 + 4)
            .attr('fill', '#94a3b8').attr('font-size', '10.5px')
            .text(d => fmtUSD(d.valueUSD, true, isPrivacyMode));

        rows.append('text')
            .attr('x', W - 6).attr('y', ROW_H / 2 + 4)
            .attr('text-anchor', 'end')
            .attr('fill', '#3d5166').attr('font-size', '10px')
            .text(d => `${d.pct.toFixed(1)}%`);

    }, [chartData, sliceColors, groupBy, selectedId]);

    // ── render ────────────────────────────────────────────────────────────────
    return (
        <div className="space-y-3">
            {/* Toggle */}
            <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-slate-600 font-semibold uppercase tracking-wider">Group by</span>
                <div className="flex items-center bg-slate-800/80 rounded-lg p-1 gap-0.5">
                    {([
                        ['pillar',        'Thesis Pillar'],
                        ['sub-strategy',  'Sub-Strategy'],
                        ['sector',        'Sector'],
                    ] as const).map(([mode, label]) => (
                        <button
                            key={mode}
                            onClick={() => setGroupBy(mode)}
                            className={`px-3 py-1 text-xs rounded-md font-semibold transition-all duration-150 ${
                                groupBy === mode
                                    ? 'bg-slate-600 text-white shadow'
                                    : 'text-slate-500 hover:text-slate-300'
                            }`}
                        >
                            {label}
                        </button>
                    ))}
                </div>
                {selectedId && (
                    <button
                        onClick={() => setSelectedId(null)}
                        className="ml-1 text-xs text-slate-600 hover:text-slate-400 transition-colors"
                    >
                        ✕ Clear
                    </button>
                )}
            </div>

            {/* Charts */}
            <div className="flex gap-4 w-full items-start">
                <div ref={donutWrapRef} style={{ width: '58%', minWidth: 0 }}>
                    <svg ref={donutSvgRef} />
                </div>
                <div ref={holdingsWrapRef} style={{ flex: 1, minWidth: 0 }}>
                    <svg ref={holdingsSvgRef} />
                </div>
            </div>
        </div>
    );
}
