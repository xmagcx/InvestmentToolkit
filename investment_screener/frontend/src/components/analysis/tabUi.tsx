/**
 * tabUi.tsx (React Presentation Components)
 * =====================================
 *
 * Purpose: small pieces shared by the Nivel 3 tab panels: status message, "—" cell, pill, and the aria-pressed segmented control.
 * Layer: Frontend / Components / Analysis
 */
import type { ReactNode } from 'react';

export const DASH = '—';
export const Note = ({ children }: { children: ReactNode }) => <p className="text-xs text-slate-400 mt-2">{children}</p>;
export const Loading = ({ children }: { children: ReactNode }) => <p role="status" className="text-slate-500 text-sm animate-pulse">{children}</p>;
export const Empty = ({ children }: { children: ReactNode }) => <p className="text-slate-400 text-sm text-center py-8">{children}</p>;
export const Pill = ({ tone = '', children }: { tone?: string; children: ReactNode }) => (
    <span className={`inline-block whitespace-nowrap shrink-0 rounded px-2 py-0.5 text-xs font-semibold bg-slate-800 border border-slate-700 ${tone || 'text-slate-200'}`}>{children}</span>
);
export const SectionTitle = ({ children }: { children: ReactNode }) => <h3 className="text-lg font-semibold text-slate-100 mb-2">{children}</h3>;

export function Seg<T extends string>({ label, value, options, onChange }: {
    label: string; value: T; options: Array<{ value: T; text: string }>; onChange: (v: T) => void;
}) {
    return (
        <div role="group" aria-label={label} className="inline-flex rounded-lg border border-slate-700 overflow-hidden">
            {options.map((o) => (
                <button key={o.value} type="button" aria-pressed={value === o.value} onClick={() => onChange(o.value)}
                    className={`px-3 py-1.5 text-sm ${value === o.value ? 'bg-slate-800 text-primary' : 'text-slate-400 hover:bg-slate-800/60'}`}>
                    {o.text}
                </button>
            ))}
        </div>
    );
}

export const TABLE_WRAP = 'overflow-x-auto rounded-lg border border-slate-700';
export const TH = 'px-4 py-2 font-medium text-left';
export const TD_NUM = 'px-4 py-2 text-right font-mono';
