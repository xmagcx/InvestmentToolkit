# Investment Toolkit — Design system (synced)

Synced read-only from the project. Sources read:

- `investment_screener/frontend/src/index.css`
- `investment_screener/frontend/tailwind.config.js`
- `investment_screener/frontend/src/components/Sidebar.tsx`
- `investment_screener/frontend/src/components/PortfolioSummaryCards.tsx`
- `investment_screener/frontend/src/components/PortfolioBreakdown.tsx`
- `investment_screener/frontend/src/pages/PortfolioSummaryPage.tsx`
- `investment_screener/frontend/src/pages/PortfolioMaintainerPage.tsx`

Two kinds of entries:

- **Named tokens** — declared with an explicit value in `index.css` (`@theme`) and `tailwind.config.js`.
- **Palette classes** — Tailwind utility classes actually used by the pages above. The class name is what the source contains; the hex is the Tailwind default palette value the class resolves to (the project declares no palette override beyond the named tokens).

---

## Colors — named tokens

| Token | Value | Usage | Source |
| --- | --- | --- | --- |
| `--color-background` | `#020617` (slate-950) | App background (`body`) | `src/index.css`, `tailwind.config.js` |
| `--color-surface` | `#0f172a` (slate-900) | Sidebar background, scrollbar track | `src/index.css`, `tailwind.config.js`, `components/Sidebar.tsx` |
| `--color-primary` | `#f59e0b` (amber-500) | Logo, active nav item, focus ring, input focus border | `src/index.css`, `tailwind.config.js`, `components/Sidebar.tsx` |
| `--color-secondary` | `#94a3b8` (slate-400) | Inactive nav label | `src/index.css`, `tailwind.config.js`, `components/Sidebar.tsx` |
| `--color-text` | `#e2e8f0` (slate-200) | Default body text | `src/index.css`, `tailwind.config.js` |
| `--color-accent` | `#fbbf24` (amber-400) | Accent / hover on sync icon | `src/index.css`, `tailwind.config.js` |

## Colors — palette classes in use

| Class | Hex | Usage | Source |
| --- | --- | --- | --- |
| `bg-slate-900/80` | `#0f172a` at 80% | Card background | `components/PortfolioSummaryCards.tsx`, `components/PortfolioBreakdown.tsx` |
| `border-slate-800` | `#1e293b` | Card border, sidebar border, table row divider | `components/PortfolioSummaryCards.tsx`, `components/Sidebar.tsx` |
| `bg-slate-800` | `#1e293b` | Active nav background, table head, secondary button | `components/Sidebar.tsx`, `pages/PortfolioMaintainerPage.tsx` |
| `border-slate-700` | `#334155` | Input border, panel/table border | `components/Sidebar.tsx`, `pages/PortfolioMaintainerPage.tsx` |
| `text-slate-600` | `#475569` | Card icon, caption text | `components/PortfolioSummaryCards.tsx`, `components/PortfolioBreakdown.tsx` |
| `text-slate-500` | `#64748b` | Card label (uppercase), placeholder | `components/PortfolioSummaryCards.tsx`, `components/Sidebar.tsx` |
| `text-slate-400` | `#94a3b8` | Secondary text, table cell label | `pages/PortfolioMaintainerPage.tsx` |
| `text-slate-300` | `#cbd5e1` | Table value text, section sub-label | `components/PortfolioBreakdown.tsx`, `pages/PortfolioMaintainerPage.tsx` |
| `text-slate-200` | `#e2e8f0` | Table primary cell, nav hover | `pages/PortfolioMaintainerPage.tsx` |
| `text-white` | `#ffffff` | Page title `h1`, primary button label | `pages/PortfolioSummaryPage.tsx`, `pages/PortfolioMaintainerPage.tsx` |
| `text-emerald-400` | `#34d399` | Positive delta | `components/PortfolioBreakdown.tsx` |
| `text-emerald-300` | `#6ee7b7` | Wallet balance, success message | `pages/PortfolioMaintainerPage.tsx` |
| `bg-emerald-700` / `hover:bg-emerald-600` | `#047857` / `#059669` | Primary action button | `pages/PortfolioMaintainerPage.tsx` |
| `bg-emerald-900/40` + `border-emerald-800` | `#064e3b` / `#065f46` | Success banner | `pages/PortfolioMaintainerPage.tsx` |
| `shadow-emerald-500/10` | `#10b981` at 10% | Positive card glow | `components/PortfolioSummaryCards.tsx` |
| `text-red-400` | `#f87171` | Negative delta, error text | `components/PortfolioBreakdown.tsx`, `pages/PortfolioSummaryPage.tsx` |
| `text-red-300` + `bg-red-900/40` + `border-red-800` | `#fca5a5` / `#7f1d1d` / `#991b1b` | Error banner, destructive button | `pages/PortfolioMaintainerPage.tsx` |
| `shadow-red-500/10` | `#ef4444` at 10% | Negative card glow | `components/PortfolioSummaryCards.tsx` |
| `text-amber-400` | `#fbbf24` | Exchange-rate value, partial-refresh notice | `components/PortfolioSummaryCards.tsx`, `pages/PortfolioSummaryPage.tsx` |
| `bg-amber-500/10` + `border-amber-500/30` + `text-amber-400` | `#f59e0b` tints | Active toggle (privacy mode) | `components/Sidebar.tsx` |
| `bg-amber-800` / `text-amber-100` | `#92400e` / `#fef3c7` | Secondary warning button | `pages/PortfolioMaintainerPage.tsx` |
| `bg-zinc-800` / `text-zinc-300` / `hover:bg-zinc-700` | `#27272a` / `#d4d4d8` / `#3f3f46` | Refresh button in the page header | `pages/PortfolioSummaryPage.tsx` |
| `bg-black/60` | `#000000` at 60% | Dialog backdrop | `pages/PortfolioMaintainerPage.tsx` |

**Contrast note (not from source):** `text-slate-500` `#64748b` on `bg-slate-900` `#0f172a` measures 3.76:1, below WCAG AA for normal text. Designs here use `#94a3b8` (slate-400, 7.0:1) for small labels and keep `#64748b` only for large/bold uppercase labels at ≥18.66px bold or decorative glyphs.

## Typography

| Entry | Value | Source |
| --- | --- | --- |
| Font family | `Inter, sans-serif` (`--font-sans`, no `@font-face`, no remote load) | `src/index.css`, `tailwind.config.js` |
| Page title | `text-xl font-bold text-white` (20px/700) | `pages/PortfolioSummaryPage.tsx` |
| Page title (maintainer) | `text-2xl font-bold` (24px/700) | `pages/PortfolioMaintainerPage.tsx` |
| Card hero value | `text-3xl font-bold` (30px/700) | `components/PortfolioSummaryCards.tsx` |
| Period value | `text-xl font-bold` (20px/700) | `pages/PortfolioSummaryPage.tsx` |
| Section heading | `text-lg font-semibold text-slate-100` (18px/600) | `pages/PortfolioMaintainerPage.tsx` |
| Card label | `text-xs font-bold uppercase tracking-widest text-slate-500` (12px/700, `letter-spacing: 0.1em`) | `components/PortfolioSummaryCards.tsx` |
| Table / body | `text-sm` (14px) | `pages/PortfolioMaintainerPage.tsx` |
| Caption | `text-xs text-slate-600` (12px) | `components/PortfolioBreakdown.tsx` |
| Micro label | `text-[10px] font-bold uppercase tracking-widest` | `components/Sidebar.tsx` |
| Numeric cells | `font-mono` | `pages/PortfolioMaintainerPage.tsx` |

## Spacing

| Entry | Value | Source |
| --- | --- | --- |
| Page padding | `p-4` (16px) / `p-6` (24px) | `pages/PortfolioSummaryPage.tsx`, `pages/PortfolioMaintainerPage.tsx` |
| Section gap | `space-y-4` / `gap-3` (16px / 12px) | `pages/PortfolioSummaryPage.tsx` |
| Card padding | `p-4` (16px), `p-5` (20px) | `components/PortfolioSummaryCards.tsx`, `components/PortfolioBreakdown.tsx` |
| Card inner row gap | `space-y-1.5` (6px) | `components/PortfolioSummaryCards.tsx` |
| Table cell padding | `px-4 py-2` (16px/8px), header `pb-3` | `pages/PortfolioMaintainerPage.tsx`, `components/PortfolioBreakdown.tsx` |
| Nav item padding | `px-4 py-2.5` (16px/10px) | `components/Sidebar.tsx` |
| Sidebar width | `w-60` (240px), full height, fixed | `components/Sidebar.tsx` |
| Button padding | `px-3 py-1.5` / `px-4 py-2` | `pages/PortfolioMaintainerPage.tsx` |

## Radius

| Entry | Value | Source |
| --- | --- | --- |
| `rounded-xl` | 12px — cards | `components/PortfolioSummaryCards.tsx`, `components/PortfolioBreakdown.tsx` |
| `rounded-lg` | 8px — nav items, inputs, panels, tables | `components/Sidebar.tsx`, `pages/PortfolioMaintainerPage.tsx` |
| `rounded` | 4px — buttons, banners, small chips | `pages/PortfolioMaintainerPage.tsx`, `pages/PortfolioSummaryPage.tsx` |
| `rounded-full` | pill — scrollbar thumb | `src/index.css` |

## Shadows and effects

| Entry | Value | Source |
| --- | --- | --- |
| Card shadow | `shadow-lg` | `components/PortfolioSummaryCards.tsx` |
| Card hover | `box-shadow: 0 4px 20px rgba(0,0,0,0.3)` | `src/index.css` |
| Dialog shadow | `shadow-xl` | `pages/PortfolioMaintainerPage.tsx` |
| Positive / negative glow | `shadow-emerald-500/10`, `shadow-red-500/10` | `components/PortfolioSummaryCards.tsx` |
| Focus ring | `box-shadow: 0 0 0 2px rgba(245,158,11,0.3)` on `input:focus`, `button:focus` | `src/index.css` |
| Transition | `all 0.2s ease-in-out` on `button, input, a, .card`; `button:hover { translateY(-1px) }` | `src/index.css` |
| Skeleton | `shimmer` 1.5s infinite, gradient slate-900 → slate-800 → slate-900 | `src/index.css` |
| Loading pulse | `animate-pulse` on `bg-slate-800` blocks | `pages/PortfolioSummaryPage.tsx` |

## Component rules

- **Card** — `bg-slate-900/80 border border-slate-800 rounded-xl p-4 shadow-lg`; uppercase `text-xs` label top-left, 16px icon top-right, `text-3xl` hero value, then label/value rows at `text-sm`. Source: `components/PortfolioSummaryCards.tsx`.
- **Sidebar** — fixed 240px, `bg-surface`, `border-r border-slate-800`; amber logo row; search input `bg-slate-900 border-slate-700 rounded-lg`; nav item `px-4 py-2.5 rounded-lg`, active = `bg-slate-800 text-primary`, inactive = `text-secondary` with `hover:bg-slate-800 hover:text-slate-200`; bottom block separated by `border-t border-slate-800`. Source: `components/Sidebar.tsx`.
- **Table** — wrapper `overflow-x-auto rounded-lg border border-slate-700`; head `bg-slate-800 text-left text-slate-400`; body `divide-y divide-slate-700`; row hover `hover:bg-slate-800/40`; numbers right-aligned and `font-mono`; empty cell renders `—`. Source: `pages/PortfolioMaintainerPage.tsx`.
- **Deltas** — positive `text-emerald-400` with `+` sign, negative `text-red-400`, zero `text-slate-400`; percentage with 2 decimals. Source: `components/PortfolioBreakdown.tsx`, `utils/formatters` usage in `pages/PortfolioSummaryPage.tsx`.
- **Buttons** — primary `rounded bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600`; secondary `bg-slate-700 text-slate-200 hover:bg-slate-600`; header utility `bg-zinc-800 text-zinc-300 text-xs hover:bg-zinc-700`; destructive `bg-red-900/60 text-red-300`; `disabled:opacity-50`. Source: `pages/PortfolioMaintainerPage.tsx`, `pages/PortfolioSummaryPage.tsx`.
- **Banners** — success `rounded border border-emerald-800 bg-emerald-900/40 px-4 py-2 text-sm text-emerald-300`; error `border-red-800 bg-red-900/40 text-red-300`; partial refresh notice `text-xs text-amber-400` with `role="status"`. Source: `pages/PortfolioMaintainerPage.tsx`, `pages/PortfolioSummaryPage.tsx`.
- **States** — loading = `text-slate-500 text-sm` message or `animate-pulse` blocks; error = `text-red-400 text-sm`; empty = `text-slate-600 text-sm` centred in the panel. Source: `pages/PortfolioSummaryPage.tsx`.
- **Missing price** — a position with no stored market price shows no value, never its cost. Source: header contract of `pages/PortfolioMaintainerPage.tsx`.
