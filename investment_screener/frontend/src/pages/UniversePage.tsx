/**
 * UniversePage.tsx (React Component)
 * =====================================
 *
 * Purpose:
 *     Curated candidate universe manager. Provides a CSV file input for
 *     uploading the curated watchlist (`ticker,name,source`), showing the
 *     parse/insert summary, and a maintainer table listing existing candidates
 *     with per-row delete.
 *
 * Layer: Frontend / Pages / Universe
 *
 * Key Functions:
 *     - UniversePage() - Renders file input + upload summary + candidate table
 */
import { useState, useCallback, useEffect } from 'react';
import {
    fetchUniverse,
    uploadUniverseCsv,
    deleteUniverseTicker,
} from '../services/api';
import type { UniverseCandidate, UniverseUploadSummary } from '../services/api';

export default function UniversePage() {
    const [candidates, setCandidates] = useState<UniverseCandidate[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [uploading, setUploading] = useState(false);
    const [summary, setSummary] = useState<UniverseUploadSummary | null>(null);
    const [fileName, setFileName] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        try {
            setError(null);
            setCandidates(await fetchUniverse());
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Failed to load universe');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        refresh();
    }, [refresh]);

    const handleFile = async (file: File) => {
        setFileName(file.name);
        setUploading(true);
        setError(null);
        setSummary(null);
        try {
            const text = await file.text();
            const result = await uploadUniverseCsv(text);
            setSummary(result);
            await refresh();
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Upload failed');
        } finally {
            setUploading(false);
        }
    };

    const handleDelete = async (ticker: string) => {
        try {
            setError(null);
            await deleteUniverseTicker(ticker);
            setCandidates((prev) => prev.filter((c) => c.ticker !== ticker));
        } catch (err) {
            setError(err instanceof Error ? err.message : 'Delete failed');
        }
    };

    return (
        <div className="p-6">
            <h1 className="text-2xl font-bold mb-1">Candidate Universe</h1>
            <p className="text-sm text-slate-400 mb-6">
                Curated watchlist of investment candidates. Expected CSV columns:{' '}
                <code className="text-emerald-400">ticker,name,source</code> (source may be
                <code className="text-emerald-400"> source</code> or{' '}
                <code className="text-emerald-400">asset_class,source</code>).
            </p>

            <div className="mb-6 rounded-lg border border-slate-700 bg-slate-800/50 p-4">
                <label className="block mb-1 text-sm font-semibold text-slate-300">
                    Upload universe CSV
                </label>
                <input
                    type="file"
                    accept=".csv,text/csv"
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) handleFile(f);
                        e.target.value = '';
                    }}
                    className="block w-full text-sm text-slate-400 file:mr-4 file:rounded file:border-0 file:bg-slate-700 file:px-4 file:py-2 file:font-semibold file:text-slate-200 hover:file:bg-slate-600"
                />
                {uploading && <p className="mt-2 text-sm text-amber-400">Uploading…</p>}
                {fileName && !uploading && (
                    <p className="mt-2 text-sm text-slate-500">Selected: {fileName}</p>
                )}
                {summary && (
                    <div className="mt-3 rounded bg-slate-900/60 p-3 text-sm">
                        <span className="text-emerald-400">{summary.inserted} inserted</span>
                        {' · '}
                        <span className="text-amber-400">{summary.skipped} skipped</span>
                        {(summary.rejected?.length ?? 0) > 0 && (
                            <span className="text-red-400"> · {summary.rejected!.length} rejected</span>
                        )}
                    </div>
                )}
                {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-700">
                <table className="w-full min-w-[640px] text-sm">
                    <thead className="bg-slate-800 text-left text-slate-400">
                        <tr>
                            <th className="px-4 py-2">Ticker</th>
                            <th className="px-4 py-2">Name</th>
                            <th className="px-4 py-2">Source</th>
                            <th className="px-4 py-2">Asset Class</th>
                            <th className="px-4 py-2">Added</th>
                            <th className="px-4 py-2 text-right">Actions</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700">
                        {loading ? (
                            <tr>
                                <td colSpan={6} className="px-4 py-4 text-slate-400">Loading…</td>
                            </tr>
                        ) : candidates.length === 0 ? (
                            <tr>
                                <td colSpan={6} className="px-4 py-4 text-slate-500">
                                    No candidates yet — upload a CSV above.
                                </td>
                            </tr>
                        ) : (
                            candidates.map((c) => (
                                <tr key={c.ticker} className="hover:bg-slate-800/40">
                                    <td className="px-4 py-2 font-mono text-slate-200">{c.ticker}</td>
                                    <td className="px-4 py-2 text-slate-300">{c.name}</td>
                                    <td className="px-4 py-2 text-slate-400">{c.source}</td>
                                    <td className="px-4 py-2 text-slate-400">{c.asset_class ?? '—'}</td>
                                    <td className="px-4 py-2 text-slate-500">{c.added_at}</td>
                                    <td className="px-4 py-2 text-right">
                                        <button
                                            onClick={() => handleDelete(c.ticker)}
                                            className="rounded bg-red-900/60 px-2 py-1 text-xs font-semibold text-red-300 hover:bg-red-800/60"
                                        >
                                            Delete
                                        </button>
                                    </td>
                                </tr>
                            ))
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
