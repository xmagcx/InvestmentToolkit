/**
 * bridge.ts - Express to Python analytical script bridge.
 * 
 * Purpose:
 *   Execution bridge for spawning and managing Python processes from the Node.js backend.
 *   Handles script location resolution, timeout management, and JSON output parsing.
 * 
 * Layer:
 *   Backend / Services / Bridge
 * 
 * Usage Examples:
 *   const data = await spawnPythonScript('fetch_financials.py', ['AAPL']);
 * 
 * Key Functions (Index):
 *   - _cacheKey(scriptName, args) - Generates a cache key for deduplication
 *   - spawnPythonScript(scriptName, args) - Deduplicated entry point for running a Python analytical script
 *   - _spawnRaw(scriptName, args) - Spawns a child process for a given Python script, returning parsed JSON
 *   - runPythonScriptFresh(scriptRelPath, args, timeoutMs) - One un-deduplicated, un-cached run
 *     that resolves {exitCode, json} even on a non-zero exit when stdout is JSON (for commands
 *     whose failure is data, e.g. investment_sources/sync_cli.py)
 * 
 * Key Input Dependencies:
 *   - investment_screener/backend/py_services/ (location of executable Python scripts)
 * 
 * Key Output Dependencies:
 *   None
 */
import { spawn } from 'child_process';
import path from 'path';

const PYTHON_TIMEOUT_MS = 90_000;
// __dirname is backend/src/services/ in dev, backend/dist/services/ in built.
const PY_SERVICES_DIR = path.resolve(__dirname, '../../py_services');

// ── Circuit breaker: in-flight deduplication + stale cache ───────────────────
// If a caller requests the same script+args while a prior call is still running,
// the second caller waits on the same Promise instead of spawning a second process.
// On timeout the last successful result is returned (with a `stale: true` flag)
// so the frontend never hangs indefinitely.
const _inflight = new Map<string, Promise<any>>();
const _lastResult = new Map<string, { ts: number; value: any }>();

function _cacheKey(scriptName: string, args: string[]): string {
    return `${scriptName}|${args.join('|')}`;
}

export const spawnPythonScript = async (scriptName: string, args: string[]): Promise<any> => {
    const key = _cacheKey(scriptName, args);

    const existing = _inflight.get(key);
    if (existing) {
        console.log(`[Bridge] Deduplicating in-flight call: ${scriptName}`);
        return existing;
    }

    const promise = _spawnRaw(scriptName, args)
        .then(result => {
            _lastResult.set(key, { ts: Date.now(), value: result });
            return result;
        })
        .catch((err: Error) => {
            const cached = _lastResult.get(key);
            if (cached) {
                console.warn(`[Bridge] ${scriptName} failed (${err.message}) — returning cached result from ${Math.round((Date.now() - cached.ts) / 1000)}s ago`);
                return { ...cached.value, stale: true, staleReason: err.message };
            }
            throw err;
        })
        .finally(() => _inflight.delete(key));

    _inflight.set(key, promise);
    return promise;
};

export interface FreshPythonRun {
    exitCode: number;
    json: any;
    stdout: string;
    stderr: string;
}

/**
 * Run a Python script once, with no in-flight deduplication and no stale-result cache.
 *
 * `spawnPythonScript` is built for repeatable reads: it reuses an in-flight promise and, on
 * failure, serves the last successful payload. Both behaviours are wrong for a command that
 * writes (a source sync): two callers must not share one run, and a failure must never look
 * like an old success. A non-zero exit that still printed JSON resolves normally — a failed
 * sync is a SyncResult, not an exception. `scriptRelPath` is resolved inside py_services
 * unless it is already absolute.
 */
export const runPythonScriptFresh = (
    scriptRelPath: string,
    args: string[],
    timeoutMs: number
): Promise<FreshPythonRun> => {
    const scriptPath = path.isAbsolute(scriptRelPath) ? scriptRelPath : path.join(PY_SERVICES_DIR, scriptRelPath);
    const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';

    return new Promise<FreshPythonRun>((resolve, reject) => {
        console.log(`[Bridge] Spawning (fresh): ${pythonCommand} ${scriptPath} ${args.join(' ')}`);
        const child = spawn(pythonCommand, [scriptPath, ...args]);

        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGTERM');
            reject(new Error(`Python script '${scriptRelPath}' timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);

        child.stdout.on('data', chunk => { stdout += chunk.toString(); });
        child.stderr.on('data', chunk => { stderr += chunk.toString(); });

        child.on('close', code => {
            clearTimeout(timer);
            if (timedOut) return;
            const exitCode = code ?? -1;
            let json: any = null;
            if (stdout.trim()) {
                try {
                    json = JSON.parse(stdout.trim());
                } catch {
                    json = null;
                }
            }
            if (json === null && exitCode !== 0) {
                reject(new Error(`Python script '${scriptRelPath}' exited with code ${exitCode}: ${stderr.trim() || '(no stderr)'}`));
                return;
            }
            if (json === null && stdout.trim()) {
                reject(new Error(`Failed to parse Python output as JSON: ${stdout.slice(0, 500)}`));
                return;
            }
            resolve({ exitCode, json, stdout, stderr });
        });

        child.on('error', err => {
            clearTimeout(timer);
            reject(new Error(`Failed to spawn Python process: ${err.message}`));
        });
    });
};

const _spawnRaw = async (scriptName: string, args: string[]): Promise<any> => {
    return new Promise((resolve, reject) => {
        const scriptPath = path.join(PY_SERVICES_DIR, scriptName);

        const pythonCommand = process.platform === 'win32' ? 'python' : 'python3';
        console.log(`[Bridge] Spawning: ${pythonCommand} ${scriptPath} ${args.join(' ')}`);

        const pythonProcess = spawn(pythonCommand, [scriptPath, ...args]);

        let dataString = '';
        let errorString = '';
        let killed = false;

        const timeout = setTimeout(() => {
            killed = true;
            pythonProcess.kill('SIGTERM');
            reject(new Error(`Python script '${scriptName}' timed out after ${PYTHON_TIMEOUT_MS / 1000}s`));
        }, PYTHON_TIMEOUT_MS);

        pythonProcess.stdout.on('data', (data) => {
            dataString += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            errorString += data.toString();
        });

        pythonProcess.on('close', (code) => {
            clearTimeout(timeout);
            if (killed) return;

            if (code !== 0) {
                console.error(`[Bridge] Error (Code ${code}): ${errorString}`);
                reject(new Error(`Python script exited with code ${code}: ${errorString}`));
                return;
            }

            try {
                if (!dataString) {
                    resolve(null);
                    return;
                }
                const json = JSON.parse(dataString);
                resolve(json);
            } catch (e) {
                console.error(`[Bridge] Failed to parse JSON: ${dataString}`);
                reject(new Error(`Failed to parse Python output as JSON: ${e}`));
            }
        });

        pythonProcess.on('error', (err) => {
            clearTimeout(timeout);
            reject(new Error(`Failed to spawn Python process: ${err.message}`));
        });
    });
};