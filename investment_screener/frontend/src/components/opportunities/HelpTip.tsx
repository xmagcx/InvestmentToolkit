/**
 * HelpTip.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     The "?" help of each Oportunidades column: a real button (keyboard reachable) that shows
 *     its explanation on hover and on focus, as the artboard does with :focus-within.
 *
 * Layer: Frontend / UI / Opportunities
 *
 * Usage Examples:
 *     <HelpTip label="¿Es buen negocio?"><p>Cuánto gana por cada dólar…</p></HelpTip>
 */
import { useState, type ReactNode } from 'react';

export default function HelpTip({ label, align = 'left', children }: { label: string; align?: 'left' | 'right'; children: ReactNode }) {
    const [open, setOpen] = useState(false);

    return (
        <span
            className="relative inline-flex"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => setOpen(false)}
        >
            <button
                type="button"
                aria-label={`Qué significa: ${label}`}
                aria-expanded={open}
                className="h-[22px] w-[22px] cursor-help rounded-full border border-slate-600 bg-surface text-[11px] font-bold text-slate-300 hover:border-primary hover:text-amber-400 focus:border-primary focus:text-amber-400"
                onFocus={() => setOpen(true)}
                onBlur={() => setOpen(false)}
            >
                ?
            </button>
            {open && (
                <span
                    role="tooltip"
                    className={`absolute top-7 z-20 w-70 space-y-1.5 rounded-lg border border-slate-700 bg-surface p-3 text-left text-xs font-normal normal-case tracking-normal leading-relaxed text-slate-300 shadow-xl ${align === 'right' ? '-right-2' : '-left-2'}`}
                >
                    {children}
                </span>
            )}
        </span>
    );
}
