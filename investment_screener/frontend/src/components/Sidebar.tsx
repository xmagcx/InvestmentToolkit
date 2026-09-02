/**
 * Sidebar.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     Main navigation sidebar. Primary nav items + compact Portfolio Sync utility.
 *     Link Account and Manual Portfolio are in Settings.
 *
 * Layer: Frontend / UI / Layout
 */
import { useState, useEffect } from 'react';
import { Settings, History, Grid3X3, BarChart3, Search, RefreshCcw, TableProperties, PieChart, ScrollText, FileText, BookOpen, Zap, Globe, Eye, EyeOff } from 'lucide-react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useRecentTickers } from '../hooks/useRecentTickers';
import { syncAndRefreshPortfolio, fetchSyncStatus } from '../services/api';
import { usePrivacy } from '../context/PrivacyContext';

const NAV_ITEMS = [
    { name: 'Heatmap',          icon: Grid3X3,        path: '/' },
    { name: 'Portfolio Summary', icon: PieChart,       path: '/portfolio-summary' },
    { name: 'Portfolio Table',   icon: TableProperties, path: '/portfolio-table' },
    { name: 'Portfolio Advisor', icon: Search,          path: '/screener' },
    { name: 'Stock Analysis',    icon: BarChart3,       path: '/analysis' },
    { name: 'Daily Brief',        icon: Zap,             path: '/daily-brief' },
    { name: 'Trade Log',         icon: ScrollText,      path: '/trade-log' },
    { name: 'Investment Theses', icon: BookOpen,        path: '/theses' },
    { name: '13F — SA LP',       icon: FileText,        path: '/13f' },
    { name: 'Candidate Universe', icon: Globe,          path: '/universe' },
];

export default function Sidebar() {
    const { recentTickers } = useRecentTickers();
    const navigate = useNavigate();
    const { isPrivacyMode, togglePrivacyMode } = usePrivacy();
    const [isSyncing, setIsSyncing] = useState(false);
    const [syncFeedback, setSyncFeedback] = useState<string | null>(null);
    const [lastSync, setLastSync] = useState<string | null>(null);

    useEffect(() => {
        const updateSyncTime = () => {
            fetchSyncStatus()
                .then(({ lastSync }) => setLastSync(lastSync))
                .catch(() => {});
        };

        updateSyncTime();

        window.addEventListener('portfolio-synced', updateSyncTime);
        return () => window.removeEventListener('portfolio-synced', updateSyncTime);
    }, []);

    const handleSync = async () => {
        setIsSyncing(true);
        setSyncFeedback(null);
        try {
            const result = await syncAndRefreshPortfolio();
            const { lastSync: ts } = await fetchSyncStatus();
            setLastSync(ts);
            setSyncFeedback(result.success ? 'Synced' : 'Failed');
        } catch {
            setSyncFeedback('Failed');
        } finally {
            // Always broadcast so pages refresh from the latest data — domain_model.sqlite
            // is the primary source; portfolio.json is only a manual-edit fallback
            window.dispatchEvent(new CustomEvent('portfolio-synced'));
            setIsSyncing(false);
            setTimeout(() => setSyncFeedback(null), 3000);
        }
    };

    const formatTime = (iso: string | null) => {
        if (!iso) return 'Never';
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    };

    const navCls = ({ isActive }: { isActive: boolean }) =>
        `flex items-center gap-3 px-4 py-2.5 rounded-lg transition-colors text-sm font-medium ${
            isActive ? 'bg-slate-800 text-primary' : 'text-secondary hover:bg-slate-800 hover:text-slate-200'
        }`;

    return (
        <aside className="w-60 h-screen bg-surface border-r border-slate-800 flex flex-col fixed left-0 top-0 z-[40]">

            {/* Logo */}
            <div className="px-5 pt-5 pb-3">
                <h1 className="text-lg font-bold text-primary flex items-center gap-2">
                    <span className="text-xl">⚡</span> Investment Toolkit
                </h1>
            </div>

            {/* Search */}
            <div className="px-4 pb-3">
                <div className="relative">
                    <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input
                        type="text"
                        placeholder="Search ticker…"
                        onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                                const val = e.currentTarget.value.trim().toUpperCase();
                                if (val) navigate(`/analysis?ticker=${val}`);
                            }
                        }}
                        className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-8 pr-3 py-2 text-sm text-white focus:border-primary focus:outline-none placeholder:text-slate-500"
                    />
                </div>
            </div>

            {/* Primary Navigation */}
            <nav className="flex-1 px-3 space-y-0.5 overflow-y-auto">
                {NAV_ITEMS.map(item => (
                    <NavLink key={item.name} to={item.path} className={navCls}>
                        <item.icon size={18} />
                        <span>{item.name}</span>
                    </NavLink>
                ))}

                {/* Thin divider */}
                <div className="pt-3 pb-1 px-1">
                    <div className="h-px bg-slate-800" />
                </div>

                {/* Portfolio Sync — compact single-line utility */}
                <button
                    onClick={handleSync}
                    disabled={isSyncing}
                    className="flex items-center gap-2.5 px-4 py-2 rounded-lg w-full transition-colors text-slate-500 hover:text-slate-300 hover:bg-slate-800/60 group relative"
                >
                    <RefreshCcw
                        size={15}
                        className={isSyncing ? 'animate-spin text-amber-500' : 'group-hover:text-amber-400 transition-colors'}
                    />
                    <span className="text-xs font-medium">
                        {isSyncing ? 'Syncing…' : `Sync  ·  ${formatTime(lastSync)}`}
                    </span>
                    {syncFeedback && (
                        <span className={`absolute right-3 text-[10px] font-bold ${syncFeedback === 'Failed' ? 'text-red-500' : 'text-emerald-500'}`}>
                            {syncFeedback}
                        </span>
                    )}
                </button>
            </nav>

            {/* Recent Tickers */}
            {recentTickers.length > 0 && (
                <div className="px-3 py-3 border-t border-slate-800">
                    <div className="flex items-center gap-1.5 px-2 mb-2">
                        <History size={11} className="text-slate-600" />
                        <span className="text-[10px] font-bold text-slate-600 uppercase tracking-widest">Recent</span>
                    </div>
                    <div className="flex flex-wrap gap-1 px-1">
                        {recentTickers.slice(0, 6).map(ticker => (
                            <button
                                key={ticker}
                                onClick={() => navigate(`/analysis?ticker=${ticker}`)}
                                className="px-2 py-0.5 text-xs text-slate-400 hover:text-primary hover:bg-slate-800 rounded transition-colors font-mono"
                            >
                                {ticker}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {/* Settings & Privacy Toggle — bottom */}
            <div className="px-3 pb-3 border-t border-slate-800 pt-2 space-y-1">
                <button
                    onClick={togglePrivacyMode}
                    className={`flex items-center gap-3 px-4 py-2 rounded-lg w-full transition-colors text-sm font-medium ${
                        isPrivacyMode ? 'bg-amber-500/10 text-amber-400 border border-amber-500/30' : 'text-slate-400 hover:bg-slate-800 hover:text-slate-200'
                    }`}
                    title={isPrivacyMode ? 'Disable Privacy / Demo Mode' : 'Enable Privacy / Demo Mode (Mask Balances)'}
                >
                    {isPrivacyMode ? <EyeOff size={17} className="text-amber-400" /> : <Eye size={17} />}
                    <span className="text-xs">{isPrivacyMode ? 'Demo Mode (Active)' : 'Privacy / Demo'}</span>
                </button>

                <NavLink to="/settings" className={navCls}>
                    <Settings size={18} />
                    <span>Settings</span>
                </NavLink>
            </div>
        </aside>
    );
}
