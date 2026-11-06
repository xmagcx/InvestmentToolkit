/**
 * HelpTip.tsx (React Presentation Component)
 * =====================================
 *
 * Purpose:
 *     The "?" of the Análisis page (S4): a button whose non-modal popover shows Qué es / Cómo se lee /
 *     En <empresa> / Fuente / cálculo. Opens on hover, focus and click (click pins it); closes on Escape and blur.
 *
 * Layer: Frontend / Components / Analysis
 * Usage Examples: <HelpTip term="roic" ctx={{ company, value, price, fairValue, upside }} />
 */
import { useEffect, useId, useState } from 'react';
import { GLOSSARY, type GlossaryCtx, type GlossaryKey } from './glossary';

export function HelpTip({ term, ctx }: { term: GlossaryKey; ctx: GlossaryCtx }) {
    const [open, setOpen] = useState(false);
    const [pinned, setPinned] = useState(false);
    const id = useId();
    const entry = GLOSSARY[term];

    const close = () => { setOpen(false); setPinned(false); };

    useEffect(() => {
        if (!open) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [open]);

    return (
        <span
            className="relative inline-block"
            onMouseEnter={() => setOpen(true)}
            onMouseLeave={() => { if (!pinned) setOpen(false); }}
        >
            <button
                type="button"
                aria-label={`¿Qué es ${entry.name}?`}
                aria-expanded={open}
                aria-controls={open ? id : undefined}
                onFocus={() => setOpen(true)}
                onBlur={close}
                onClick={() => (pinned ? close() : (setOpen(true), setPinned(true)))}
                className="ml-1 inline-flex h-4 w-4 items-center justify-center rounded-full border border-slate-600 text-[10px] font-bold text-slate-400 hover:border-primary hover:text-primary"
            >
                ?
            </button>
            {open && (
                <span
                    id={id}
                    role="tooltip"
                    className="absolute left-1/2 top-full z-30 mt-2 block w-72 -translate-x-1/2 rounded-lg border border-slate-700 bg-slate-900 p-3 text-left text-xs font-normal normal-case tracking-normal text-slate-300 shadow-xl"
                >
                    <strong className="mb-1 block text-sm text-white">{entry.name}</strong>
                    <b className="block text-slate-400">Qué es</b>
                    <span className="mb-1 block">{entry.what}</span>
                    <b className="block text-slate-400">Cómo se lee</b>
                    <span className="mb-1 block">{entry.read}</span>
                    <b className="block text-slate-400">{`En ${ctx.company}`}</b>
                    <span className="mb-1 block">{entry.inCompany(ctx)}</span>
                    <b className="block text-slate-400">Fuente / cálculo</b>
                    <span className="block">{entry.source}</span>
                </span>
            )}
        </span>
    );
}
