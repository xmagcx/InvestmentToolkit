#!/usr/bin/env node

/**
 * cli.js - Owned TradingView CDP CLI for InvestmentToolkit.
 * 
 * Purpose:
 *   CLI entry point for automating TradingView Desktop via Chrome DevTools Protocol.
 *   Outputs JSON to stdout. All errors → stderr.
 *   Exit codes: 0 success, 1 error, 2 connection failure.
 * 
 * Key Input Dependencies:
 *   - GET http://localhost:3001/api/portfolio and /api/screener/watchlist (for `alert list --filter`,
 *     via core/alert_filter.js: the Express backend's SQLite-backed endpoints, sent with the
 *     local API token from .runtime/api-token. Requires the backend running on :3001; an
 *     unreachable backend is an explicit error.)
 * 
 * Key Output Dependencies:
 *   - None (writes to stdout)
 * 
 * Commands:
 *   status                    — health check (CDP connection + chart state)
 *   quote [SYMBOL]            — current price from active chart
 *   alert list                — list active alerts
 *   alert create --price P --condition C [--message M]
 *   screenshot [--region R] [--output NAME]
 */

import { register, run } from './router.js';
import * as health from './core/health.js';
import * as data from './core/data.js';
import * as alerts from './core/alerts.js';
import * as capture from './core/capture.js';
import * as pine from './core/pine.js';
import * as chart from './core/chart.js';
import * as watchlist from './core/watchlist.js';
import { loadFilterSymbols } from './core/alert_filter.js';
import { sessionOnly } from './core/session.js';

// --- status ---
register('status', {
  description: 'Check CDP connection to TradingView',
  handler: () => health.healthCheck(),
});

// --- quote ---
register('quote', {
  description: 'Get real-time price quote from active chart',
  handler: (opts, positionals) => data.getQuote({ symbol: positionals[0] }),
});

// --- alert ---
register('alert', {
  description: 'Alert tools (list, create)',
  subcommands: new Map([
    ['list', {
      description: 'List active alerts',
      options: {
        filter: { type: 'boolean', short: 'f', description: 'Filter alerts by portfolio/watchlist symbols' },
      },
      handler: sessionOnly('alert list', async (opts) => {
        /**
         * With --filter, restricts the list to the symbols you hold or watch, read from the
         * backend (see core/alert_filter.js). Throws an explicit error if the backend is down.
         */
        const symbols = opts.filter ? await loadFilterSymbols() : [];
        return alerts.list(symbols);
      }),
    }],
    ['create', {
      description: 'Create a price alert',
      options: {
        price: { type: 'string', short: 'p', description: 'Price level' },
        condition: { type: 'string', short: 'c', description: 'Condition: crossing, greater_than, less_than' },
        message: { type: 'string', short: 'm', description: 'Alert message' },
      },
      handler: sessionOnly('alert create', (opts) => alerts.create({
        price: Number(opts.price),
        condition: opts.condition || 'crossing',
        message: opts.message,
      })),
    }],
    ['delete', {
      description: 'Delete all alerts',
      options: {
        all: { type: 'boolean', description: 'Delete all alerts' },
      },
      handler: sessionOnly('alert delete', (opts) => alerts.deleteAlerts({ delete_all: opts.all })),
    }],
  ]),
});

// --- screenshot ---
register('screenshot', {
  description: 'Take a screenshot of the chart',
  options: {
    region: { type: 'string', short: 'r', description: 'Region: full, chart' },
    output: { type: 'string', short: 'o', description: 'Custom filename (without .png)' },
  },
  handler: (opts) => capture.captureScreenshot({
    region: opts.region,
    filename: opts.output,
  }),
});

// --- pine ---
register('pine', {
  description: 'Pine Script editor automation (inject, read, remove)',
  subcommands: new Map([
    ['inject', {
      description: 'Inject a Pine Script file into the active chart',
      options: {
        file: { type: 'string', short: 'f', description: 'Path to .pine script file' },
        content: { type: 'string', short: 'c', description: 'Inline Pine Script content string' },
      },
      handler: async (opts) => {
        const { readFileSync, existsSync } = await import('fs');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        let scriptContent;
        if (opts.content) {
          scriptContent = opts.content;
        } else if (opts.file) {
          if (!existsSync(opts.file)) throw new Error(`Script file not found: ${opts.file}`);
          scriptContent = readFileSync(opts.file, 'utf8');
        } else {
          throw new Error('Provide --file (-f) or --content (-c)');
        }
        return pine.injectPineScript(client, scriptContent);
      },
    }],
    ['read', {
      description: 'Read indicator values from the Data Window',
      options: {
        indicator: { type: 'string', short: 'i', description: 'Indicator display name' },
      },
      handler: async (opts) => {
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return pine.readIndicatorValues(client, opts.indicator);
      },
    }],
    ['remove', {
      description: 'Remove a named indicator from the chart',
      options: {
        indicator: { type: 'string', short: 'i', description: 'Indicator display name' },
      },
      handler: async (opts) => {
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return pine.removePineScript(client, opts.indicator);
      },
    }],
    ['save', {
      description: 'Save current Pine Script to TV personal library',
      options: {
        name: { type: 'string', short: 'n', description: 'Script name for the naming dialog' },
      },
      handler: async (opts, positionals) => {
        const name = opts.name || positionals[0];
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return pine.savePineToLibrary(client, name);
      },
    }],
    ['sourceRead', {
      description: 'Open an indicator source in the Pine Editor and return its code',
      options: {
        name: { type: 'string', short: 'n', description: 'Indicator name to search (omit to read current editor)' },
      },
      handler: async (opts, positionals) => {
        const name = opts.name || positionals[0] || null;
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return pine.readSourceFromDialog(client, name);
      },
    }],
  ]),
});

// --- chart ---
register('chart', {
  description: 'Chart control — change timeframe, read Data Window',
  subcommands: new Map([
    ['timeframe', {
      description: 'Change the active chart timeframe (e.g. 1D, 60, 240, W)',
      options: {
        resolution: { type: 'string', short: 'r', description: 'Resolution: 1D, D, W, 60, 240, 15, ...' },
      },
      handler: async (opts, positionals) => {
        const resolution = opts.resolution || positionals[0];
        if (!resolution) throw new Error('Resolution required — e.g. chart timeframe 1D or -r 1D');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.changeTimeframe(client, resolution);
      },
    }],
    ['read', {
      description: 'Read all active indicator values from the Data Window panel',
      handler: async () => {
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.readDataWindow(client);
      },
    }],
    ['openDataWindow', {
      description: 'Open the Data Window panel if not already visible',
      handler: async () => {
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.openDataWindow(client);
      },
    }],
    ['saveLayout', {
      description: 'Save the current chart layout (optional --name)',
      options: {
        name: { type: 'string', short: 'n', description: 'Layout name (used if a naming dialog appears)' },
      },
      handler: async (opts) => {
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.saveLayout(client, opts.name);
      },
    }],
    ['type', {
      description: 'Change chart type — e.g. heikin-ashi, line, area, renko, bars',
      options: {
        type: { type: 'string', short: 't', description: 'Chart type alias or exact TV label' },
      },
      handler: async (opts, positionals) => {
        const type = opts.type || positionals[0];
        if (!type) throw new Error('Chart type required — e.g. chart type heikin-ashi');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.changeChartType(client, type);
      },
    }],
    ['symbol', {
      description: 'Change the active chart symbol — e.g. chart symbol AAPL',
      options: {
        symbol: { type: 'string', short: 's', description: 'Ticker symbol' },
      },
      handler: async (opts, positionals) => {
        const symbol = opts.symbol || positionals[0];
        if (!symbol) throw new Error('Symbol required — e.g. chart symbol AAPL');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.changeSymbol(client, symbol);
      },
    }],
    ['addIndicator', {
      description: 'Add a built-in indicator to the chart — e.g. chart addIndicator RSI',
      options: {
        name: { type: 'string', short: 'n', description: 'Indicator name (TV built-in or personal script)' },
      },
      handler: async (opts, positionals) => {
        const name = opts.name || positionals[0];
        if (!name) throw new Error('Indicator name required — e.g. chart addIndicator RSI');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.addIndicator(client, name);
      },
    }],
    ['removeIndicator', {
      description: 'Remove a named indicator from the chart — e.g. chart removeIndicator RSI',
      options: {
        name: { type: 'string', short: 'n', description: 'Indicator name as shown in chart legend' },
      },
      handler: async (opts, positionals) => {
        const name = opts.name || positionals[0];
        if (!name) throw new Error('Indicator name required — e.g. chart removeIndicator RSI');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.removeIndicator(client, name);
      },
    }],
    ['getSymbol', {
      description: 'Read the symbol the active chart is showing',
      handler: async () => {
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.getSymbol(client);
      },
    }],
    ['setInputs', {
      description: 'Set an indicator\'s inputs by title — e.g. chart setInputs --name "AI TA Levels" --values \'{"🟢 Buy Tier 1": 187.45}\'',
      options: {
        name: { type: 'string', short: 'n', description: 'Part of the indicator name on the chart' },
        values: { type: 'string', short: 'v', description: 'JSON object of input title -> value' },
      },
      handler: async (opts) => {
        if (!opts.name || !opts.values) throw new Error('Both --name and --values are required');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.setStudyInputs(client, opts.name, JSON.parse(opts.values));
      },
    }],
    ['indicators', {
      description: 'List indicators currently loaded on the chart',
      handler: async () => {
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return chart.listIndicators(client);
      },
    }],
  ]),
});

// --- sweep ---
register('sweep', {
  description: 'Batch TA scan — reads Data Window for each ticker in one CDP session',
  options: {
    tickers: { type: 'string', short: 't', description: 'Comma-separated ticker list, e.g. AAPL,MSFT,GOOG' },
    delay:   { type: 'string', short: 'd', description: 'Ms to wait per ticker after symbol switch (default 1500)' },
  },
  handler: async (opts, positionals) => {
    const tickerStr = opts.tickers || positionals[0];
    if (!tickerStr) throw new Error('Tickers required — e.g. sweep --tickers AAPL,MSFT,GOOG');
    const tickers  = tickerStr.split(',').map(t => t.trim()).filter(Boolean);
    const delayMs  = opts.delay ? parseInt(opts.delay, 10) : 1500;
    const { getClient } = await import('./connection.js');
    const { scanPortfolio } = await import('./core/sweep.js');
    const client = await getClient();
    return scanPortfolio(client, tickers, {
      delayMs,
      onProgress: (ticker, i, total) => process.stderr.write(`  [${i}/${total}] ${ticker}\n`),
    });
  },
});

// --- watchlist ---
register('watchlist', {
  description: 'TradingView Watchlist management',
  subcommands: new Map([
    ['open', {
      description: 'Open a watchlist by name',
      handler: sessionOnly('watchlist open', async (opts, positionals) => {
        const name = positionals[0];
        if (!name) throw new Error('Watchlist name required — e.g. watchlist open "Name"');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return watchlist.openWatchlist(client, name);
      }),
    }],
    ['get', {
      description: 'Read symbols and prices from the active or named watchlist',
      handler: sessionOnly('watchlist get', async () => {
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return watchlist.getWatchlist(client);
      }),
    }],
    ['add', {
      description: 'Add a symbol to a watchlist',
      handler: sessionOnly('watchlist add', async (opts, positionals) => {
        const wName = positionals[0];
        const symbol = positionals[1];
        if (!wName || !symbol) throw new Error('Watchlist name and symbol required — e.g. watchlist add "Name" "SYMBOL"');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return watchlist.addWatchlistItem(client, wName, symbol);
      }),
    }],
    ['remove', {
      description: 'Remove a symbol from a watchlist',
      handler: sessionOnly('watchlist remove', async (opts, positionals) => {
        const wName = positionals[0];
        const symbol = positionals[1];
        if (!wName || !symbol) throw new Error('Watchlist name and symbol required — e.g. watchlist remove "Name" "SYMBOL"');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return watchlist.removeWatchlistItem(client, wName, symbol);
      }),
    }],
    ['create', {
      description: 'Create a new watchlist',
      handler: sessionOnly('watchlist create', async (opts, positionals) => {
        const name = positionals[0];
        if (!name) throw new Error('Watchlist name required — e.g. watchlist create "Name"');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return watchlist.createWatchlist(client, name);
      }),
    }],
    ['delete', {
      description: 'Delete a watchlist',
      handler: sessionOnly('watchlist delete', async (opts, positionals) => {
        const name = positionals[0];
        if (!name) throw new Error('Watchlist name required — e.g. watchlist delete "Name"');
        const { getClient } = await import('./connection.js');
        const client = await getClient();
        return watchlist.deleteWatchlist(client, name);
      }),
    }],
  ]),
});

await run(process.argv);
