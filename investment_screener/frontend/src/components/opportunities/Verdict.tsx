/**
 * Verdict.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     The plain-language verdict chip of the Oportunidades table: Favorable (ok), Revisar (mid),
 *     Desfavorable (bad) and "sin datos / no aplica" (nd), per the artboard legend.
 *
 * Layer: Frontend / UI / Opportunities
 *
 * Usage Examples:
 *     <Verdict tone="ok">Excelente</Verdict>
 */
import type { ReactNode } from 'react';

const TONES: Record<string, string> = {
    ok: 'bg-emerald-400/10 text-emerald-300 border-emerald-400/30',
    mid: 'bg-amber-500/10 text-amber-400 border-amber-500/30',
    bad: 'bg-red-400/10 text-red-300 border-red-400/30',
    nd: 'bg-slate-800 text-slate-400 border-slate-700',
};

export default function Verdict({ tone, children }: { tone: 'ok' | 'mid' | 'bad' | 'nd'; children: ReactNode }) {
    return (
        <span className={`inline-flex max-w-full items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${TONES[tone]}`}>
            {children}
        </span>
    );
}
