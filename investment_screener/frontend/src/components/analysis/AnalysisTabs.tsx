/**
 * AnalysisTabs.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     Nivel 3 · Investigar (S16): the container with the 8 tab buttons and an empty panel slot.
 *     T7b fills the slot through `renderPanel`; this shell builds no tab content.
 *
 * Layer: Frontend / Components / Analysis
 */
import { useState, type ReactNode } from 'react';

export const ANALYSIS_TABS = ['Descripción', 'Financieros', 'Valoración', 'Inversores', 'Filings', 'Monte Carlo', 'Técnico', 'Noticias'] as const;
export type AnalysisTab = (typeof ANALYSIS_TABS)[number];

export function AnalysisTabs({ renderPanel }: { renderPanel?: (tab: AnalysisTab) => ReactNode }) {
    const [active, setActive] = useState<AnalysisTab>(ANALYSIS_TABS[0]);
    return (
        <section aria-label="Nivel 3 · Investigar" className="bg-slate-900/80 border border-slate-800 rounded-xl p-5 shadow-lg">
            <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-3">Nivel 3 · Investigar</p>
            <div role="tablist" className="flex flex-wrap gap-1 border-b border-slate-800">
                {ANALYSIS_TABS.map((t) => (
                    <button key={t} type="button" role="tab" id={`analysis-tab-${t}`} aria-selected={active === t} aria-controls="analysis-tab-panel"
                        onClick={() => setActive(t)}
                        className={`px-4 py-2.5 text-sm rounded-t-lg ${active === t ? 'bg-slate-800 text-primary' : 'text-secondary hover:bg-slate-800 hover:text-slate-200'}`}>
                        {t}
                    </button>
                ))}
            </div>
            <div role="tabpanel" id="analysis-tab-panel" aria-labelledby={`analysis-tab-${active}`} className="pt-4">
                {renderPanel?.(active)}
            </div>
        </section>
    );
}
