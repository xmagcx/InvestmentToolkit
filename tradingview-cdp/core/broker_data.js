/**
 * broker_data.js - TradingView broker panel data reader via CDP DOM.
 * 
 * Purpose:
 *   Broker-agnostic abstraction layer that reads accounts, positions, balances,
 *   and orders from TradingView's built-in broker panel DOM via CDP.
 *   Works with any broker connected to TradingView (Broker, IBKR, etc.)
 * 
 * DOM structure confirmed via live inspection (TradingView Desktop, 2026-05-15):
 *   Tabs:       [class*="underline-tab"][class*="size-xsmall"] — compound to avoid container match
 *   ka-rows:    Shared by Positions AND Account Summary tables (class "ka-tr ka-row row-*")
 *   Pos rows:   First <td> has class "leftFixedColumn-*"
 *   Acct rows:  First <td> does NOT have "leftFixedColumn-*"
 *   Cells:      <td class="ka-cell"> — use td-only (not [class*="cell"], which doubles nested divs)
 *   Pos cols:   9 td — Symbol|Side|Qty|AvgFillPrice|Profit|UpdateTime|BorrowRate|UUID|empty
 *   Acct cols:  6 td — label|CAD|USD|CAD-combined|USD-combined|hidden
 *   Acct btn:   [class*="dropdownButton"] — button text is doubled (visual+aria); use [class*="accountName"] span
 *   Dropdown:   Items appear as <span class=""> — MUST use MutationObserver to capture before blur closes popup
 * 
 * Key Input Dependencies:
 *   None (reads live state from TradingView Desktop on port 9222 via CDP)
 * 
 * Key Output Dependencies:
 *   None (returns JSON data structures representing portfolio state)
 */

import { evaluate, evaluateAsync } from '../connection.js';
import { requireSession } from './session.js';
import { parseOrderHistoryTable } from './order_history.js';
import { settleAccountReads, switchWithRetry } from './account_reads.js';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── tab navigation ────────────────────────────────────────────────────────────

/**
 * Click a specific tab in the TradingView broker panel interface.
 * 
 * @param {string} tabLabel Text label of the tab to click (e.g. 'Positions')
 * @returns {Promise<object>} Status report containing click outcome or error
 */
async function clickTab(tabLabel) {
  /**
   * Dispatches real mouse events (mousedown, mouseup, click) to the tab button
   * element, avoiding React synthetic event issues, then waits 500ms.
   */
  const result = await evaluate(`(function() {
    var label = ${JSON.stringify(tabLabel)};
    // TV updated tab class from underline-tab/size-xsmall → roundTabButton-* (2026-06 UI update)
    // offsetParent is null on TV broker tabs even when visible — do not use it as visibility guard
    var tabs = [...document.querySelectorAll('[class*="roundTabButton"], [class*="underline-tab"]')]
      .filter(function(t) {
        var text = t.textContent.replace(/[\\u00A0\\u2007\\u202F]/g, ' ').trim();
        return text === label || text.startsWith(label + ' ') || text.startsWith(label + '\\u00A0');
      });
    if (tabs.length === 0) return JSON.stringify({ error: 'Tab not found: ' + label });
    // Plain .click() does not register on TV's React tab buttons (same class of issue as the
    // broker account dropdown — React's synthetic event system needs real mouse events).
    // Dispatch mousedown + mouseup + click to both the tab and its parentElement.
    var targets = [tabs[0], tabs[0].parentElement].filter(Boolean);
    targets.forEach(function(el) {
      ['mousedown', 'mouseup', 'click'].forEach(function(type) {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      });
    });
    return JSON.stringify({ clicked: tabs[0].textContent.trim().substring(0, 40) });
  })()`).then(JSON.parse);
  await sleep(500);
  return result;
}

// ── accounts ──────────────────────────────────────────────────────────────────

/**
 * Perform a single attempt to open the accounts dropdown and extract accounts list.
 * 
 * @returns {Promise<string[]>} Array of account display texts found in the dropdown
 */
async function _getAccountsOnce() {
  /**
   * Clicks dropdown button, waits 800ms for CSS open, queries list elements
   * matching account pattern, clicks escape to close dropdown, and returns results.
   */
  // Open dropdown
  await evaluate(`(function() {
    var btn = [...document.querySelectorAll('[class*="dropdownButton"]')].find(function(b) {
      return /TFSA|RRSP|Cash|Margin|Individual|\\d{6,}/i.test(b.textContent);
    }) || document.querySelector('[class*="dropdownButton"]');
    if (btn) {
      ['mousedown', 'mouseup', 'click'].forEach(function(t) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      });
    }
  })()`);

  // Wait for TV to render dropdown items via CSS show (not DOM insertion)
  await sleep(800);

  // Query account spans while dropdown is open
  const raw = await evaluate(`(function() {
    var pattern = /^(TFSA|RRSP|Cash|Margin|Individual)[\\s\\S]*\\d{4,}/i;
    var spans = [...document.querySelectorAll('span')].filter(function(s) {
      return (s.className === '' || /accountName/i.test(s.className)) && pattern.test(s.textContent.trim());
    });
    return JSON.stringify(spans.map(function(s) { return s.textContent.trim(); }));
  })()`).then(JSON.parse);

  // Close dropdown
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
  return raw;
}

/**
 * Enumerate all available broker accounts from the broker dropdown panel.
 * 
 * @returns {Promise<object[]>} List of parsed account descriptor objects
 */
export async function getAccounts() {
  await requireSession('broker accounts');
  /**
   * Reads the dropdown until two consecutive reads agree (account_reads.js), then
   * maps and parses matched account type names, IDs, and raw text representations.
   * A single read is never trusted: the dropdown sometimes lists only some accounts.
   */
  const raw = await settleAccountReads(_getAccountsOnce, { attempts: 4, wait: () => sleep(800) });

  function parseAccount(text) {
    var m = text.match(/^(TFSA|RRSP|Cash|Margin|Individual)\s*[-–]\s*(\d+)/i);
    return {
      accountType: m ? m[1].toUpperCase() : text.split(/[\s\-–]/)[0].toUpperCase(),
      accountId:   m ? m[2] : (text.match(/\d{6,}/) || [null])[0],
      displayText: text,
    };
  }

  return raw.map(parseAccount);
}

/**
 * Whether the account dropdown is showing its rows. TV keeps the row spans in the
 * DOM while the dropdown is closed, so a row counts only when it is rendered and
 * is not the label inside the dropdown button.
 *
 * @returns {Promise<boolean>} True when at least one account row is visible
 */
async function dropdownIsOpen() {
  return evaluate(`(function() {
    var pattern = /^(TFSA|RRSP|Cash|Margin|Individual)[\\s\\S]*\\d{4,}/i;
    return [...document.querySelectorAll('span')].some(function(s) {
      if (!((s.className === '' || /accountName/i.test(s.className)) && pattern.test(s.textContent.trim()))) return false;
      if (s.closest('[class*="dropdownButton"]')) return false;
      var r = s.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
  })()`);
}

/** Click the account dropdown button with the full mouse event sequence. */
async function toggleDropdown() {
  await evaluate(`(function() {
    var btn = [...document.querySelectorAll('[class*="dropdownButton"]')].find(function(b) {
      return /TFSA|RRSP|Cash|Margin|Individual|\\d{6,}/i.test(b.textContent);
    }) || document.querySelector('[class*="dropdownButton"]');
    if (btn) {
      ['mousedown', 'mouseup', 'click'].forEach(function(t) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      });
    }
  })()`);
}

/** Close the account dropdown. */
async function closeDropdown() {
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await sleep(200);
}

/**
 * switchAccount(accountType) — switches the broker panel to a specific account.
 *
 * TV CSS-toggles dropdown visibility so MutationObserver misses items. Same fix as
 * _getAccountsOnce: click → wait 800ms → query spans → click match → wait for reload.
 * Also removed offsetParent guard on button (can be null even when panel is visible).
 */
/**
 * Switch the broker panel view to the specified account type.
 * 
 * @param {string} accountType Name of target account type (e.g. TFSA)
 * @returns {Promise<object>} Status report of the switch attempt
 */
export async function switchAccount(accountType) {
  await requireSession('broker account switch');
  /**
   * Clicks the account dropdown button, queries lists for matching account prefix,
   * dispatches real mouse event sequence to select it, and waits 1.2s for data load.
   */
  const target = accountType.toUpperCase();

  const result = await switchWithRetry({
    isOpen: dropdownIsOpen,
    toggle: toggleDropdown,
    close: closeDropdown,
    wait: () => sleep(800),
    selectRow: () => evaluate(`(function() {
      var target = ${JSON.stringify(target)};
      var pattern = /^(TFSA|RRSP|Cash|Margin|Individual)[\\s\\S]*\\d{4,}/i;
      var spans = [...document.querySelectorAll('span')].filter(function(s) {
        return (s.className === '' || /accountName/i.test(s.className)) && pattern.test(s.textContent.trim());
      });
      var match = spans.find(function(s) {
        return s.textContent.trim().toUpperCase().startsWith(target);
      });
      if (!match) return JSON.stringify({ error: 'Account not found in dropdown: ' + target });
      // Dispatch mouse events to span and parent — .click() is unreliable on TV dropdown rows
      [match, match.parentElement].filter(Boolean).forEach(function(el) {
        ['mousedown', 'mouseup', 'click'].forEach(function(t) {
          el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
        });
      });
      return JSON.stringify({ switched: match.textContent.trim() });
    })()`).then(JSON.parse),
  });

  await sleep(1200); // wait for account data to reload
  return result;
}

/**
 * Retrieve current active account selected in the broker panel.
 * 
 * @returns {Promise<object>} Active account detail object containing type and ID
 */
export async function activeAccount() {
  await requireSession('broker active account');
  /**
   * Queries the account name element in the DOM and parses account type
   * and ID numerical string using regex.
   */
  return evaluate(`(function() {
    var span = document.querySelector('[class*="accountName"]');
    if (!span) return JSON.stringify({ accountType: null, accountId: null });
    var text = span.textContent.trim();
    var m = text.match(/^(TFSA|RRSP|Cash|Margin|Individual)\\s*[-\\u2013]\\s*(\\d+)/i);
    return JSON.stringify({
      accountType: m ? m[1].toUpperCase() : text,
      accountId:   m ? m[2] : null,
      displayText: text,
    });
  })()`).then(JSON.parse);
}

// ── balances ──────────────────────────────────────────────────────────────────

/**
 * Read the Account summary tab to retrieve full balance details.
 * 
 * Uses td-only cell selector to avoid double-counting from nested ka-cell-text divs.
 * Columns: label | CAD | USD | CAD (combined) | USD (combined) | empty
 * 
 * @returns {Promise<object>} Parsed balances object mapping CAD/USD amounts
 */
export async function getBalances() {
  await requireSession('broker balances');
  /**
   * Switches to 'Account summary' tab, queries rows, maps labels and CAD/USD cell columns,
   * assigns them into named balance fields, and reverts to the 'Positions' tab.
   */
  await clickTab('Account summary');

  const detail = await evaluate(`(function() {
    var result = {};

    // offsetParent is null on TV broker rows — do not use as visibility guard
    var rows = [...document.querySelectorAll('[class*="ka-row"]')].filter(function(r) {
      var firstTd = r.querySelector('td');
      return firstTd && !firstTd.className.includes('leftFixedColumn');
    });

    rows.forEach(function(row) {
      var tds = [...row.querySelectorAll('td')];
      if (tds.length < 2) return;

      var label = tds[0].textContent.trim().toLowerCase()
        .replace(/\\s+/g, '_').replace(/[&]/g, 'and');

      var values = tds.slice(1, 5).map(function(td) {
        var t = td.textContent.trim().replace(/[$,]/g, '');
        var n = parseFloat(t);
        return isNaN(n) ? null : n;
      });

      var labelMap = {
        'cash':               ['cashCAD', 'cashUSD', 'cashCADCombined', 'cashUSDCombined'],
        'market_value':       ['marketValueCAD', 'marketValueUSD', 'marketValueCADCombined', 'marketValueUSDCombined'],
        'total_equity':       ['totalEquityCAD', 'totalEquityUSD', 'totalEquityCADCombined', 'totalEquityUSDCombined'],
        'buying_power':       ['buyingPowerCAD', 'buyingPowerUSD', 'buyingPowerCADCombined', 'buyingPowerUSDCombined'],
        'total_buying_power': ['totalBPCAD', 'totalBPUSD', 'totalBPCADCombined', 'totalBPUSDCombined'],
        'max_buying_power':   ['maxBPCAD', 'maxBPUSD', 'maxBPCADCombined', 'maxBPUSDCombined'],
        'open_pand_l':        ['openPnLCAD', 'openPnLUSD', 'openPnLCADCombined', 'openPnLUSDCombined'],
        'closed_pand_l':      ['closedPnLCAD', 'closedPnLUSD', 'closedPnLCADCombined', 'closedPnLUSDCombined'],
      };

      var keys = labelMap[label];
      if (!keys) {
        if (/^cash$/.test(label))              keys = labelMap['cash'];
        else if (/market/.test(label))          keys = labelMap['market_value'];
        else if (/total_equity/.test(label))    keys = labelMap['total_equity'];
        else if (/^buying/.test(label))         keys = labelMap['buying_power'];
        else if (/total_buying/.test(label))    keys = labelMap['total_buying_power'];
        else if (/max_buying/.test(label))      keys = labelMap['max_buying_power'];
        else if (/open/.test(label))            keys = labelMap['open_pand_l'];
        else if (/closed/.test(label))          keys = labelMap['closed_pand_l'];
      }

      if (keys) {
        values.forEach(function(v, i) { if (keys[i] && v !== null) result[keys[i]] = v; });
      }
    });

    return JSON.stringify(result);
  })()`).then(JSON.parse);

  await clickTab('Positions');
  return detail;
}

// ── positions ─────────────────────────────────────────────────────────────────

/**
 * Retrieve all open position rows from the Positions tab.
 * 
 * Position rows: ka-row WHERE first td has "leftFixedColumn-*"
 * Cells: Symbol | Side | Qty | AvgFillPrice | Profit | UpdateTime | BorrowRate | UUID | empty
 * 
 * @returns {Promise<object>} Object listing parsed positions and raw row counts
 */
export async function getPositions() {
  await requireSession('broker positions');
  /**
   * Clicks 'Positions' tab, recursively clicks 'Show more' button (up to 15 times)
   * to expand all rows, queries the table rows, and parses symbol details.
   */
  await clickTab('Positions');

  // Expand all rows via "Show more"
  for (let i = 0; i < 15; i++) {
    const more = await evaluate(`(function() {
      var btn = [...document.querySelectorAll('button, [role="button"]')].find(function(b) {
        return /show more/i.test(b.textContent);
      });
      if (!btn) return JSON.stringify({ found: false });
      btn.click();
      return JSON.stringify({ found: true });
    })()`).then(JSON.parse);
    if (!more.found) break;
    await sleep(400);
  }

  return evaluate(`(function() {
    // offsetParent is null on TV broker rows — do not use as visibility guard
    var rows = [...document.querySelectorAll('[class*="ka-row"]')].filter(function(r) {
      var firstTd = r.querySelector('td');
      return firstTd && firstTd.className.includes('leftFixedColumn');
    });

    var positions = rows.map(function(row) {
      var tds = [...row.querySelectorAll('td')];
      if (tds.length < 3) return null;
      var texts = tds.map(function(t) { return t.textContent.trim(); });

      var symbol = texts[0];
      if (!symbol || !/^[A-Z0-9_]{1,8}(\.[A-Z0-9_]{1,4})*$/.test(symbol)) return null;

      function parseNum(s) {
        if (!s) return null;
        // Handle U+2212 MINUS SIGN used by TradingView for negative values
        s = s.replace(/\\u2212/g, '-').replace(/[$,+]/g, '');
        var n = parseFloat(s);
        return isNaN(n) ? null : n;
      }

      var positionId = null;
      for (var i = 5; i < tds.length; i++) {
        if (/^[0-9a-f]{8}-/i.test(texts[i])) { positionId = texts[i]; break; }
      }

      return {
        symbol:       symbol,
        direction:    /^(Long|Short)$/i.test(texts[1]) ? texts[1] : null,
        quantity:     parseNum(texts[2]),
        avgFillPrice: parseNum(texts[3]),
        profit:       parseNum(texts[4]),
        positionId:   positionId,
      };
    }).filter(Boolean);

    return JSON.stringify({ positions: positions, rowCount: rows.length });
  })()`).then(JSON.parse);
}

// ── orders ────────────────────────────────────────────────────────────────────

/**
 * Read the Orders tab to retrieve current working and inactive orders.
 * 
 * @returns {Promise<object[]>} List of parsed order detail objects
 */
export async function getOrders() {
  await requireSession('broker orders');
  /**
   * Switches to 'Orders' tab, parses symbol, side, qty, order type, and status
   * fields, filters out invalid rows, and switches back to the 'Positions' tab.
   */
  await clickTab('Orders');
  await sleep(300);

  const result = await evaluate(`(function() {
    // offsetParent is null on TV broker rows — do not use as visibility guard
    var rows = [...document.querySelectorAll('[class*="ka-row"]')].filter(function(r) {
      var firstTd = r.querySelector('td');
      return firstTd && firstTd.className.includes('leftFixedColumn');
    });

    return JSON.stringify(rows.map(function(row) {
      var tds = [...row.querySelectorAll('td')];
      var texts = tds.map(function(t) { return t.textContent.trim(); });
      return {
        symbol:    texts[0] || null,
        action:    texts.find(function(t) { return /^(Buy|Sell)$/i.test(t); }) || null,
        qty:       parseFloat((texts[2] || '').replace(/[^-\\d.]/g,'')) || null,
        orderType: texts.find(function(t) { return /^(Market|Limit|Stop|Stop Limit)$/i.test(t); }) || null,
        status:    texts.find(function(t) { return /Working|Filled|Cancelled|Pending|Open|Queued/i.test(t); }) || null,
      };
    }).filter(function(o) { return o.symbol && /^[A-Z]{1,6}(\\.[A-Z]{1,3})?$/.test(o.symbol); }));
  })()`).then(JSON.parse);

  await clickTab('Positions');
  return result;
}

// ── per-account snapshot ──────────────────────────────────────────────────────

/**
 * Retrieve positions and balances snapshot for the active broker account.
 * 
 * @returns {Promise<object>} Balance and position collection for active account
 */
async function getAccountSnapshot() {
  /**
   * Reads active account name/id, fetches positions, and fetches balances sequentially.
   */
  const acct    = await activeAccount();
  const posResult = await getPositions();   // sequential — each call clicks a different tab
  const balances  = await getBalances();
  return {
    accountType: acct.accountType,
    accountId:   acct.accountId,
    displayText: acct.displayText,
    balances,
    positions:   posResult.positions || [],
  };
}

// ── full portfolio (all accounts) ─────────────────────────────────────────────

/**
 * Iterate every available account, read positions + balances, and return aggregated portfolio state.
 *
 * Positions with the same symbol across accounts are kept separate (tagged with accountType).
 * The caller can aggregate quantities if needed.
 * 
 * @returns {Promise<object>} Consolidated portfolio data including snapshots list
 */
export async function getPortfolio() {
  await requireSession('broker portfolio');
  /**
   * Discovers accounts, iterates through each to switch active account views,
   * captures snapshots, and aggregates positions with account tags before returning.
   */
  const accounts = await getAccounts();
  const snapshots = [];

  for (const acct of accounts) {
    const switched = await switchAccount(acct.accountType);
    if (switched.error) {
      snapshots.push({ ...acct, error: switched.error, positions: [], balances: {} });
      continue;
    }
    const snap = await getAccountSnapshot();
    snapshots.push(snap);
  }

  // Return to first account
  if (accounts.length > 0) {
    await switchAccount(accounts[0].accountType).catch(() => {});
  }

  // All positions across all accounts, tagged with accountType
  const allPositions = [];
  for (const snap of snapshots) {
    for (const pos of (snap.positions || [])) {
      allPositions.push({ ...pos, accountType: snap.accountType, accountId: snap.accountId });
    }
  }

  return {
    dataSource:  'tradingview-cdp',
    timestamp:   new Date().toISOString(),
    accounts,
    snapshots,
    positions:   allPositions,
  };
}

// ── order history (executed trades) ───────────────────────────────────────────

/**
 * Read the active account's filled orders from the "Order history" tab.
 *
 * The panel's time column is printed in the app's local time, so each value is
 * also converted to an ISO timestamp inside the page. `expectedCount` is the
 * number on the Filled sub-tab; a mismatch with the rows read means the table
 * was not fully rendered and the caller should not trust the result.
 *
 * @returns {Promise<object>} { orders, expectedCount, missingColumns } or { error }
 */
export async function getOrderHistory() {
  await requireSession('broker order history');
  /**
   * Opens Order history, selects its Filled sub-tab, reads the visible table that
   * has Update Time and Order ID columns, and returns to the Positions tab.
   */
  const opened = await clickTab('Order history');
  if (opened.error) return { error: opened.error, orders: [] };
  await sleep(700);
  const filled = await clickTab('Filled');
  await sleep(900);

  const raw = await evaluate(`(function() {
    var table = [...document.querySelectorAll('table')].find(function(tb) {
      var heads = [...tb.querySelectorAll('thead th')].map(function(h) { return h.textContent.trim(); });
      var box = tb.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && heads.indexOf('Update Time') >= 0 && heads.indexOf('Order ID') >= 0;
    });
    if (!table) return JSON.stringify({ error: 'Order history table not found' });
    var heads = [...table.querySelectorAll('thead th')].map(function(h) { return h.textContent.trim(); });
    var timeIndex = heads.indexOf('Update Time');
    var rows = [...table.querySelectorAll('tbody tr')].map(function(r) {
      return [...r.querySelectorAll('td')].map(function(t) { return t.textContent.trim(); });
    }).filter(function(r) { return r.length >= heads.length - 1; });
    var times = rows.map(function(r) {
      var parsed = new Date(String(r[timeIndex] || '').replace(' ', 'T'));
      return isNaN(parsed.getTime()) ? null : parsed.toISOString();
    });
    var badge = [...document.querySelectorAll('[class*="roundTabButton"], [class*="underline-tab"]')]
      .map(function(t) { return t.textContent.trim(); })
      .map(function(t) { var m = t.match(/^Filled\\s*(\\d+)/); return m ? Number(m[1]) : null; })
      .find(function(n) { return n !== null; });
    return JSON.stringify({ heads: heads, rows: rows, times: times, expectedCount: badge === undefined ? null : badge });
  })()`).then(JSON.parse);

  await clickTab('Positions');
  if (raw.error) return { error: raw.error, orders: [] };
  const parsed = parseOrderHistoryTable(raw.heads, raw.rows, raw.times);
  return {
    orders: parsed.orders.filter(order => order.status === 'filled'),
    expectedCount: raw.expectedCount,
    missingColumns: parsed.missingColumns,
    filledTabError: filled.error || null,
  };
}

/**
 * Read filled orders for every broker account and restore the account that was selected.
 *
 * @returns {Promise<object>} { dataSource, timestamp, accounts: [{ accountType, orders, expectedCount, error? }] }
 */
export async function getOrderHistoryAllAccounts() {
  await requireSession('broker order history (all accounts)');
  /**
   * Iterates the account dropdown, reads each account's Order history, then
   * switches back to the originally selected account.
   */
  const original = await activeAccount();
  const accounts = await getAccounts();
  const results = [];
  for (const acct of accounts) {
    const switched = await switchAccount(acct.accountType);
    if (switched.error) {
      results.push({ accountType: acct.accountType, orders: [], error: switched.error });
      continue;
    }
    const history = await getOrderHistory();
    results.push({ accountType: acct.accountType, ...history });
  }
  if (original.accountType) {
    await switchAccount(original.accountType).catch(() => {});
  }
  return { dataSource: 'tradingview-cdp', timestamp: new Date().toISOString(), accounts: results };
}

// ── account totals ────────────────────────────────────────────────────────────

/**
 * Read Total Equity USD from each account's Account Summary tab and return consolidated totals.
 *
 * Used by the portfolio summary endpoint and the verify_portfolio_total.py audit script.
 * 
 * @returns {Promise<object>} Grand totals and per-account breakdown details in USD
 */
export async function getAccountTotals() {
  await requireSession('broker account totals');
  /**
   * Switches to each account sequentially, reads parsed balances, extracts combined
   * or base USD/CAD values, accumulates cash/market/equity sums, and reverts to the primary account.
   */
  const accounts = await getAccounts();
  const results = [];
  let grandTotalUSD = 0;
  let grandTotalCAD = 0;
  let grandMarketValueUSD = 0;
  let grandCashUSD = 0;

  for (const acct of accounts) {
    const switched = await switchAccount(acct.accountType);
    if (switched.error) {
      results.push({ accountType: acct.accountType, accountId: acct.accountId, error: switched.error });
      continue;
    }
    const balances = await getBalances();
    const equity    = balances.totalEquityUSDCombined  ?? balances.totalEquityUSD  ?? 0;
    const equityCAD = balances.totalEquityCADCombined  ?? balances.totalEquityCAD  ?? 0;
    const mktVal    = balances.marketValueUSDCombined  ?? balances.marketValueUSD  ?? 0;
    const cash      = balances.cashUSDCombined         ?? balances.cashUSD         ?? 0;
    results.push({ accountType: acct.accountType, accountId: acct.accountId,
                   totalEquityUSD: equity, totalEquityCAD: equityCAD, marketValueUSD: mktVal, cashUSD: cash });
    grandTotalUSD       += equity;
    grandTotalCAD       += equityCAD;
    grandMarketValueUSD += mktVal;
    grandCashUSD        += cash;
  }

  if (accounts.length > 0) await switchAccount(accounts[0].accountType).catch(() => {});

  return { accounts: results, grandTotalUSD, grandTotalCAD, grandMarketValueUSD, grandCashUSD,
           timestamp: new Date().toISOString() };
}

// ── inspectors ────────────────────────────────────────────────────────────────

/**
 * Inspect raw state and layout classes of the active TradingView broker panel.
 * 
 * @returns {Promise<object>} Diagnostic details on tabs, rows, and selected account
 */
export async function inspectBrokerPanel() {
  await requireSession('broker panel inspection');
  /**
   * Evaluates browser DOM to query round tab buttons, count row columns, check
   * position row class presence, and extract selected account name.
   */
  return evaluate(`(function() {
    // TV updated tab class from underline-tab/size-xsmall → roundTabButton-* (2026-06 UI update)
    // offsetParent is null on TV broker elements — do not use as visibility guard
    var tabs = [...document.querySelectorAll('[class*="roundTabButton"], [class*="underline-tab"]')]
      .map(function(t) { return { text: t.textContent.trim(), cls: t.className.substring(0, 80) }; });

    var rows = [...document.querySelectorAll('[class*="ka-row"]')]
      .slice(0, 6)
      .map(function(r) {
        var tds = [...r.querySelectorAll('td')];
        var firstTd = tds[0];
        return {
          isPositionRow: !!(firstTd && firstTd.className.includes('leftFixedColumn')),
          tdCount: tds.length,
          texts: tds.slice(0, 6).map(function(t) { return t.textContent.trim().substring(0, 20); }),
        };
      });

    var acctName = document.querySelector('[class*="accountName"]');
    return JSON.stringify({
      activeAccount: acctName ? acctName.textContent.trim() : null,
      tabs,
      rows,
    });
  })()`).then(JSON.parse);
}
