/**
 * SourcesPage.tsx (React Page)
 * =====================================
 *
 * Purpose:
 *     "Fuentes" page (S4): one card per registered investment source with its last run,
 *     its next scheduled run and a manual Sync button, plus the searchable, paginated
 *     stocks_origin catalogue the syncs feed.
 *
 * Layer: Frontend / Pages
 *
 * Usage Examples:
 *     <Route path="sources" element={<SourcesPage />} />
 *
 * Key Functions:
 *     - SourcesPage() - the page
 *     - SourceCard() - one source: status, counts, next run, Sync button (spinner, disabled while running)
 *     - OriginTable() - stocks_origin filters, table and pagination
 *     - formatDateTime() / statusLabel() - Spanish display helpers
 *
 * Key Input Dependencies:
 *     - services/sources.ts (GET /api/sources, POST /api/sources/:code/sync, GET /api/stocks-origin)
 */
import { useCallback, useEffect, useState } from 'react';
import { Database, RefreshCcw, ExternalLink, Search, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import {
    fetchSources,
    fetchStocksOrigin,
    syncSource,
    tradingViewUrl,
    SyncConflictError,
    type SourceSummary,
    type StocksOriginRow,
    type SyncResult,
} from '../services/sources';

const PAGE_SIZE = 50;

function formatDateTime(iso: string | null | undefined): string {
    if (!iso) return '—';
    const ms = Date.parse(iso.includes('T') ? iso : `${iso.replace(' ', 'T')}Z`);
    if (Number.isNaN(ms)) return iso;
    return new Date(ms).toLocaleString('es-CL', { dateStyle: 'short', timeStyle: 'short' });
}

function statusLabel(status: string | undefined): string {
    if (status === 'success') return 'Éxito';
    if (status === 'failed') return 'Falló';
    if (status === 'running') return 'En curso';
    return 'Sin ejecuciones';
}

function statusClass(status: string | undefined): string {
    if (status === 'success') return 'text-emerald-400 bg-emerald-400/10 border-emerald-400/20';
    if (status === 'failed') return 'text-red-400 bg-red-400/10 border-red-400/20';
    return 'text-amber-400 bg-amber-400/10 border-amber-400/20';
}

function SourceCard({ source, onSynced }: { source: SourceSummary; onSynced: () => void }) {
    const [syncing, setSyncing] = useState(false);
    const [result, setResult] = useState<SyncResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    const handleSync = async () => {
        setSyncing(true);
        setResult(null);
        setError(null);
        try {
            const syncResult = await syncSource(source.source_code);
            setResult(syncResult);
            if (syncResult.status === 'failed') setError(syncResult.error ?? 'La sincronización falló');
        } catch (err) {
            setError(err instanceof SyncConflictError ? err.message : (err as Error).message);
        } finally {
            setSyncing(false);
            onSynced();
        }
    };

    const last = source.last_run;
    return (
        <div className="bg-[#1C1C1E] border border-white/5 rounded-2xl p-6" data-testid={`source-card-${source.source_code}`}>
            <div className="flex justify-between items-start gap-4">
                <div>
                    <h3 className="text-lg font-semibold text-white">{source.display_name}</h3>
                    <p className="text-xs font-mono text-gray-500 mt-1">{source.source_code}</p>
                </div>
                <span className={`px-2.5 py-1 text-xs font-medium rounded-md border ${statusClass(last?.status)}`}>
                    {statusLabel(last?.status)}
                </span>
            </div>

            <dl className="mt-5 space-y-2 text-sm text-gray-400">
                <div className="flex justify-between gap-3">
                    <dt>Última ejecución</dt>
                    <dd className="text-gray-200">{formatDateTime(last?.started_at)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                    <dt>Último éxito</dt>
                    <dd className="text-gray-200">{formatDateTime(source.last_success?.finished_at ?? source.last_success?.started_at)}</dd>
                </div>
                <div className="flex justify-between gap-3">
                    <dt className="flex items-center gap-1.5"><Clock className="w-3.5 h-3.5" /> Próxima programada</dt>
                    <dd className="text-gray-200">{source.interval_ms ? formatDateTime(source.next_due_at) : 'Solo manual'}</dd>
                </div>
                {last && (
                    <div className="flex justify-between gap-3">
                        <dt>Registros</dt>
                        <dd className="text-gray-200 font-mono text-xs">
                            {last.fetched} leídos · {last.inserted} nuevos · {last.updated} actualizados · {last.rejected} rechazados
                        </dd>
                    </div>
                )}
            </dl>

            <button
                onClick={handleSync}
                disabled={syncing || source.running}
                className="mt-5 flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed text-white rounded-xl font-medium transition-all"
            >
                <RefreshCcw className={`w-4 h-4 ${syncing ? 'animate-spin' : ''}`} />
                {syncing ? 'Sincronizando…' : 'Sincronizar'}
            </button>

            {result && result.status === 'success' && (
                <p className="mt-3 text-sm text-emerald-400 flex items-center gap-2">
                    <CheckCircle2 className="w-4 h-4" />
                    {result.inserted} nuevos · {result.updated} actualizados · {result.reactivated} reactivados · {result.deactivated} desactivados
                </p>
            )}
            {error && (
                <p className="mt-3 text-sm text-red-400 flex items-center gap-2" role="alert">
                    <AlertTriangle className="w-4 h-4" />
                    {error}
                </p>
            )}
        </div>
    );
}

function OriginTable({ sources }: { sources: SourceSummary[] }) {
    const [rows, setRows] = useState<StocksOriginRow[]>([]);
    const [total, setTotal] = useState(0);
    const [offset, setOffset] = useState(0);
    const [search, setSearch] = useState('');
    const [sourceFilter, setSourceFilter] = useState('');
    const [activeFilter, setActiveFilter] = useState('');
    const [typeFilter, setTypeFilter] = useState('');
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        fetchStocksOrigin({
            source: sourceFilter || undefined,
            active: activeFilter === '' ? undefined : activeFilter === 'true',
            assetType: typeFilter || undefined,
            q: search || undefined,
            limit: PAGE_SIZE,
            offset,
        })
            .then(data => {
                setRows(data.rows);
                setTotal(data.total);
                setError(null);
            })
            .catch(err => setError((err as Error).message));
    }, [sourceFilter, activeFilter, typeFilter, search, offset]);

    useEffect(() => { load(); }, [load]);

    return (
        <section className="mt-10">
            <h2 className="text-xl font-semibold text-white mb-4">Instrumentos sincronizados</h2>

            <div className="flex flex-wrap gap-3 mb-4">
                <div className="relative">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
                    <input
                        type="text"
                        aria-label="Buscar instrumento"
                        placeholder="Buscar ticker o nombre…"
                        value={search}
                        onChange={e => { setOffset(0); setSearch(e.target.value); }}
                        className="bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
                    />
                </div>
                <select aria-label="Fuente" value={sourceFilter} onChange={e => { setOffset(0); setSourceFilter(e.target.value); }}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                    <option value="">Todas las fuentes</option>
                    {sources.map(s => <option key={s.source_code} value={s.source_code}>{s.display_name}</option>)}
                </select>
                <select aria-label="Estado" value={activeFilter} onChange={e => { setOffset(0); setActiveFilter(e.target.value); }}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                    <option value="">Activos e inactivos</option>
                    <option value="true">Solo activos</option>
                    <option value="false">Solo inactivos</option>
                </select>
                <select aria-label="Tipo" value={typeFilter} onChange={e => { setOffset(0); setTypeFilter(e.target.value); }}
                    className="bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white">
                    <option value="">Todos los tipos</option>
                    <option value="EQUITY">EQUITY</option>
                    <option value="ETF">ETF</option>
                    <option value="CRYPTO">CRYPTO</option>
                </select>
            </div>

            {error && <p className="text-sm text-red-400 mb-3" role="alert">{error}</p>}

            <div className="overflow-x-auto bg-[#1C1C1E] border border-white/5 rounded-2xl">
                <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-gray-500 border-b border-white/5">
                        <tr>
                            <th className="text-left px-4 py-3">Ticker</th>
                            <th className="text-left px-4 py-3">Nombre</th>
                            <th className="text-left px-4 py-3">Tipo</th>
                            <th className="text-left px-4 py-3">Sector</th>
                            <th className="text-left px-4 py-3">Industria</th>
                            <th className="text-left px-4 py-3">Activo</th>
                            <th className="text-left px-4 py-3">Visto por última vez</th>
                            <th className="text-left px-4 py-3">Plataforma</th>
                        </tr>
                    </thead>
                    <tbody>
                        {rows.map(row => (
                            <tr key={row.id} className="border-b border-white/5 last:border-0">
                                <td className="px-4 py-2 font-mono">
                                    <a href={tradingViewUrl(row.ticker)} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline">
                                        {row.ticker}
                                    </a>
                                </td>
                                <td className="px-4 py-2 text-gray-300">{row.company_name ?? '—'}</td>
                                <td className="px-4 py-2 text-gray-400">{row.asset_type ?? '—'}</td>
                                <td className="px-4 py-2 text-gray-400">{row.sector ?? '—'}</td>
                                <td className="px-4 py-2 text-gray-400">{row.industry ?? '—'}</td>
                                <td className="px-4 py-2">{row.is_active ? 'Sí' : 'No'}</td>
                                <td className="px-4 py-2 text-gray-400">{formatDateTime(row.last_seen_at)}</td>
                                <td className="px-4 py-2">
                                    {row.platform_url
                                        ? <a href={row.platform_url} target="_blank" rel="noreferrer" className="text-indigo-400 hover:underline inline-flex items-center gap-1">Abrir <ExternalLink className="w-3 h-3" /></a>
                                        : '—'}
                                </td>
                            </tr>
                        ))}
                        {rows.length === 0 && (
                            <tr><td colSpan={8} className="px-4 py-6 text-center text-gray-500">Sin instrumentos para estos filtros.</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            <div className="flex items-center justify-between mt-3 text-sm text-gray-400">
                <span>{total} instrumentos · mostrando {rows.length ? offset + 1 : 0}–{offset + rows.length}</span>
                <span className="flex gap-2">
                    <button onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))} disabled={offset === 0}
                        className="px-3 py-1 rounded-lg border border-slate-700 disabled:opacity-40">Anterior</button>
                    <button onClick={() => setOffset(offset + PAGE_SIZE)} disabled={offset + PAGE_SIZE >= total}
                        className="px-3 py-1 rounded-lg border border-slate-700 disabled:opacity-40">Siguiente</button>
                </span>
            </div>
        </section>
    );
}

export default function SourcesPage() {
    const [sources, setSources] = useState<SourceSummary[]>([]);
    const [schedulerEnabled, setSchedulerEnabled] = useState(true);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(() => {
        fetchSources()
            .then(data => {
                setSources(data.sources);
                setSchedulerEnabled(data.scheduler?.enabled ?? true);
                setError(null);
            })
            .catch(err => setError((err as Error).message))
            .finally(() => setLoading(false));
    }, []);

    useEffect(() => { load(); }, [load]);

    return (
        <div className="p-8 max-w-7xl mx-auto">
            <div className="mb-8">
                <h1 className="text-3xl font-bold text-white tracking-tight flex items-center gap-3">
                    <Database className="w-8 h-8 text-indigo-400" />
                    Fuentes
                </h1>
                <p className="text-gray-400 mt-2">
                    Orígenes de instrumentos y su sincronización. {schedulerEnabled ? 'La sincronización automática está activa.' : 'La sincronización automática está desactivada.'}
                </p>
            </div>

            {error && <p className="text-sm text-red-400 mb-4" role="alert">{error}</p>}

            {loading ? (
                <div className="flex justify-center items-center h-40">
                    <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-indigo-500" />
                </div>
            ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                    {sources.map(source => <SourceCard key={source.source_code} source={source} onSynced={load} />)}
                </div>
            )}

            <OriginTable sources={sources} />
        </div>
    );
}
