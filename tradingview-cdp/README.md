# TradingView CDP Automation Engine

This directory contains the standalone Node.js automation engine that controls the **TradingView Desktop** Chromium instance using the **Chrome DevTools Protocol (CDP)**. It serves as the bridge between the Python/TypeScript analytical backend and TradingView's visual chart layout, Pine Editor, and connected broker panel.

---

## 🚀 Setup & Execution

### Prerequisites
1. **TradingView Desktop** installed and running.
2. Debugging port opened at port `9222` (default) or specified via `TV_CDP_PORT`:
   ```bash
   # Launching TradingView with debugging enabled
   open -a "TradingView" --args --remote-debugging-port=9222
   ```

### Installation
From the root repository directory, initialize dependencies for this module once:
```bash
cd tradingview-cdp
npm ci
```

---

## 🛠️ CLI Interface

Commands can be invoked directly from this directory via `node cli.js [command] [subcommand] [options]`.

| Command | Subcommand | Purpose | Key Options |
|---------|------------|---------|-------------|
| `status` | — | Diagnoses the connection and verifies the active chart is loaded. | — |
| `quote` | — | Retrieves real-time bid/ask/price details for the chart symbol. | `[SYMBOL]` |
| `alert` | `list` | Lists active alerts (supports filtering by holdings). | `-f` (filter) |
| `alert` | `create` | Creates a price alert at the current chart symbol. | `-p [price]`, `-c [crossing/greater_than/less_than]`, `-m [msg]` |
| `alert` | `delete` | Deletes alerts. | `--all` |
| `screenshot` | — | Captures full-window or region snapshots. | `-r [full/chart]`, `-o [filename]` |
| `pine` | `inject` | Compiles and injects Pine Script into the chart. | `-f [file.pine]`, `-c [inline content]` |
| `pine` | `read` | Reads specific indicator output values from the Data Window. | `-i [indicator]` |
| `pine` | `remove` | Removes a Pine Script indicator from the chart. | `-i [indicator]` |
| `pine` | `save` | Saves the active script in the editor to the TV library. | `-n [name]` |
| `pine` | `sourceRead` | Opens an indicator source inside the editor and returns code. | `-n [indicator]` |
| `chart` | `timeframe` | Changes the active timeframe (e.g. 1D, 240, W). | `-r [resolution]` |
| `chart` | `type` | Changes the chart representation type (e.g. Heikin Ashi). | `-t [type]` |
| `chart` | `symbol` | Switches the chart symbol. | `-s [symbol]` |
| `chart` | `read` | Reads all values from the Data Window. | — |
| `chart` | `addIndicator` | Adds a built-in indicator to the chart. | `-n [name]` |
| `chart` | `removeIndicator`| Removes a built-in indicator from the chart. | `-n [name]` |
| `sweep` | — | Automates batch technical indicator sweeps. | `-t [TICKERS,LIST]`, `-d [delay ms]` |
| `watchlist` | `open` / `get` / `add` / `remove` / `create` / `delete` | Interacts with Watchlists inside the right-hand panel. | `[WATCHLIST_NAME]`, `[SYMBOL]` |

---

## 🔓 Anonymous mode (no TradingView login)

The engine works against a TradingView page nobody is logged into. `status` reports the session (`tv_authenticated`: `true` / `false` / `null` when the page does not expose the flag, and `session_mode`: `authenticated` / `anonymous` / `unknown`). Only the boolean `window.is_authenticated` is read — never the username, user id or auth token.

| Works anonymously | Needs a TradingView session |
|-------------------|-----------------------------|
| `status`, `quote`, `chart` (all subcommands), `sweep`, `pine`, `screenshot` | `watchlist` (open/get/add/remove/create/delete), `alert` (list/create/delete), broker reads in `core/broker_data.js` (accounts, balances, positions, orders, portfolio, order history, account totals, panel inspection), trading in `core/trading.js` (broker status, preflight, execute, submit, cancel, modify, open orders) |

A session-only command run on an anonymous page fails fast instead of failing obscurely in DOM automation: the CLI prints `{ "success": false, "error": "...", "code": "TV_SESSION_REQUIRED" }` to stderr and exits `1`, and Python callers importing the core modules directly get the same error. An unknown session state (`null`) proceeds, so nothing changes on pages that do not expose the flag.

---

## 📂 Core Architecture (`core/`)

The core automation routines are split into specialized modules:

*   **[`connection.js`](connection.js)**: Connection pool, reconnection loops, and JS execution abstraction (`evaluate`, `evaluateAsync`).
*   **[`router.js`](router.js)**: Configures CLI options parsing and handles command routing.
*   **[`core/health.js`](core/health.js)**: Verifies that the TV interface is fully rendered and the connection is stable.
*   **[`core/alerts.js`](core/alerts.js)**: Automates the alert creation dialog, reads conditions, and deletes alerts.
*   **[`core/broker_data.js`](core/broker_data.js)**: Scrapes account names, balances, open positions, and working orders from the TradingView Broker Panel.
*   **[`core/capture.js`](core/capture.js)**: Takes page screenshots (saved to `PortfolioAnalysis/screenshots/`).
*   **[`core/chart.js`](core/chart.js)**: Manages chart settings, layouts, active symbols, timeframes, and indicators.
*   **[`core/data.js`](core/data.js)**: Extracts quotes, historical OHLCV data, and loaded study configurations.
*   **[`core/session.js`](core/session.js)**: Reads the page login flag and guards session-only features with `TV_SESSION_REQUIRED`.
*   **[`core/pine.js`](core/pine.js)**: Handles Monaco Editor injections, compiling indicator overlays, and retrieving source codes.
*   **[`core/sweep.js`](core/sweep.js)**: Performs batch indicator scanning (RSI, Squeeze setups, volume biases) in a single CDP session.
*   **[`core/trading.js`](core/trading.js)**: Automates order placements (Shares, Limit Price, TIF / GTC duration) with form validation and verification.
*   **[`core/watchlist.js`](core/watchlist.js)**: Manages creation, symbols insertion, and sync workflows for Watchlists.

---

## 💡 Important Automation Constraints

### 1. Monaco Editor (Monaco/React Fiber Traversal)
TradingView's Pine Editor uses customized Monaco Editor instances where CSS classes dynamically fluctuate. To read/inject code, the engine locates elements, traverses the React component tree via the `__reactFiber` keys, and accesses the Monaco controller internally:
```javascript
const editor = fiber.return.memoizedState.memoizedState.current._editor;
editor.setValue(content);
```

### 2. UI Event Sequences
Standard `.click()` events will fail to trigger React state updates on TradingView's dropdown buttons (such as Account selectors and timeframes). The automation must dispatch a full event chain (`mousedown` + `mouseup` + `click`) to both the target element and its `parentElement`.

### 3. Subprocess Execution & WebSocket Persistence
Because the WebSocket connection holds the Node event loop open, all script execution pathways MUST complete with a termination callback to release the parent process:
```javascript
.then(() => process.exit(0))
.catch(() => process.exit(1))
```
