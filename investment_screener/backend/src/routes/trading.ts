/**
 * trading.ts - Express routing for broker order execution and trade logs.
 * 
 * Purpose:
 *   Handles Express API routes for live order execution, checking open orders,
 *   cancelling working orders, and accessing trade execution logs.
 * 
 * Layer:
 *   Backend / Routes / Trading
 * 
 * Key Functions (Index):
 *   - makeSession(params) - Spawns a new TradeSession tracker in local state map
 *   - patchSession(id, updates) - Modifies an existing TradeSession's status
 *   - runPy(args, timeoutMs) - Spawns place_order.py and handles runtime timeouts
 *   - extractJson(stdout) - Resolves and extracts clean JSON block from process stdout
 *   - readLog() - Reads entries from the trade_log_entry SQLite table (Wave 4 cutover)
 *   - writeLog(entries) - Upserts entries into the trade_log_entry SQLite table (Wave 4 cutover)
 *   - makeLogEntry(fields) - Scaffolds a standardized manual/automatic trade log record
 *
 * Broker kill switch (spec S6):
 *   Every route here reaches a broker (order placement, working orders, TV order history),
 *   so the whole router is behind `requireBrokerIntegration`: with BROKER_INTEGRATION unset
 *   or anything but 'on', each route answers 410 BROKER_DISABLED and no broker is contacted.
 *   Exceptions: GET /log and GET /audit/today read stored data only and stay available.
 *   The code below is disabled, not deleted.
 *
 * Routes Index:
 *   - POST /preflight - Executes preflight checks (size caps, stale data flags) for a trade
 *   - POST /execute - Form-fills order details in TradingView's panel via CDP
 *   - POST /submit - Submits the filled order and captures the TV order ID
 *   - GET /session/:id - Queries local state for an active TradeSession
 *   - GET /log - Reads and returns manual/automatic trade logs
 *   - POST /log - Appends a manual trade log record
 *   - POST /log/suggest - Bulk suggests rebalancing trades
 *   - PATCH /log/:id - Modifies a trade log record (notes, filled price)
 *   - POST /modify - Modifies limit price/shares of a working TV order via CDP
 *   - POST /cancel - Cancels a working TV order via CDP
 *   - POST /log/sync-from-tv - Synchronizes trade logs with working TV orders
 *   - GET /audit/today - Reads daily TV order action event streams
 *   - GET /tv-quote - Fetches quote from TradingView chart
 *
 * Key Input Dependencies:
 *   - investment_screener/backend/data/domain_model.sqlite's trade_log_entry table
 *   - plugins/tradingview/audit/ (reads logs)
 *
 * Key Output Dependencies:
 *   - investment_screener/backend/data/domain_model.sqlite's trade_log_entry table
 */

import express from 'express';
import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DOMAIN_MODEL_DB_FILE } from '../utils/paths';
import { TradeLogRepository, TradeLogEntryRow } from '../services/TradeLogRepository';
import { InvestmentRepository } from '../services/InvestmentRepository';
import { PortfolioRepository } from '../services/PortfolioRepository';
import { requireBrokerIntegration } from '../utils/brokerIntegration';

const router = express.Router();

// Screener-only by default: nothing in this router runs without BROKER_INTEGRATION=on, except
// the two reads of stored data (the trade log in SQLite and today's local audit file), which
// never touch a broker and back the Trade Log page.
const STORED_DATA_READS = new Set(['/log', '/audit/today']);
router.use((req, res, next) =>
  req.method === 'GET' && STORED_DATA_READS.has(req.path) ? next() : requireBrokerIntegration(req, res, next));

const REPO_ROOT = path.resolve(__dirname, '../../../..');
const PLACE_ORDER_PY = path.join(REPO_ROOT, 'investment_screener/backend/py_services/place_order.py');
const GET_ORDERS_PY  = path.join(REPO_ROOT, 'plugins/tradingview/.apm/skills/trading-via-tradingview/scripts/tv_get_orders.py');
const TV_QUOTE_PY    = path.join(REPO_ROOT, 'plugins/tradingview/.apm/skills/operating-tradingview-charts/scripts/tv_quote.py');
const TV_TRADES_IMPORT_PY = path.join(REPO_ROOT, 'plugins/tradingview/.apm/skills/trading-via-tradingview/scripts/tv_trades_import.py');
const BROKER_SOURCES_PY   = path.join(REPO_ROOT, 'investment_screener/backend/py_services/broker_sources.py');

// ── Session State Machine ────────────────────────────────────────────────────

type TradeState =
  | 'DRAFT'
  | 'PREFLIGHT_PASSED'
  | 'PREFLIGHT_BLOCKED'
  | 'DATA_STALE_BLOCKED'
  | 'SIZE_CAP_BLOCKED'
  | 'FORM_FILLED'
  | 'SUBMITTED'
  | 'USER_CANCELLED';

interface TradeSession {
  id: string;
  ticker: string;
  action: 'buy' | 'sell';
  shares: number;
  orderType: string;
  limitPrice?: number;
  account: string;
  ackStale?: boolean;
  state: TradeState;
  preflightCard?: Record<string, any>;
  screenshot?: string;
  submitResult?: Record<string, any>;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

const sessions = new Map<string, TradeSession>();

function makeSession(params: Omit<TradeSession, 'id' | 'state' | 'createdAt' | 'updatedAt'>): TradeSession {
  const id = crypto.randomBytes(8).toString('hex');
  const now = new Date().toISOString();
  const session: TradeSession = { id, state: 'DRAFT', createdAt: now, updatedAt: now, ...params };
  sessions.set(id, session);
  return session;
}

function patchSession(id: string, updates: Partial<TradeSession>): TradeSession | undefined {
  const s = sessions.get(id);
  if (!s) return undefined;
  const next = { ...s, ...updates, updatedAt: new Date().toISOString() };
  sessions.set(id, next);
  return next;
}

// ── Python subprocess ────────────────────────────────────────────────────────

interface PyResult { stdout: string; stderr: string; exitCode: number; }

function runPy(args: string[], timeoutMs = 60_000): Promise<PyResult> {
  return runScript(PLACE_ORDER_PY, args, timeoutMs);
}

/** Run any repository Python script and collect its output; never rejects. */
function runScript(script: string, args: string[], timeoutMs = 60_000): Promise<PyResult> {
  return new Promise(resolve => {
    const proc = spawn('python3', [script, ...args], { cwd: REPO_ROOT });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      proc.kill('SIGTERM');
      resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: -1 });
    }, timeoutMs);
    proc.on('close', code => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
}

function extractJson(stdout: string): Record<string, any> | null {
  const trimmed = stdout.trim();
  // Try direct parse (execute/submit output is clean JSON)
  try { return JSON.parse(trimmed); }
  catch { /* fall through */ }
  // Find the last JSON object in mixed output (preflight has text card before JSON)
  const idx = stdout.lastIndexOf('\n{');
  if (idx !== -1) {
    try { return JSON.parse(stdout.slice(idx).trim()); }
    catch { /* fall through */ }
  }
  // Brute-force: find any JSON block
  const match = stdout.match(/\{[\s\S]+\}/);
  if (match) {
    try { return JSON.parse(match[0]); }
    catch { /* fall through */ }
  }
  return null;
}

// ── POST /api/trading/preflight ──────────────────────────────────────────────

router.post('/preflight', async (req, res) => {
  const { ticker, action, shares, orderType, limitPrice, account, ackStale } = req.body;
  if (!ticker || !action || !shares || !orderType || !account) {
    res.status(400).json({ error: 'ticker, action, shares, orderType, and account are required' });
    return;
  }

  const session = makeSession({ ticker, action, shares, orderType, limitPrice, account, ackStale });

  const args = [
    '--ticker', ticker, '--action', action,
    '--shares', String(shares), '--order-type', orderType,
    '--account', account, '--preflight',
  ];
  if (limitPrice) args.push('--limit-price', String(limitPrice));
  if (ackStale) args.push('--ack-stale');

  const { stdout, exitCode } = await runPy(args, 30_000);
  const card = extractJson(stdout);

  if (exitCode === 4) {
    patchSession(session.id, { state: 'DATA_STALE_BLOCKED', error: 'DATA_STALE_BLOCKED', preflightCard: card ?? undefined });
    res.status(422).json({ sessionId: session.id, state: 'DATA_STALE_BLOCKED', error: 'Portfolio data is stale — run /tv-portfolio-sync first', card });
    return;
  }
  if (exitCode === 3) {
    patchSession(session.id, { state: 'SIZE_CAP_BLOCKED', preflightCard: card ?? undefined });
    res.status(422).json({ sessionId: session.id, state: 'SIZE_CAP_BLOCKED', error: 'Order exceeds safety size cap', card });
    return;
  }
  if (exitCode !== 0) {
    const errMsg = card?.error ?? 'Preflight failed — is TradingView open with Broker connected?';
    patchSession(session.id, { state: 'PREFLIGHT_BLOCKED', error: errMsg });
    res.status(422).json({ sessionId: session.id, state: 'PREFLIGHT_BLOCKED', error: errMsg });
    return;
  }

  patchSession(session.id, { state: 'PREFLIGHT_PASSED', preflightCard: card ?? undefined });
  res.json({ sessionId: session.id, state: 'PREFLIGHT_PASSED', card });
});

// ── POST /api/trading/execute ────────────────────────────────────────────────

router.post('/execute', async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (session.state !== 'PREFLIGHT_PASSED') {
    res.status(409).json({ error: `Cannot execute from state ${session.state}` }); return;
  }

  const args = [
    '--ticker', session.ticker, '--action', session.action,
    '--shares', String(session.shares), '--order-type', session.orderType,
    '--account', session.account, '--execute',
  ];
  if (session.limitPrice) args.push('--limit-price', String(session.limitPrice));
  if (session.ackStale) args.push('--ack-stale');

  const { stdout, exitCode } = await runPy(args, 60_000);
  const result = extractJson(stdout);

  if (exitCode !== 0) {
    res.status(422).json({ error: result?.error ?? 'Execute failed' }); return;
  }

  patchSession(sessionId, { state: 'FORM_FILLED', screenshot: result?.screenshot ?? undefined });
  res.json({ sessionId, state: 'FORM_FILLED', screenshot: result?.screenshot ?? null });
});

// ── POST /api/trading/submit ─────────────────────────────────────────────────

router.post('/submit', async (req, res) => {
  const { sessionId } = req.body;
  const session = sessions.get(sessionId);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  if (session.state !== 'FORM_FILLED') {
    res.status(409).json({ error: `Cannot submit from state ${session.state}` }); return;
  }

  const args = [
    '--ticker', session.ticker, '--action', session.action,
    '--shares', String(session.shares), '--order-type', session.orderType,
    '--account', session.account, '--submit',
  ];
  if (session.limitPrice) args.push('--limit-price', String(session.limitPrice));

  const { stdout, exitCode } = await runPy(args, 60_000);
  const result = extractJson(stdout);

  if (exitCode !== 0) {
    res.status(422).json({ error: result?.error ?? 'Submit failed' }); return;
  }

  const tvOrderId: string | null = result?.tvOrderId ?? result?.result?.brokerVerification?.best?.orderId ?? null;
  patchSession(sessionId, { state: 'SUBMITTED', submitResult: result ?? undefined });
  res.json({ sessionId, state: 'SUBMITTED', result, tvOrderId });
});

// ── GET /api/trading/session/:id ─────────────────────────────────────────────

router.get('/session/:id', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) { res.status(404).json({ error: 'Session not found' }); return; }
  res.json(session);
});

// ── GET /api/trading/audit/today ─────────────────────────────────────────────

// ── Manual Trade Log (Wave 4 cutover: trade_log_entry SQLite table) ─────────
//
// readLog()/writeLog() keep the exact same external shape every route handler
// already relies on (a plain array of {id, ticker, action, shares, price,
// totalCost, account, orderType, limitPrice, date, notes, status, source,
// priority, loggedAt, tvOrderId} objects); storage is the trade_log_entry table via
// TradeLogRepository.

/** DB row -> the original JSON entry shape every route handler expects. */
function rowToEntry(row: TradeLogEntryRow): Record<string, any> {
  return {
    id: row.entry_id,
    ticker: row.investment_id,
    action: row.action,
    shares: row.shares,
    price: row.price,
    totalCost: row.total_cost,
    account: row.account_id,
    orderType: row.order_type,
    limitPrice: row.limit_price,
    date: row.trade_date,
    notes: row.notes,
    status: row.status,
    source: row.source,
    priority: row.priority,
    tvOrderId: row.tv_order_id,
    loggedAt: row.logged_at,
  };
}

export function readLog(dbPath: string = DOMAIN_MODEL_DB_FILE): any[] {
  const repo = new TradeLogRepository(dbPath);
  try {
    const rows = repo.listTradeLogEntries();
    // writeLog() historically unshift()ed new entries to the front (newest
    // first) and every consumer (GET /log -> TradeLog.tsx etc.) relies on
    // that ordering — listTradeLogEntries() orders by entry_id, so re-sort
    // by loggedAt descending here to preserve the original external order.
    return rows
      .map(rowToEntry)
      .sort((a, b) => String(b.loggedAt ?? '').localeCompare(String(a.loggedAt ?? '')));
  } catch {
    return [];
  } finally {
    repo.close();
  }
}

/** Upserts every entry in `entries` into trade_log_entry, resolving each
 * entry's ticker -> investment_id and ensuring its account row exists first
 * (mirrors migrate_wave4_to_sqlite.py's real-producer pattern). Every real
 * caller passes the full current in-memory array after a local mutation
 * (unshift a new entry, or patch one entry's fields) — no caller ever removes
 * an entry from the array (cancellation is a status flip, not a delete), so
 * upserting the whole array is equivalent to the old full-file overwrite. */
export function writeLog(entries: any[], dbPath: string = DOMAIN_MODEL_DB_FILE): void {
  // Open order no longer matters: no repository creates tables any more. The schema is
  // built once, whole, by the Python migrator (see utils/schemaVersion.ts). Previously each
  // repository carried its own copy of `investment`, and opening a narrower one first on a
  // fresh DB would have locked in a table missing lifecycle_status etc.
  const investmentRepo = new InvestmentRepository(dbPath);
  const portfolioRepo = new PortfolioRepository(dbPath);
  const tradeLogRepo = new TradeLogRepository(dbPath);
  try {
    for (const entry of entries) {
      if (!entry?.ticker) continue;
      const investmentId = investmentRepo.resolveInvestmentId(String(entry.ticker));
      const accountId = entry.account != null ? String(entry.account) : null;
      if (accountId) {
        portfolioRepo.upsertAccount(accountId, accountId, accountId);
      }
      tradeLogRepo.upsertTradeLogEntry({
        entry_id: String(entry.id),
        investment_id: investmentId,
        account_id: accountId,
        action: entry.action ?? null,
        shares: entry.shares ?? null,
        price: entry.price ?? null,
        total_cost: entry.totalCost ?? null,
        order_type: entry.orderType ?? null,
        limit_price: entry.limitPrice ?? null,
        trade_date: entry.date ?? null,
        notes: entry.notes ?? null,
        status: entry.status ?? null,
        source: entry.source ?? null,
        priority: entry.priority ?? null,
        logged_at: entry.loggedAt ?? null,
        tv_order_id: entry.tvOrderId ?? null,
      });
    }
  } finally {
    tradeLogRepo.close();
    investmentRepo.close();
    portfolioRepo.close();
  }
}

function makeLogEntry(fields: Record<string, any>): Record<string, any> {
  const { ticker, action, shares, price, account, orderType, limitPrice, date, notes, status, source, tvOrderId } = fields;
  return {
    id: crypto.randomBytes(6).toString('hex'),
    ticker: String(ticker).toUpperCase(),
    action: String(action).toLowerCase(),
    shares: Number(shares),
    price: Number(price ?? 0),
    totalCost: Number(shares) * Number(price ?? 0),
    account: String(account).toUpperCase(),
    orderType: String(orderType ?? 'market').toLowerCase(),
    limitPrice: limitPrice != null ? Number(limitPrice) : null,
    date: date && date !== 'undefined' ? String(date) : new Date().toLocaleDateString('en-CA'),
    notes: String(notes ?? ''),
    status: String(status ?? 'logged'),
    source: String(source ?? 'manual'),
    tvOrderId: tvOrderId != null ? String(tvOrderId) : null,
    loggedAt: new Date().toISOString(),
  };
}

router.get('/log', (_req, res) => {
  res.json({ entries: readLog() });
});

router.post('/log', (req, res) => {
  const { ticker, action, shares, account, date } = req.body;
  if (!ticker || !action || !shares || !account || !date) {
    res.status(400).json({ error: 'ticker, action, shares, account, date are required' }); return;
  }
  try {
    const entry = makeLogEntry(req.body);
    const entries = readLog();
    entries.unshift(entry);
    writeLog(entries);
    res.json({ success: true, entry });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// Bulk suggest — used by portfolio review / rebalance skills
router.post('/log/suggest', (req, res) => {
  const { suggestions } = req.body;
  if (!Array.isArray(suggestions) || suggestions.length === 0) {
    res.status(400).json({ error: 'suggestions array required' }); return;
  }
  try {
    const entries = readLog();
    const created: any[] = [];
    for (const s of suggestions) {
      if (!s.ticker || !s.action || !s.shares || !s.account) continue;
      const entry = makeLogEntry({ ...s, status: 'suggested', source: s.source ?? 'rebalance' });
      entries.unshift(entry);
      created.push(entry);
    }
    writeLog(entries);
    res.json({ success: true, created });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

router.patch('/log/:id', (req, res) => {
  const { id } = req.params;
  const allowed = ['status', 'notes', 'price', 'shares', 'orderType', 'limitPrice', 'account', 'date', 'tvOrderId'];
  try {
    const entries = readLog();
    const idx = entries.findIndex((e: any) => e.id === id);
    if (idx === -1) { res.status(404).json({ error: 'Entry not found' }); return; }
    const updates: Record<string, any> = {};
    for (const k of allowed) { if (req.body[k] !== undefined) updates[k] = req.body[k]; }
    if (updates.price !== undefined || updates.shares !== undefined) {
      const price = updates.price ?? entries[idx].price;
      const shares = updates.shares ?? entries[idx].shares;
      updates.totalCost = Number(price) * Number(shares);
    }
    entries[idx] = { ...entries[idx], ...updates };
    writeLog(entries);
    res.json({ success: true, entry: entries[idx] });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// ── POST /api/trading/modify ─────────────────────────────────────────────────

router.post('/modify', async (req, res) => {
  const { entryId, tvOrderId, ticker, action, newPrice, newShares } = req.body;

  if (!tvOrderId) {
    res.status(400).json({ error: 'tvOrderId is required' }); return;
  }
  if (newPrice == null) {
    res.status(400).json({ error: 'newPrice is required' }); return;
  }

  const args = ['--modify', '--order-id', String(tvOrderId), '--new-price', String(newPrice)];
  if (newShares != null) args.push('--new-shares', String(newShares));
  if (ticker)  args.push('--ticker', ticker);
  if (action)  args.push('--action', action);

  const { stdout, exitCode } = await runPy(args, 30_000);
  const tvResult = extractJson(stdout);
  const tvModified = exitCode === 0 && (tvResult?.modified === true);

  // Patch trade-log entry with new limit price on success
  let logUpdated = false;
  if (tvModified && entryId) {
    try {
      const entries = readLog();
      const idx = entries.findIndex((e: any) => e.id === entryId);
      if (idx !== -1) {
        entries[idx] = { ...entries[idx], limitPrice: newPrice,
                         ...(newShares != null ? { shares: newShares } : {}) };
        writeLog(entries);
        logUpdated = true;
      }
    } catch { /* non-fatal */ }
  }

  res.json({ tvModified, logUpdated, tvResult });
});

// ── POST /api/trading/cancel ─────────────────────────────────────────────────

router.post('/cancel', async (req, res) => {
  const { entryId, tvOrderId, ticker, action, limitPrice } = req.body;

  let tvResult: Record<string, any> | null = null;
  let tvCancelled = false;

  if (tvOrderId) {
    const args = ['--cancel', '--order-id', String(tvOrderId)];
    if (ticker) args.push('--ticker', ticker);
    if (action) args.push('--action', action);
    if (limitPrice != null) args.push('--limit-price', String(limitPrice));
    const { stdout, exitCode } = await runPy(args, 20_000);
    tvResult = extractJson(stdout);
    tvCancelled = exitCode === 0 && (tvResult?.cancelled === true);
  }

  // Update trade-log entry status regardless of TV result
  let logCancelled = false;
  if (entryId) {
    try {
      const entries = readLog();
      const idx = entries.findIndex((e: any) => e.id === entryId);
      if (idx !== -1) {
        entries[idx] = { ...entries[idx], status: 'cancelled' };
        writeLog(entries);
        logCancelled = true;
      }
    } catch { /* non-fatal */ }
  }

  res.json({ tvCancelled, logCancelled, tvResult });
});

// ── POST /api/trading/log/sync-from-tv ──────────────────────────────────────
// Reconcile trade-log against live TV orders. Entries with status inactive/submitted
// whose tvOrderId is no longer in TV are marked cancelled.

/** Import executed trades from TradingView's order history (tv_trades_import.py). Never throws:
 * the open-order reconciliation above must still succeed when the import cannot run. */
async function importExecutedTradesFromTv(): Promise<{ ok: boolean; imported: number; enriched: number; warnings: string[]; error?: string }> {
  // Reads every account in turn, so it needs longer than an open-order read.
  const result = await runScript(TV_TRADES_IMPORT_PY, ['--json'], 120_000);
  const report = extractJson(result.stdout);
  if (!report || report.error) {
    return { ok: false, imported: 0, enriched: 0, warnings: [], error: report?.error ?? (result.stderr.slice(0, 200) || 'no output') };
  }
  const rejected = (report.rejected ?? []).map((item: any) => String(item.reason));
  return { ok: true, imported: report.imported ?? 0, enriched: report.enriched ?? 0, warnings: [...(report.warnings ?? []), ...rejected] };
}

// ── GET /api/trading/broker-sources ─────────────────────────────────────────
// Which broker connections may refresh trades: TradingView always; Questrade only when
// QUESTRADE_ENABLED is set in .env. One reader (broker_sources.py) for skills and the web app.

router.get('/broker-sources', async (_req, res) => {
  const result = await runScript(BROKER_SOURCES_PY, ['--json'], 10_000);
  const sources = extractJson(result.stdout);
  // Unknown means TradingView only: never offer Questrade on a failed read.
  res.json(sources ?? { default: 'tradingview', available: ['tradingview'], questrade: false });
});

router.post('/log/sync-from-tv', async (req, res) => {
  try {
    const pyResult = await new Promise<PyResult>(resolve => {
      const proc = spawn('python3', [GET_ORDERS_PY, '--json'], { cwd: REPO_ROOT });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: -1 });
      }, 20_000);
      proc.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }); });
    });

    const tvData = extractJson(pyResult.stdout);
    if (!tvData) {
      res.status(502).json({ error: 'Could not read orders from TradingView', stderr: pyResult.stderr.slice(0, 300) });
      return;
    }

    // If TV returned an error or explicitly said found=false, it means CDP failed —
    // don't reconcile (we'd wrongly cancel all open orders with an empty set).
    if (tvData.error || tvData.found === false) {
      res.status(502).json({ error: `TradingView CDP error: ${tvData.error ?? 'not found'}`, details: tvData });
      return;
    }

    const tvOrderIds = new Set<string>(
      (tvData.orders ?? []).map((o: any) => String(o.orderId))
    );

    const entries = readLog();
    let cancelled = 0;
    const updated = entries.map((e: any) => {
      if (e.tvOrderId && (e.status === 'inactive' || e.status === 'submitted')) {
        if (!tvOrderIds.has(String(e.tvOrderId))) {
          cancelled++;
          return { ...e, status: 'cancelled', notes: (e.notes ? e.notes + ' ' : '') + '[sync: not in TV]' };
        }
      }
      return e;
    });

    writeLog(updated);
    let message = `Reconciled against ${tvData.orders?.length ?? 0} live TV order(s) — ${cancelled} entr${cancelled === 1 ? 'y' : 'ies'} marked cancelled`;

    // Executed trades are imported only when asked (the Sync button): it switches through every
    // account in TradingView, which is too intrusive for the silent reconcile on page load.
    let trades: Awaited<ReturnType<typeof importExecutedTradesFromTv>> | null = null;
    if (req.body?.importTrades === true) {
      trades = await importExecutedTradesFromTv();
      message += trades.ok
        ? `. Executed trades: ${trades.imported} new, ${trades.enriched} updated`
          + (trades.warnings.length ? ` (${trades.warnings.length} note${trades.warnings.length === 1 ? '' : 's'}: ${trades.warnings[0]})` : '')
        : `. Executed trades could not be imported: ${trades.error}`;
    }
    res.json({ success: true, tvOrders: tvData.orders?.length ?? 0, cancelled, trades, message });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/trading/audit/today ─────────────────────────────────────────────

router.get('/audit/today', (_req, res) => {
  const auditDir = path.join(REPO_ROOT, 'plugins/tradingview/audit');
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const file = path.join(auditDir, `orders-${today}.jsonl`);
  if (!fs.existsSync(file)) {
    res.json({ events: [], date: today }); return;
  }
  try {
    const events = fs.readFileSync(file, 'utf-8')
      .trim().split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
    res.json({ events, date: today });
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/trading/tv-quote ────────────────────────────────────────────────

router.get('/tv-quote', async (req, res) => {
  const ticker = String(req.query.ticker ?? '').trim().toUpperCase();
  if (!ticker) {
    res.status(400).json({ error: 'ticker is required' }); return;
  }

  try {
    const pyResult = await new Promise<PyResult>(resolve => {
      const proc = spawn('python3', [TV_QUOTE_PY, ticker, '--json'], { cwd: REPO_ROOT });
      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
      const timer = setTimeout(() => {
        proc.kill('SIGTERM');
        resolve({ stdout, stderr: stderr + '\n[TIMEOUT]', exitCode: -1 });
      }, 15_000);
      proc.on('close', code => { clearTimeout(timer); resolve({ stdout, stderr, exitCode: code ?? -1 }); });
    });

    const quoteData = extractJson(pyResult.stdout);
    if (!quoteData || pyResult.exitCode !== 0) {
      res.status(502).json({ error: 'Could not read quote from TradingView', stderr: pyResult.stderr.slice(0, 300) });
      return;
    }

    res.json(quoteData);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

export default router;
