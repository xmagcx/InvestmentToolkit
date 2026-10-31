/**
 * trading.js - TradingView broker order automation via CDP DOM.
 * 
 * Purpose:
 *   Automates order placement, cancellation, modification, and list actions through
 *   TradingView's native connected brokerage panel (Broker connected via TV panel) via CDP.
 * 
 * Key Input Dependencies:
 *   None (reads live state from TradingView Desktop on port 9222 via CDP)
 * 
 * Key Output Dependencies:
 *   - PortfolioAnalysis/screenshots/ (stores generated png screenshots of orders review)
 *   - plugins/tradingview/audit/ (appends order events to daily JSONL audit logs)
 */

import { evaluate, evaluateAsync, getClient } from '../connection.js';
import { requireSession } from './session.js';
import { captureScreenshot } from './capture.js';
import { appendAuditEvent } from './audit.js';

// ── symbol switching ──────────────────────────────────────────────────────────

/**
 * Change the active chart ticker symbol.
 * 
 * Clicks the symbol title overlay, types characters using keyboard events,
 * and submits with Enter.
 * 
 * @param {string} ticker - Target symbol ticker name (e.g. "AAPL")
 * @returns {Promise<object>} Status report
 */
export async function switchChartSymbol(ticker) {
  /**
   * Asserts whether active title already matches ticker, clicks legends source title
   * elements if not, types keys sequentially via Input.dispatchKeyEvent, and clicks Enter.
   */
  const client = await getClient();
  const tickerUpper = ticker.toUpperCase();

  // Check if we are already on this symbol by checking document.title
  const alreadyActive = await evaluate(`(function() {
    var title = document.title || '';
    var ticker = ${JSON.stringify(tickerUpper)};
    var words = title.trim().split(/\\s+/);
    return words.length > 0 && words[0].toUpperCase().replace(/[-_]/g, '.') === ticker.replace(/[-_]/g, '.');
  })()`);

  if (alreadyActive) {
    return { switched: false, reason: 'Already on symbol ' + tickerUpper };
  }

  // Step 1: Try clicking the ticker title in the chart legend to open symbol search
  await evaluate(`(function() {
    var selectors = [
      '[data-name="legend-source-title"]',
      '[class*="pane-legend"] [class*="title-"]',
      '[class*="chart-markup-table"] [class*="title-"]',
    ];
    for (var i = 0; i < selectors.length; i++) {
      var els = document.querySelectorAll(selectors[i]);
      for (var j = 0; j < els.length; j++) {
        var el = els[j];
        if (el.offsetParent !== null && /^[A-Z0-9]{1,10}/.test(el.textContent.trim())) {
          el.click();
          return;
        }
      }
    }
    // No ticker element found — click chart body to focus it, then typing will open search
    var chart = document.querySelector('[class*="chart-markup-table"]') || document.body;
    chart.click();
  })()`);

  await sleep(400);

  // Step 2: Type the ticker via CDP Input events (reliable cross-platform key injection)
  for (const char of tickerUpper) {
    let code;
    let vkey = char.charCodeAt(0);
    if (/[A-Z]/.test(char)) {
      code = 'Key' + char;
    } else if (/[0-9]/.test(char)) {
      code = 'Digit' + char;
    } else if (char === '-') {
      code = 'Minus';
      vkey = 189;
    } else if (char === '.') {
      code = 'Period';
      vkey = 190;
    } else if (char === '/') {
      code = 'Slash';
      vkey = 191;
    } else {
      code = char;
    }

    await client.Input.dispatchKeyEvent({ type: 'keyDown', key: char, code, text: char, windowsVirtualKeyCode: vkey, nativeVirtualKeyCode: vkey });
    await sleep(40);
    await client.Input.dispatchKeyEvent({ type: 'keyUp', key: char, code, windowsVirtualKeyCode: vkey, nativeVirtualKeyCode: vkey });
    await sleep(40);
  }

  await sleep(800); // wait for search suggestions to load

  // Step 3: Confirm selection with Enter
  await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Enter', code: 'Enter', keyCode: 13, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  await sleep(100);
  await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Enter', code: 'Enter', keyCode: 13, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });

  await sleep(1500); // wait for chart to fully render the new symbol
  return { switched: true, ticker: tickerUpper };
}

const REACT_INPUT_SETTER = `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set`;

/**
 * Get active connection status and details of the connected broker.
 * 
 * @returns {Promise<object>} Status metrics payload including connected status, type and CAD/USD buying power
 */
export async function getBrokerStatus() {
  await requireSession('broker status');
  /**
   * Evaluates browser DOM to locate Broker SVG indicators, parse Cash/TFSA account dropdowns,
   * and read raw text nodes to match CAD/USD buying power levels.
   */
  return evaluate(`(function() {
    var brokerSvg = [...document.querySelectorAll('img')].find(function(i) {
      return /broker/i.test(i.src);
    });
    var brokerBlock = document.querySelector('[class*="brokerBlock"]');
    var connected = !!(brokerSvg && brokerBlock);

    // Buying power: title labels and values are on separate lines in innerText
    var bodyText = document.body.innerText || document.body.textContent || '';
    var cadMatch = bodyText.match(/Buying Power\\s*-\\s*CAD[\\s\\n\\r]*\\$([\\d,\\.]+)/);
    var usdMatch = bodyText.match(/Buying Power\\s*-\\s*USD[\\s\\n\\r]*\\$([\\d,\\.]+)/);
    var cadBP = cadMatch ? parseFloat(cadMatch[1].replace(/,/g,'')) : null;
    var usdBP = usdMatch ? parseFloat(usdMatch[1].replace(/,/g,'')) : null;

    // Account dropdown — find the one showing TFSA/RRSP/Cash (not the broker dropdown)
    var accountBtn = [...document.querySelectorAll('[class*="dropdownButton"]')].find(function(b) {
      return /TFSA|RRSP|Margin|Individual|Cash/i.test(b.textContent);
    });
    var accountText = accountBtn ? accountBtn.textContent.trim() : null;
    var accountMatch = accountText && accountText.match(/(TFSA|RRSP|Margin|Individual|Cash)[\\s\\-]+(\\d{4,})/i);
    var accountType = accountMatch ? accountMatch[1].toUpperCase() : null;
    var accountId   = accountMatch ? accountMatch[2] : null;

    return JSON.stringify({
      connected: connected,
      broker: connected ? 'Broker' : null,
      accountType: accountType,
      accountId: accountId,
      buyingPowerCAD: cadBP,
      buyingPowerUSD: usdBP,
    });
  })()`).then(JSON.parse);
}

/**
 * Select the specified account type in the broker panel dropdown.
 * 
 * @param {string} targetType Name of the target account type (e.g. TFSA)
 * @returns {Promise<object>} Status report showing the selected account
 */
export async function selectAccount(targetType) {
  /**
   * Clicks dropdown button, queries options lists for matching name prefix,
   * dispatches real mouse event sequence to select it, and waits 300ms.
   */
  // Click the account dropdown button — must be the one showing TFSA/RRSP/Cash,
  // not the broker selector. Use same heuristic as getBrokerStatus.
  const opened = await evaluate(`(function() {
    var btn = [...document.querySelectorAll('[class*="dropdownButton"]')].find(function(b) {
      return /TFSA|RRSP|Margin|Individual|Cash/i.test(b.textContent);
    }) || document.querySelector('[class*="dropdownButton"]');
    if (!btn) return JSON.stringify({ error: 'Account dropdown not found' });
    ['mousedown', 'mouseup', 'click'].forEach(function(t) {
      btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
    });
    return JSON.stringify({ opened: true, current: btn.textContent.trim().substring(0,40) });
  })()`).then(JSON.parse);

  if (opened.error) throw new Error(opened.error);

  // Wait 800ms for TV to CSS-show dropdown items (not DOM insertion — offsetParent is unreliable here)
  await sleep(800);

  // Find and click the target account option
  const selected = await evaluate(`(function() {
    var target = ${JSON.stringify(targetType.toUpperCase())};
    var pattern = /^(TFSA|RRSP|Cash|Margin|Individual)[\\s\\S]*\\d{4,}/i;
    var spans = [...document.querySelectorAll('span')].filter(function(s) {
      // TV updated: account spans now have class "accountName-*" not empty className (2026-06)
      return (s.className === '' || /accountName/i.test(s.className)) && pattern.test(s.textContent.trim());
    });
    var match = spans.find(function(s) {
      return s.textContent.trim().toUpperCase().startsWith(target);
    });
    if (!match) {
      // Try closing dropdown and check if already on the right account
      document.querySelector('[class*="dropdownButton"]')?.click();
      return JSON.stringify({ error: 'Account type not found: ' + target });
    }
    // Dispatch full MouseEvent sequence for both match and parentElement
    ['mousedown', 'mouseup', 'click'].forEach(function(t) {
      match.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      if (match.parentElement) {
        match.parentElement.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true }));
      }
    });
    return JSON.stringify({ selected: match.textContent.trim().substring(0,40) });
  })()`).then(JSON.parse);

  if (selected.error) throw new Error(selected.error);
  await sleep(300);
  return selected;
}

/**
 * Trigger the floating buy/sell order entry dialog.
 * 
 * @param {string} action Action command ('buy', 'sell')
 * @returns {Promise<object>} Status report showing evaluation method and click target
 */
export async function openOrderDialog(action) {
  /**
   * Checks if dialog is already open, queries buy/sell overlay button classes,
   * and dispatches a click event to trigger the dialog panel.
   */
  // If the dialog is already open, skip trying to click the overlay button
  const state = await getOrderDialogState();
  if (state.open) {
    return { method: 'already-open', clicked: state.submitButtonText };
  }

  // The Buy/Sell overlay buttons on the chart left margin trigger the floating
  // order dialog. They have classes buyButton-* and sellButton-* (hashed suffix).
  // They are NOT standard <button> elements — spans.
  const isBuy = /buy/i.test(action);

  const result = await evaluate(`(function() {
    var isBuy = ${isBuy};
    var classFragment = isBuy ? 'buyButton' : 'sellButton';

    // Strategy 1: the chart overlay bid/ask buttons (confirmed selectors)
    var btn = document.querySelector('[class*="' + classFragment + '"]');
    if (btn && btn.offsetParent) {
      btn.click();
      return JSON.stringify({ method: 'chart-overlay-class', clicked: btn.textContent.trim().substring(0,30) });
    }

    // Strategy 2: title-SXMXfs_Z spans labeled "Buy" or "Sell" at the top of the overlay
    var label = isBuy ? 'Buy' : 'Sell';
    var spans = [...document.querySelectorAll('[class*="title-"]')].filter(function(el) {
      return el.textContent.trim().toUpperCase().indexOf(label.toUpperCase()) !== -1 && el.offsetParent !== null;
    });
    if (spans.length > 0) {
      // Click the clickable parent (the button wrapper)
      var parent = spans[0].closest('[class*="button-"]') || spans[0].parentElement;
      parent.click();
      return JSON.stringify({ method: 'title-span-parent', clicked: parent.textContent.trim().substring(0,30) });
    }

    // Strategy 3: any visible element with exactly "Buy" or "Sell" text that is clickable
    var el = [...document.querySelectorAll('[class*="buy"], [class*="sell"]')].find(function(el) {
      return el.textContent.trim().toUpperCase().indexOf(label.toUpperCase()) !== -1 && el.offsetParent !== null;
    });
    if (el) {
      el.click();
      return JSON.stringify({ method: 'class-text-match', clicked: el.textContent.trim() });
    }

    return JSON.stringify({ error: 'Could not find Buy/Sell overlay button. Ensure TradingView chart is open with connected broker connected.' });
  })()`).then(JSON.parse);

  if (result.error) throw new Error(result.error);

  // Wait for dialog to appear
  await sleep(500);
  return result;
}

/**
 * Query structural properties and input values of the active order dialog.
 * 
 * @returns {Promise<object>} Order dialog details including open status, inputs list, active tabs
 */
export async function getOrderDialogState() {
  /**
   * Checks structural dialog elements, retrieves active tabs, reads input value/placeholder
   * attributes, parses ticker header name, and matches submit buttons.
   */
  return evaluate(`(function() {
    // Find the floating order dialog
    // It has a ticker header, Sell/Buy toggle, and order type tabs
    var dialog = null;

    // Look for the dialog by its structural characteristics
    var candidates = [...document.querySelectorAll('[class*="dialog"], [class*="Dialog"]')].filter(function(el) {
      return el.querySelector('input') && el.offsetParent !== null;
    });

    // Also look for the order entry panel directly
    var orderEntry = document.querySelector('[class*="orderEntry"], [class*="order-entry"]');
    if (orderEntry && orderEntry.offsetParent) candidates.unshift(orderEntry);

    // Find the one with Market/Limit/Stop tabs
    for (var i = 0; i < candidates.length; i++) {
      var text = candidates[i].textContent;
      if (/Market|Limit|Stop/i.test(text)) { dialog = candidates[i]; break; }
    }

    if (!dialog) {
      // Try finding by the submit button "Buy N TICKER MARKET"
      var submitBtn = [...document.querySelectorAll('button')].find(function(b) {
        var txt = b.textContent.trim().replace(/[\\s\\xa0]+/g, ' ');
        return /^(Buy|Sell)(?:[\\s\\xa0/]*\\d+|[\\s\\xa0]+)/i.test(txt);
      });
      if (submitBtn) dialog = submitBtn.closest('[class*="dialog"], [class*="panel"], [class*="widget"], [class*="entry"]') || submitBtn.parentElement;
    }

    if (!dialog) return JSON.stringify({ open: false });

    // Read current state
    var inputs = [...dialog.querySelectorAll('input')].map(function(i) {
      return { placeholder: i.placeholder, value: i.value, ariaLabel: i.getAttribute('aria-label'), class: i.className.substring(0,60) };
    });
    var activeTabs = [...dialog.querySelectorAll('[class*="tab"], [role="tab"]')].filter(function(t) {
      return t.getAttribute('aria-selected') === 'true' || /active|selected/i.test(t.className);
    }).map(function(t) { return t.textContent.trim(); });
    var submitBtn2 = [...dialog.querySelectorAll('button')].find(function(b) {
      var txt = b.textContent.trim().replace(/[\\s\\xa0]+/g, ' ');
      return /^(Buy|Sell)(?:[\\s\\xa0/]*\\d+|[\\s\\xa0]+)/i.test(txt);
    });
    var submitText = submitBtn2 ? submitBtn2.textContent.trim() : null;
    var ticker = dialog.textContent.match(/^([A-Z]{1,6})/)?.[1] || null;

    return JSON.stringify({
      open: true,
      ticker: ticker,
      inputs: inputs,
      activeTabs: activeTabs,
      submitButtonText: submitText,
      dialogClass: dialog.className.substring(0,80),
    });
  })()`).then(JSON.parse);
}

/**
 * Select the order type tab in the order dialog.
 * 
 * @param {string} orderType Target type tab name ('Market', 'Limit', 'Stop', 'Stop Limit')
 * @returns {Promise<object>} Status report containing the selected tab name
 */
export async function selectOrderType(orderType) {
  /**
   * Queries list of tab buttons, clicks the element matching order type, and sleeps 200ms.
   */
  // orderType: 'Market' | 'Limit' | 'Stop' | 'Stop Limit'
  const result = await evaluate(`(function() {
    var target = ${JSON.stringify(orderType)};
    var tabs = [...document.querySelectorAll('[class*="tab"], [role="tab"]')].filter(function(t) {
      return t.offsetParent !== null && t.textContent.trim() === target;
    });
    if (tabs.length === 0) return JSON.stringify({ error: 'Tab not found: ' + target });
    tabs[0].click();
    return JSON.stringify({ selected: tabs[0].textContent.trim() });
  })()`).then(JSON.parse);

  if (result.error) throw new Error(result.error);
  await sleep(200);
  return result;
}

/**
 * Fill quantity field inside the order dialog.
 * 
 * @param {number|string} shares Number of shares to input
 * @returns {Promise<object>} Status report showing the value set and input descriptor
 */
export async function setShares(shares) {
  /**
   * Focuses and selects the shares input element, uses React property descriptor setters
   * to set value safely, and dispatches input/change bubbles events.
   */
  const result = await evaluate(`(function() {
    var val = ${JSON.stringify(String(shares))};
    var setter = ${REACT_INPUT_SETTER};

    // Anchor search to the order dialog panel using the submit button
    var submitBtn = [...document.querySelectorAll('button')].find(function(b) {
      var txt = b.textContent.trim().replace(/[\\s\\xa0]+/g, ' ');
      return /^(Buy|Sell)(?:[\\s\\xa0/]*\\d+|[\\s\\xa0]+)/i.test(txt) && b.offsetParent !== null;
    });
    var root = submitBtn
      ? (submitBtn.closest('[class*="dialog"], [class*="entry"], [class*="panel"], [class*="widget"], [class*="order"]') || document)
      : document;

    var inputs = [...root.querySelectorAll('input')].filter(function(i) {
      return i.offsetParent !== null;
    });

    // Prefer an input explicitly labelled as qty/shares
    var sharesInput = inputs.find(function(i) {
      var label = (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '') + ' ' + (i.name || '');
      return /shares|qty|quantity|amount/i.test(label);
    });

    // TV Limit order form: inputs[0]=price (class contains "priceInput"), inputs[1]=qty.
    // Exclude price inputs by class, then prefer a whole-number value (qty default=1).
    // Final fallback: inputs[1] which is qty for both Limit and Market forms.
    if (!sharesInput && inputs.length > 0) {
      var nonPriceInputs = inputs.filter(function(i) {
        return !/priceInput/i.test(i.className || '');
      });
      sharesInput = nonPriceInputs.find(function(i) {
        return /^\d+$/.test((i.value || '').trim()); // whole number = qty field
      }) || nonPriceInputs[0] || inputs[1] || inputs[0];
    }

    if (!sharesInput) return JSON.stringify({ error: 'Shares input not found' });

    sharesInput.focus();
    sharesInput.select();
    setter.call(sharesInput, val);
    sharesInput.dispatchEvent(new Event('input', { bubbles: true }));
    sharesInput.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ set: val, placeholder: sharesInput.placeholder, ariaLabel: sharesInput.getAttribute('aria-label') });
  })()`).then(JSON.parse);

  if (result.error) throw new Error(result.error);
  await sleep(200);
  return result;
}

/**
 * Fill limit price field inside the order dialog.
 * 
 * @param {number|string} price Limit price target level
 * @returns {Promise<object>} Status report showing the value set and input descriptor
 */
export async function setLimitPrice(price) {
  /**
   * Resolves price input inside dialog, injects target price string using React value setters,
   * and dispatches DOM input/change events.
   */
  const result = await evaluate(`(function() {
    var val = ${JSON.stringify(String(price))};
    var setter = ${REACT_INPUT_SETTER};

    // Anchor search to the order dialog panel using the submit button
    var submitBtn = [...document.querySelectorAll('button')].find(function(b) {
      var txt = b.textContent.trim().replace(/[\\s\\xa0]+/g, ' ');
      return /^(Buy|Sell)(?:[\\s\\xa0/]*\\d+|[\\s\\xa0]+)/i.test(txt) && b.offsetParent !== null;
    });
    var root = submitBtn
      ? (submitBtn.closest('[class*="dialog"], [class*="entry"], [class*="panel"], [class*="widget"], [class*="order"]') || document)
      : document;

    var inputs = [...root.querySelectorAll('input')].filter(function(i) {
      return i.offsetParent !== null;
    });

    // Prefer an input explicitly labelled as price/limit
    var priceInput = inputs.find(function(i) {
      var label = (i.placeholder || '') + ' ' + (i.getAttribute('aria-label') || '') + ' ' + (i.name || '');
      return /limit\\s*price|price|limit/i.test(label);
    });

    // In TV's Limit order form the price field is always FIRST (qty comes after)
    if (!priceInput && inputs.length > 0) priceInput = inputs[0];

    if (!priceInput) return JSON.stringify({ error: 'Limit price input not found' });

    priceInput.focus();
    priceInput.select();
    setter.call(priceInput, val);
    priceInput.dispatchEvent(new Event('input', { bubbles: true }));
    priceInput.dispatchEvent(new Event('change', { bubbles: true }));
    return JSON.stringify({ set: val, placeholder: priceInput.placeholder, ariaLabel: priceInput.getAttribute('aria-label') });
  })()`).then(JSON.parse);

  if (result.error) throw new Error(result.error);
  await sleep(200);
  return result;
}

/**
 * Set order duration TIF to Good till cancelled.
 * 
 * @returns {Promise<object>} Status report containing click results
 */
export async function setGoodTillCancelled() {
  /**
   * Clicks 'Extra settings' toggle button if closed, clicks TIF dropdown value cell,
   * finds and clicks the 'Good till cancelled' option span, and sleeps 300ms.
   */
  // TV order form has an "Extra settings" collapsible section containing a
  // "Time in force" dropdown (default: Day). Steps:
  //   1. Expand "Extra settings" if collapsed
  //   2. Click the "Day" TIF dropdown button
  //   3. Click "Good till cancelled" from the popup menu

  // Step 1: expand "Extra settings" accordion if the TIF field isn't visible yet
  await evaluate(`(function() {
    var btns = [...document.querySelectorAll('button, [role="button"], [class*="title"], [class*="header"]')].filter(function(b) {
      return b.offsetParent !== null && /extra.settings/i.test(b.textContent);
    });
    if (btns.length > 0) btns[0].click();
    return 'done';
  })()`);
  await sleep(300);

  // Step 2: click the TIF dropdown (div.middleSlot-* near "Time in force" label = the current value div)
  const openResult = await evaluate(`(function() {
    var tifLabel = [...document.querySelectorAll('*')].find(function(el) {
      return el.offsetParent !== null && /^time.in.force$/i.test(el.textContent.trim());
    });
    if (!tifLabel) return JSON.stringify({ method: 'none', note: 'TIF label not found' });
    // Walk up to find a common row/container, then find the value cell (middleSlot or similar)
    var parent = tifLabel.parentElement;
    for (var i = 0; i < 6; i++) {
      if (!parent) break;
      // The value cell is a div whose direct text content is 'Day' (not nested deeply)
      var valueEl = [...parent.children].find(function(ch) {
        return ch.offsetParent !== null && ch.textContent.trim() === 'Day';
      });
      if (!valueEl) {
        // Try one level deeper (middleSlot pattern)
        valueEl = [...parent.querySelectorAll('[class*="middleSlot"], [class*="value"], [class*="selected"]')]
          .find(function(el) { return el.offsetParent !== null && el.textContent.trim() === 'Day'; });
      }
      if (valueEl) {
        valueEl.click();
        return JSON.stringify({ method: 'middleSlot', tag: valueEl.tagName, cls: valueEl.className.substring(0, 80) });
      }
      parent = parent.parentElement;
    }
    return JSON.stringify({ method: 'none', note: 'Day value element not found near TIF label' });
  })()`).then(JSON.parse);

  await sleep(500);

  if (openResult.method === 'none') return openResult;

  // Step 3: click "Good till cancelled" from the open dropdown/menu
  // TV uses a popup list; items may have no special role — match by text content
  const selectResult = await evaluate(`(function() {
    // Prefer shortest matching element to avoid clicking a container
    var candidates = [...document.querySelectorAll('*')].filter(function(el) {
      return el.offsetParent !== null && /good.till.cancel/i.test(el.textContent.trim()) && el.textContent.trim().length < 30;
    });
    if (candidates.length === 0) return JSON.stringify({ error: 'GTC option not found in open menu' });
    // Pick the deepest (most specific) node
    var target = candidates.reduce(function(a, b) { return a.children.length <= b.children.length ? a : b; });
    target.click();
    return JSON.stringify({ clicked: target.textContent.trim(), tag: target.tagName, cls: target.className.substring(0, 60) });
  })()`).then(JSON.parse);

  await sleep(300);
  return { open: openResult, select: selectResult };
}

/**
 * Submit the active order form by clicking the primary buy/sell button.
 * 
 * @returns {Promise<object>} Status report showing the click result and secondary confirmations
 */
export async function submitOrder() {
  /**
   * Clicks the primary transaction button, polls for the secondary confirmation popover dialog,
   * clicks 'Confirm/Place Order/Yes', and returns confirmation outcome.
   */
  // Step 1: click the primary "Buy N TICKER MARKET" button
  const result = await evaluate(`(function() {
    var submitBtn = [...document.querySelectorAll('button')].find(function(b) {
      var txt = b.textContent.trim().replace(/[\\s\\xa0]+/g, ' ');
      return /^(Buy|Sell)(?:[\\s\\xa0/]*\\d+|[\\s\\xa0]+)/i.test(txt) && b.offsetParent !== null;
    });
    if (!submitBtn) return JSON.stringify({ error: 'Submit button not found. Is the order dialog open?' });
    var text = submitBtn.textContent.trim();
    submitBtn.click();
    return JSON.stringify({ clicked: text });
  })()`).then(JSON.parse);

  if (result.error) throw new Error(result.error);

  // Step 2: wait for secondary TradingView confirmation dialog and click it.
  // TradingView shows a secondary "Confirm Order" or "Place Order" modal
  // after the primary button click. We poll for up to 3 seconds.
  await sleep(600);
  for (let attempt = 0; attempt < 6; attempt++) {
    const confirmed = await evaluate(`(function() {
      // Look for any visible "Confirm", "Place Order", "OK", or "Yes" button
      // that appeared in a new dialog after the primary click
      var btn = [...document.querySelectorAll('button')].find(function(b) {
        if (!b.offsetParent) return false;
        var text = b.textContent.trim();
        // Match confirmation patterns — short, affirmative text
        return /^(Confirm|Place Order|Place order|Send Order|OK|Yes|Submit|Send)$/i.test(text)
          || /confirm/i.test(b.getAttribute('aria-label') || '');
      });
      if (!btn) return JSON.stringify({ found: false });
      var text = btn.textContent.trim();
      btn.click();
      return JSON.stringify({ found: true, clicked: text });
    })()`).then(JSON.parse);

    if (confirmed.found) {
      result.secondaryConfirm = confirmed.clicked;
      break;
    }
    await sleep(400);
  }

  return result;
}

/**
 * Close the floating order dialog.
 * 
 * @returns {Promise<object>} Close status detailing method used ('close-button', 'escape')
 */
export async function closeOrderDialog() {
  /**
   * Locates buttons containing cancel/close aria-labels, clicks it, or dispatches Escape on fallback.
   */
  return evaluate(`(function() {
    var closeBtn = [...document.querySelectorAll('button, [role="button"]')].find(function(b) {
      var al = b.getAttribute('aria-label') || '';
      var text = b.textContent.trim();
      return /close|dismiss|cancel/i.test(al) && b.offsetParent !== null;
    });
    if (!closeBtn) {
      // Try pressing Escape
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return JSON.stringify({ method: 'escape' });
    }
    closeBtn.click();
    return JSON.stringify({ method: 'close-button' });
  })()`).then(JSON.parse);
}

/**
 * Verify form fields inside the order dialog match intended transaction values.
 * 
 * @param {object} params Object containing expected metrics
 * @param {number} params.intendedShares Expected quantity of shares
 * @param {number|null} params.intendedLimitPrice Expected limit price level
 * @returns {Promise<object>} Active dialog state report
 */
export async function verifyOrderForm({ intendedShares, intendedLimitPrice = null } = {}) {
  /**
   * Matches shares/price input values against intended parameters. Logs mismatch audit
   * events and throws on validation errors.
   */
  const state = await getOrderDialogState();
  if (!state.open) {
    appendAuditEvent('FORM_MISMATCH_ABORTED', { reason: 'Order dialog closed unexpectedly during form fill.' });
    throw new Error('Order dialog closed unexpectedly during form fill.');
  }

  // Find shares input: prefer labeled, then non-priceInput whole-number, then inputs[1].
  const sharesInput = state.inputs.find(i =>
    /shares|qty|quantity|amount/i.test((i.placeholder || '') + ' ' + (i.ariaLabel || ''))
  ) || state.inputs.filter(i => !/priceInput/i.test(i.class || '')).find(i =>
    /^\d+$/.test((i.value || '').trim())
  ) || state.inputs[1];

  if (!sharesInput) {
    appendAuditEvent('FORM_MISMATCH_ABORTED', { reason: 'Could not read shares field from order dialog after fill.' });
    throw new Error('Could not read shares field from order dialog after fill.');
  }

  const readShares = Number(sharesInput.value);
  if (!isNaN(readShares) && readShares !== intendedShares) {
    const msg = `Order form mismatch: intended ${intendedShares} shares, dialog shows ${readShares}. Aborting — do not submit.`;
    appendAuditEvent('FORM_MISMATCH_ABORTED', { intendedShares, readShares, reason: msg });
    throw new Error(msg);
  }

  if (intendedLimitPrice != null && state.inputs.length > 1) {
    // Price is always the FIRST input in TV's Limit order form
    const priceInput = state.inputs.find(i =>
      /limit\s*price|price|limit/i.test((i.placeholder || '') + ' ' + (i.ariaLabel || ''))
    ) || state.inputs[0];
    if (priceInput) {
      const readPrice = Number(priceInput.value);
      if (!isNaN(readPrice) && Math.abs(readPrice - intendedLimitPrice) > 0.01) {
        throw new Error(`Order form mismatch: intended limit $${intendedLimitPrice}, dialog shows $${readPrice}. Aborting.`);
      }
    }
  }

  return state;
}

/**
 * Verify account cash balances and margins before launching order dialogs.
 * 
 * @param {object} params Parameter configuration
 * @param {string} params.ticker Target asset ticker symbol
 * @param {string} params.action Transaction type ('buy', 'sell')
 * @param {number} params.shares Number of shares
 * @param {string} params.orderType Order structure tab name
 * @param {number|null} params.limitPrice Target pricing level
 * @param {string} params.accountType Target account name (e.g. TFSA)
 * @returns {Promise<object>} Confirmation report details card
 */
export async function preflight({ ticker, action, shares, orderType, limitPrice, accountType }) {
  await requireSession('order preflight');
  /**
   * Resolves connected broker status, maps currency CAD/USD by symbol suffix,
   * derives cost estimate, validates buying power sufficiency, and logs auditing markers.
   */
  appendAuditEvent('ORDER_REQUESTED', { ticker, action, shares, orderType, limitPrice, accountType });

  const status = await getBrokerStatus();

  if (!status.connected) {
    appendAuditEvent('ORDER_ABORTED', { reason: 'No broker connected', ticker, action, shares });
    throw new Error('No broker connected to TradingView. Log in via the Broker integration in TradingView first.');
  }

  // Currency heuristic: .TO suffix = CAD, otherwise USD
  const currency = ticker.toUpperCase().endsWith('.TO') ? 'CAD' : 'USD';
  const buyingPower = currency === 'CAD' ? status.buyingPowerCAD : status.buyingPowerUSD;

  const costEstimate = orderType === 'Limit' && limitPrice != null
    ? shares * limitPrice
    : null;

  const sufficient = costEstimate === null || buyingPower === null || (action === 'sell') || (buyingPower >= costEstimate);

  const card = {
    ticker: ticker.toUpperCase(),
    action: action.charAt(0).toUpperCase() + action.slice(1).toLowerCase(),
    shares,
    currency,
    orderType,
    limitPrice: limitPrice ?? null,
    priceDisplay: orderType === 'Limit' && limitPrice != null
      ? `$${limitPrice.toFixed(2)} ${currency} (Limit)`
      : `Market (${currency})`,
    accountType: (accountType || status.accountType || '?').toUpperCase(),
    accountId: status.accountId,
    buyingPower: buyingPower,
    buyingPowerDisplay: buyingPower != null ? `$${buyingPower.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}` : 'Unknown',
    costEstimate,
    costEstimateDisplay: costEstimate != null
      ? `$${costEstimate.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`
      : `~Market × ${shares} shares`,
    coverage: {
      sufficient,
      warning: sufficient ? null : `Insufficient ${currency} buying power. Need $${costEstimate?.toFixed(2)}, have $${buyingPower?.toFixed(2)}.`,
    },
    broker: status.broker,
    _warning: sufficient ? null : `Insufficient ${currency} buying power.`,
  };
  appendAuditEvent('PREFLIGHT_PASSED', {
    ticker: card.ticker, action: card.action, shares, orderType,
    limitPrice: limitPrice ?? null, accountType: card.accountType,
    costEstimate, buyingPower, sufficient,
  });
  return card;
}

/**
 * Execute order form injection, verification, and review screenshot sequence.
 * 
 * @param {object} params Transaction settings
 * @param {string} params.ticker Symbol ticker name
 * @param {string} params.action Transaction side ('buy', 'sell')
 * @param {number} params.shares Quantity of shares
 * @param {string} params.orderType Order structure tab type
 * @param {number|null} params.limitPrice Pricing limit level
 * @param {string} params.accountType Target account label (e.g. RRSP)
 * @returns {Promise<object>} Dialog details with screenshot path and submit text
 */
export async function executeOrder({ ticker, action, shares, orderType, limitPrice, accountType }) {
  await requireSession('order execution');
  /**
   * Closes any open dialogs, switches active symbol, selects target account, triggers dialog,
   * configures type, inputs shares and price, checks GTC, verifies form, captures screenshot, and logs.
   */
  // Ensure any existing order dialog is closed first to guarantee a clean state
  // and prevent stale accounts from leaking between orders
  await closeOrderDialog().catch(() => {});
  await sleep(400);

  // 0. Switch chart to the target ticker — the order dialog opens for the active chart symbol,
  //    so this must happen before openOrderDialog().
  if (ticker) {
    appendAuditEvent('CHART_SWITCH', { ticker });
    await switchChartSymbol(ticker);
  }

  // 1. Switch account if needed
  const status = await getBrokerStatus();
  if (accountType && status.accountType && status.accountType.toUpperCase() !== accountType.toUpperCase()) {
    await selectAccount(accountType);
    await sleep(400);
  }

  // 2. Open the order dialog
  await openOrderDialog(action);
  await sleep(600);

  // 3. Verify dialog opened
  let dialogState = await getOrderDialogState();
  if (!dialogState.open) {
    // Retry once — sometimes the click doesn't register immediately
    await openOrderDialog(action);
    await sleep(800);
    dialogState = await getOrderDialogState();
    if (!dialogState.open) {
      throw new Error('Order dialog did not open. Try clicking the Buy/Sell price button on your chart manually first.');
    }
  }

  // 4. Select order type
  const orderTypeLabel = orderType.charAt(0).toUpperCase() + orderType.slice(1).toLowerCase();
  // Map 'market' → 'Market', 'limit' → 'Limit', 'stop' → 'Stop', 'stop_limit' → 'Stop Limit'
  const tabLabel = orderType.toLowerCase() === 'stop_limit' ? 'Stop Limit'
    : orderTypeLabel;
  await selectOrderType(tabLabel);

  // 5. Set shares first — must happen before setLimitPrice so the fallback selector
  //    in setShares finds the qty field (value=1) rather than the price field once
  //    it has been filled (both are numeric; first-match would pick the price field).
  await setShares(shares);

  // 6. Set limit price after shares — it's the first input in TV's Limit form
  if ((orderType.toLowerCase() === 'limit' || orderType.toLowerCase() === 'stop_limit') && limitPrice != null) {
    await setLimitPrice(limitPrice);
  }

  // 6b. Set Good Till Cancelled duration for limit/stop orders
  if (orderType.toLowerCase() === 'limit' || orderType.toLowerCase() === 'stop_limit' || orderType.toLowerCase() === 'stop') {
    await setGoodTillCancelled();
  }

  // 7. Verify form values match intent before screenshotting (throws on mismatch)
  await verifyOrderForm({ intendedShares: shares, intendedLimitPrice: limitPrice ?? null });

  // 8. Screenshot the filled form for HITL review
  await sleep(300);
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const shot = await captureScreenshot({ region: 'full', filename: `order_review_${ts}` });

  // 9. Read the submit button text (shows "Buy 1 WYFI MARKET")
  const state = await getOrderDialogState();

  appendAuditEvent('FORM_FILLED', {
    action, shares, orderType, limitPrice: limitPrice ?? null,
    submitButtonText: state.submitButtonText,
    screenshot: shot,
  });

  return {
    screenshot: shot,
    submitButtonText: state.submitButtonText,
    dialogState: state,
  };
}

/**
 * Audit Broker Orders tab to verify order submission registered.
 * 
 * @param {object} params Verification parameters
 * @param {string} params.ticker Target symbol name
 * @param {string} params.action Transaction side
 * @param {number|null} params.limitPrice pricing limit level
 * @returns {Promise<object>} Verification details containing best match row details
 */
export async function verifyOrderInBrokerPanel({ ticker, action, limitPrice } = {}) {
  /**
   * Clicks 'Orders' tab, clicks 'Inactive/Working' sub-tabs, parses transaction rows,
   * matches symbol name, side, and price thresholds, and returns row details.
   */
  // Navigate to the Orders tab in the broker panel
  await evaluate(`(function() {
    var tabs = [...document.querySelectorAll('[role="tab"], button')].filter(function(b) {
      return b.offsetParent !== null && /^Orders(\\s*\\d+)?$/i.test(b.textContent.trim());
    });
    if (tabs.length > 0) tabs[0].click();
  })()`);
  await sleep(600);

  // Click Inactive sub-tab — new limit orders land here before they fill
  await evaluate(`(function() {
    var tabs = [...document.querySelectorAll('[role="tab"], button')].filter(function(b) {
      return b.offsetParent !== null && /^(Inactive|Working)(\\s*\\d+)?$/i.test(b.textContent.trim());
    });
    if (tabs.length > 0) tabs[0].click();
  })()`);
  await sleep(500);

  return evaluate(`(function() {
    var tickerUpper = ${JSON.stringify((ticker || '').toUpperCase())};
    var actionUpper = ${JSON.stringify((action || 'buy').toUpperCase())};
    var targetPrice = ${JSON.stringify(limitPrice ?? null)};

    // Find all visible rows that contain the ticker symbol
    var rows = [...document.querySelectorAll('tr, [class*="row"]')].filter(function(r) {
      return r.offsetParent !== null && r.textContent.includes(tickerUpper)
        && !/Symbol.*Side.*Type/i.test(r.textContent); // skip header rows
    });

    if (rows.length === 0) return JSON.stringify({ found: false, reason: 'No rows for ' + tickerUpper + ' in Inactive tab' });

    var parsed = rows.map(function(row) {
      var text = row.textContent.replace(/\\s+/g, ' ').trim();
      var orderIdMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      var prices = (text.match(/[\\d,]+\\.\\d{2}/g) || []).map(Number);
      var timeMatch = text.match(/\\d{4}-\\d{2}-\\d{2}\\s+\\d{2}:\\d{2}:\\d{2}/);
      return {
        text: text.substring(0, 200),
        orderId: orderIdMatch ? orderIdMatch[0] : null,
        prices: prices,
        time: timeMatch ? timeMatch[0] : null,
        hasSide: text.toUpperCase().includes(actionUpper),
        priceMatch: targetPrice != null ? prices.some(function(p) { return Math.abs(p - targetPrice) < 0.05; }) : true,
      };
    });

    // Prefer a row that matches both side and price; fall back to first with side match
    var best = parsed.find(function(r) { return r.hasSide && r.priceMatch; })
      || parsed.find(function(r) { return r.hasSide; })
      || parsed[0];

    return JSON.stringify({ found: true, best: best, totalRows: parsed.length });
  })()`).then(JSON.parse);
}

/**
 * Trigger order submission and execute verification loop inside broker panel.
 * 
 * @param {object} params Verification parameters
 * @param {string} params.ticker Target symbol name
 * @param {string} params.action Transaction side
 * @param {number|null} params.limitPrice pricing limit level
 * @returns {Promise<object>} Status report
 */
export async function confirmAndSubmit({ ticker, action, limitPrice } = {}) {
  await requireSession('order submit');
  /**
   * Submits form inputs, logs confirmed submit event, waits 1.5s for broker update,
   * calls verifyOrderInBrokerPanel, and writes audit trail markers.
   */
  appendAuditEvent('USER_CONFIRMED_SUBMIT', {});
  const result = await submitOrder();
  appendAuditEvent('ORDER_SUBMITTED', { clicked: result.clicked, secondaryConfirm: result.secondaryConfirm ?? null });

  // Give TV a moment to register the order before reading the panel
  await sleep(1500);
  try {
    const verification = await verifyOrderInBrokerPanel({ ticker, action, limitPrice });
    result.brokerVerification = verification;
    if (verification.found && verification.best?.orderId) {
      appendAuditEvent('ORDER_CONFIRMED_IN_BROKER_PANEL', {
        orderId: verification.best.orderId,
        time: verification.best.time,
        priceMatch: verification.best.priceMatch,
      });
    } else {
      appendAuditEvent('ORDER_BROKER_PANEL_NOT_FOUND', { reason: verification.reason ?? 'No matching row' });
    }
  } catch (e) {
    result.brokerVerification = { found: false, reason: e.message };
  }

  return result;
}

// ── cancel order ─────────────────────────────────────────────────────────────

/**
 * cancelOrder({ orderId, ticker, action, limitPrice }) — locates an order in
 * TradingView's Inactive or Working sub-tab by UUID and clicks its cancel ×
 * button. Handles a secondary confirmation dialog if TV shows one.
 * Returns { cancelled, verified, orderId, ticker, reason }.
 */
/**
 * Locate a specific order row and click its action button.
 * 
 * @param {object} params Target parameters
 * @param {string} params.orderId Order UUID string
 * @param {string} params.ticker Symbol ticker name
 * @param {number} params.buttonIndex Button slot offset (-1 = cancel, -2 = edit)
 * @returns {Promise<object>} Status report
 */
async function _findOrderRowAndAct({ orderId, ticker, buttonIndex }) {
  /**
   * Filters row table elements matching the target order UUID or symbol name,
   * locates target action button index, and click it.
   */
  return evaluate(`(function() {
    var targetId = ${JSON.stringify(orderId || '')};
    var tickerUp = ${JSON.stringify((ticker || '').toUpperCase())};
    var btnIdx   = ${JSON.stringify(buttonIndex)}; // -1 = last (cancel), -2 = second-to-last (edit)

    // offsetParent is null on TV broker rows/buttons — do not use as visibility guard
    var rows = [...document.querySelectorAll('tr, [class*="row"]')].filter(function(r) {
      var text = r.textContent;
      if (targetId && text.includes(targetId)) return true;
      if (!targetId && tickerUp && text.includes(tickerUp)) return true;
      return false;
    });

    if (rows.length === 0) return JSON.stringify({ found: false });

    var row = rows[0];
    var extractedId = (row.textContent.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i) || [])[0] || targetId;

    var btns = [...row.querySelectorAll('button, [role="button"], svg')].filter(function(b) {
      return b.tagName === 'BUTTON' || b.getAttribute('role') === 'button';
    });

    var idx = btnIdx < 0 ? btns.length + btnIdx : btnIdx;
    var btn = btns[idx];
    if (!btn) {
      // Fallback: search by aria-label
      if (btnIdx === -1) btn = btns.find(function(b) { return /cancel|dismiss|close|remove/i.test(b.getAttribute('aria-label') || ''); });
      if (btnIdx === -2) btn = btns.find(function(b) { return /edit|modify|pencil/i.test(b.getAttribute('aria-label') || ''); });
    }

    if (!btn) return JSON.stringify({ found: true, orderId: extractedId, clickable: false, reason: 'Button not found (idx=' + idx + ', total=' + btns.length + ')' });

    btn.click();
    return JSON.stringify({ found: true, orderId: extractedId, clickable: true, btnLabel: btn.getAttribute('aria-label') || btn.textContent.trim().substring(0, 10) });
  })()`).then(JSON.parse);
}

/**
 * Locate and request cancellation of a specific order.
 * 
 * @param {object} params Target parameters
 * @param {string} params.orderId Order UUID string
 * @param {string} params.ticker Symbol ticker name
 * @param {string} params.action Transaction side
 * @param {number|null} params.limitPrice pricing limit level
 * @returns {Promise<object>} Cancellation outcome verification details
 */
export async function cancelOrder({ orderId, ticker, action, limitPrice } = {}) {
  await requireSession('order cancel');
  /**
   * Attempts to click cancel button without navigation, falls back to clicking Orders tab
   * and Inactive/Working, dispatches cancel clicks, polls confirm modal, and verifies disappearance.
   */
  // Strategy 1: find the row directly without navigating tabs.
  // Rows may already be visible if the broker panel is open.
  // Navigating to "Orders" tab can TOGGLE the panel closed — so try without first.
  let result = await _findOrderRowAndAct({ orderId, ticker, buttonIndex: -1 });

  // Strategy 2: try clicking Orders tab, then Inactive / Working sub-tabs
  if (!result.found) {
    await evaluate(`(function() {
      var tabs = [...document.querySelectorAll('[role="tab"], button')].filter(function(b) {
        return b.offsetParent !== null && /^Orders(\\s*\\d+)?$/i.test(b.textContent.trim());
      });
      if (tabs.length > 0) tabs[0].click();
    })()`);
    await sleep(700);

    for (const subTab of ['Inactive', 'Working']) {
      await evaluate(`(function() {
        var tabs = [...document.querySelectorAll('[role="tab"], button')].filter(function(b) {
          return b.offsetParent !== null && /^(${subTab})(\\s*\\d+)?$/i.test(b.textContent.trim());
        });
        if (tabs.length > 0) tabs[0].click();
      })()`);
      await sleep(500);

      result = await _findOrderRowAndAct({ orderId, ticker, buttonIndex: -1 });
      if (result.found) break;
    }
  }

  if (!result.found) {
    appendAuditEvent('CANCEL_ORDER_NOT_FOUND', { orderId, ticker });
    return { cancelled: false, orderId, ticker, reason: 'Order row not found in broker panel' };
  }

  if (!result.clickable) {
    appendAuditEvent('CANCEL_BUTTON_MISSING', { orderId, ticker, reason: result.reason });
    return { cancelled: false, orderId: result.orderId, ticker, reason: result.reason };
  }

  appendAuditEvent('CANCEL_CLICKED', { orderId: result.orderId, ticker });

  // Poll for a secondary confirmation dialog ("Cancel this order? Yes / No")
  await sleep(400);
  for (let i = 0; i < 5; i++) {
    const confirmed = await evaluate(`(function() {
      var btn = [...document.querySelectorAll('button')].find(function(b) {
        if (!b.offsetParent) return false;
        return /^(Yes|Confirm|Cancel Order|OK)$/i.test(b.textContent.trim());
      });
      if (!btn) return JSON.stringify({ found: false });
      btn.click();
      return JSON.stringify({ found: true, clicked: btn.textContent.trim() });
    })()`).then(JSON.parse);
    if (confirmed.found) { appendAuditEvent('CANCEL_CONFIRMED', { clicked: confirmed.clicked }); break; }
    await sleep(300);
  }

  // Verify the row is gone
  await sleep(1000);
  const gone = await evaluate(`(function() {
    var targetId = ${JSON.stringify(result.orderId || orderId || '')};
    var rows = [...document.querySelectorAll('tr, [class*="row"]')].filter(function(r) {
      return r.offsetParent !== null && targetId && r.textContent.includes(targetId);
    });
    return JSON.stringify({ remaining: rows.length });
  })()`).then(JSON.parse);

  const verified = gone.remaining === 0;
  appendAuditEvent(verified ? 'ORDER_CANCELLED' : 'CANCEL_UNVERIFIED', { orderId: result.orderId, ticker, verified });
  return { cancelled: true, verified, orderId: result.orderId, ticker, action };
}

// ── modify order ─────────────────────────────────────────────────────────────

/**
 * modifyOrder({ orderId, ticker, newLimitPrice, newShares }) — clicks the pencil
 * edit button on an existing Working/Inactive order, updates price/qty via
 * React-safe input injection, and screenshots the filled edit form.
 * Caller must invoke submitModify() to confirm the change.
 */
/**
 * Load edit form workspace for an active order and inject modified params.
 * 
 * @param {object} params Modification parameters
 * @param {string} params.orderId Order UUID string
 * @param {string} params.ticker Symbol ticker name
 * @param {string} params.action Transaction side
 * @param {number|null} params.newLimitPrice New price target
 * @param {number|null} params.newShares New quantity
 * @returns {Promise<object>} Modification details with review screenshot path
 */
export async function modifyOrder({ orderId, ticker, action, newLimitPrice, newShares } = {}) {
  await requireSession('order modify');
  /**
   * Clicks edit pencil icon, captures initial form state, focuses price/qty inputs,
   * inputs new values via insertText, and takes a full review screenshot.
   */
  // Strategy 1: find row directly without nav (same fix as cancelOrder)
  let clickResult = await _findOrderRowAndAct({ orderId, ticker, buttonIndex: -2 });

  // Strategy 2: navigate to Orders tab → Inactive/Working if not found directly
  if (!clickResult.found) {
    await evaluate(`(function() {
      var tabs = [...document.querySelectorAll('[role="tab"], button')].filter(function(b) {
        return b.offsetParent !== null && /^Orders(\\s*\\d+)?$/i.test(b.textContent.trim());
      });
      if (tabs.length > 0) tabs[0].click();
    })()`);
    await sleep(700);

    for (const subTab of ['Inactive', 'Working']) {
      await evaluate(`(function() {
        var tabs = [...document.querySelectorAll('[role="tab"], button')].filter(function(b) {
          return b.offsetParent !== null && /^(${subTab})(\\s*\\d+)?$/i.test(b.textContent.trim());
        });
        if (tabs.length > 0) tabs[0].click();
      })()`);
      await sleep(500);
      clickResult = await _findOrderRowAndAct({ orderId, ticker, buttonIndex: -2 });
      if (clickResult.found) break;
    }
  }

  if (!clickResult.found) return { modified: false, orderId, ticker, reason: 'Order row not found in broker panel' };
  if (!clickResult.clickable) return { modified: false, orderId: clickResult.orderId, ticker, reason: clickResult.reason };

  appendAuditEvent('MODIFY_PENCIL_CLICKED', { orderId: clickResult.orderId, ticker });
  await sleep(900); // wait for edit form to open

  const c = await getClient();

  // Snapshot inputs before filling
  const formBefore = await evaluate(`(function() {
    var inputs = [...document.querySelectorAll('input')].filter(function(i) { return i.offsetParent !== null; });
    return JSON.stringify(inputs.map(function(i) { return { placeholder: i.placeholder, value: i.value, label: i.getAttribute('aria-label') || '' }; }));
  })()`).then(s => { try { return JSON.parse(s); } catch { return []; } });

  // Helper: focus an input and type a value using real keyboard events.
  // This is more reliable than the React property setter for modify dialogs
  // because TV's modify form may use different React state bindings.
  async function typeIntoInput(inputFinder, valueStr) {
    // Focus the target input
    await evaluate(`(function() {
      var inputs = [...document.querySelectorAll('input')].filter(function(i) { return i.offsetParent !== null; });
      var inp = ${inputFinder};
      if (inp) { inp.focus(); inp.click(); }
    })()`);
    await sleep(80);

    // Select all existing text (Ctrl+A)
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await sleep(30);
    await c.Input.dispatchKeyEvent({ type: 'keyUp',   key: 'a', code: 'KeyA', modifiers: 2, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65 });
    await sleep(50);

    // Type the new value character by character
    await c.Input.insertText({ text: valueStr });
    await sleep(80);

    // Tab out to trigger blur/change
    await c.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(50);
    await c.Input.dispatchKeyEvent({ type: 'keyUp',   key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await sleep(100);
  }

  // Fill limit price
  if (newLimitPrice != null) {
    await typeIntoInput(
      `inputs.find(function(i) { return /price|limit/i.test((i.placeholder||'')+(i.getAttribute('aria-label')||'')); }) || inputs[0]`,
      String(newLimitPrice)
    );
  }

  // Fill shares if needed
  if (newShares != null) {
    await typeIntoInput(
      `inputs.find(function(i) { return /shares|qty|quantity/i.test((i.placeholder||'')+(i.getAttribute('aria-label')||'')); }) || inputs[inputs.length - 1]`,
      String(newShares)
    );
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const shot = await captureScreenshot({ region: 'full', filename: `order_modify_${ts}` });
  appendAuditEvent('ORDER_MODIFY_FORM_FILLED', { orderId: clickResult.orderId, ticker, newLimitPrice, newShares });

  return {
    modified: true,
    needsSubmit: true,
    orderId: clickResult.orderId,
    ticker,
    screenshot: shot,
    formBefore,
  };
}

/**
 * submitModify() — clicks the submit/save button after the modify form is filled.
 * TV reuses the same order dialog for modifications; the button patterns are
 * the same as submitOrder() but also matches "Save", "Modify", "Apply".
 */
/**
 * Submit limit/qty changes on the active modified order.
 * 
 * @param {object} params Verification parameters
 * @param {string} params.ticker Symbol name
 * @param {string} params.action Transaction side
 * @param {number|null} params.limitPrice pricing limit level
 * @param {number|null} params.newPrice New price level fallback
 * @returns {Promise<object>} Status report
 */
export async function submitModify({ ticker, action, limitPrice, newPrice } = {}) {
  await requireSession('order modify submit');
  /**
   * Resolves submit/apply modify buttons, confirms sub-dialogs, waits 1.5s,
   * verify changes inside Orders panel, and appends audit logs.
   */
  // Support both newPrice and limitPrice parameters for backward compatibility
  if (limitPrice === undefined && newPrice !== undefined) {
    limitPrice = newPrice;
  }
  // Primary button — same pattern as initial order form
  const result = await evaluate(`(function() {
    // Try "Buy/Sell N TICKER TYPE" pattern (TV reuses initial dialog)
    var btn = [...document.querySelectorAll('button')].find(function(b) {
      var txt = b.textContent.trim().replace(/[\\s\\xa0]+/g, ' ');
      return /^(Buy|Sell)(?:[\\s\\xa0/]*\\d+|[\\s\\xa0]+)/i.test(txt) && b.offsetParent !== null;
    });
    // Fallback: Save / Modify / Apply / Change / Confirm
    if (!btn) btn = [...document.querySelectorAll('button')].find(function(b) {
      if (!b.offsetParent) return false;
      return /^(Save|Modify|Apply|Change|Confirm|Place Order|Place)$/i.test(b.textContent.trim());
    });
    if (!btn) return JSON.stringify({ error: 'No submit button found for modify' });
    var text = btn.textContent.trim();
    btn.click();
    return JSON.stringify({ clicked: text });
  })()`).then(JSON.parse);

  if (result.error) throw new Error(result.error);

  // Poll for secondary confirmation dialog
  await sleep(600);
  for (let i = 0; i < 6; i++) {
    const confirmed = await evaluate(`(function() {
      var btn = [...document.querySelectorAll('button')].find(function(b) {
        if (!b.offsetParent) return false;
        return /^(Confirm|Place Order|Place|OK|Yes|Modify|Save|Change|Apply)$/i.test(b.textContent.trim());
      });
      if (!btn) return JSON.stringify({ found: false });
      btn.click();
      return JSON.stringify({ found: true, clicked: btn.textContent.trim() });
    })()`).then(JSON.parse);
    if (confirmed.found) { result.secondaryConfirm = confirmed.clicked; break; }
    await sleep(400);
  }

  appendAuditEvent('ORDER_MODIFY_SUBMITTED', { ticker, action, limitPrice, ...result });
  await sleep(1500);

  // Verify new price appears in broker panel
  try {
    const verification = await verifyOrderInBrokerPanel({ ticker, action, limitPrice });
    result.brokerVerification = verification;
    if (verification.found) {
      appendAuditEvent('ORDER_MODIFY_CONFIRMED', { priceMatch: verification.best?.priceMatch });
    }
  } catch (e) {
    result.brokerVerification = { found: false, reason: e.message };
  }

  return result;
}

/**
 * listOpenOrders() — returns ALL open orders from TradingView broker panel.
 * Navigates to Orders tab, reads Working + Inactive sub-tabs, returns every
 * row as { orderId, ticker, side, limitPrice, status, text }.
 * Used by tv_get_orders.py and the trade-log sync-from-TV endpoint.
 *
 * Returns: { found: true, orders: [{orderId, ticker, side, limitPrice, status, text}] }
 *       or { found: false, error: string }
 */
/**
 * List all active/inactive open orders listed in the broker panel.
 * 
 * @returns {Promise<object>} Status report containing orders list
 */
export async function listOpenOrders() {
  await requireSession('open orders');
  /**
   * Clicks Orders tab, traverses Working and Inactive rows sequentially,
   * parses symbol, side, limitPrice, and orderId columns, and aggregates results.
   */
  // Click the Orders tab in the broker panel
  await evaluate(`(function() {
    var tabs = [...document.querySelectorAll('[role="tab"], button')].filter(function(b) {
      return b.offsetParent !== null && /^Orders(\\s*\\d+)?$/i.test(b.textContent.trim());
    });
    if (tabs.length > 0) tabs[0].click();
  })()`);
  await sleep(600);

  const allOrders = [];

  for (const subTab of ['Working', 'Inactive']) {
    await evaluate(`(function() {
      var tabs = [...document.querySelectorAll('[role="tab"], button')].filter(function(b) {
        return b.offsetParent !== null && new RegExp('^${subTab}(\\\\s*\\\\d+)?$', 'i').test(b.textContent.trim());
      });
      if (tabs.length > 0) tabs[0].click();
    })()`);
    await sleep(500);

    const rows = await evaluate(`(function() {
      var rows = [...document.querySelectorAll('tr, [class*="row"]')].filter(function(r) {
        return r.offsetParent !== null && !/Symbol.*Side.*Type/i.test(r.textContent);
      });
      return JSON.stringify(rows.map(function(row) {
        var text = row.textContent.replace(/\\s+/g, ' ').trim();
        if (!text || text.length < 5) return null;
        var orderIdMatch = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        var prices = (text.match(/[\\d,]+\\.\\d{2}/g) || []).map(Number);
        // Extract ticker: first 1-5 uppercase word at start of row text
        var tickerMatch = text.match(/^([A-Z]{1,6}(?:\\.[A-Z]{1,3})?)/);
        return {
          orderId: orderIdMatch ? orderIdMatch[0] : null,
          ticker: tickerMatch ? tickerMatch[1] : null,
          side: /\\bBuy\\b/i.test(text) ? 'buy' : /\\bSell\\b/i.test(text) ? 'sell' : null,
          limitPrice: prices.length > 0 ? prices[0] : null,
          status: '${subTab.toLowerCase()}',
          text: text.substring(0, 200),
        };
      }).filter(Boolean));
    })()`).then(JSON.parse);

    for (const row of rows) {
      if (row.orderId && !allOrders.find(o => o.orderId === row.orderId)) {
        allOrders.push(row);
      }
    }
  }

  return { found: true, orders: allOrders };
}

/** sniffDropdownOptions — opens TIF dropdown and reads all option texts (for diagnostics) */
/**
 * Sniff options list inside TIF dropdown menu for diagnostics.
 * 
 * @returns {Promise<string[]>} List of TIF options strings
 */
export async function sniffDropdownOptions() {
  /**
   * Clicks TIF value dropdown, queries DOM for visible short text nodes,
   * and returns unique strings containing Day/GTC indicators.
   */
  // First click the Day button to open the dropdown
  await evaluate(`(function() {
    var tifLabel = [...document.querySelectorAll('*')].find(function(el) {
      return el.offsetParent !== null && /^time.in.force$/i.test(el.textContent.trim());
    });
    if (!tifLabel) return;
    var parent = tifLabel.parentElement;
    for (var i = 0; i < 6; i++) {
      if (!parent) break;
      var valueEl = [...parent.querySelectorAll('[class*="middleSlot"], [class*="value"], [class*="selected"]')]
        .find(function(el) { return el.offsetParent !== null && el.textContent.trim() === 'Day'; });
      if (valueEl) { valueEl.click(); return; }
      parent = parent.parentElement;
    }
  })()`);
  await sleep(600);
  // Read all visible short text elements — includes dropdown options even if position:fixed
  return evaluate(`(function() {
    var all = [...document.querySelectorAll('*')].filter(function(el) {
      var rect = el.getBoundingClientRect();
      var visible = rect.width > 0 && rect.height > 0 && rect.top >= 0;
      var shortText = el.childElementCount === 0 && el.textContent.trim().length > 3 && el.textContent.trim().length < 50;
      return visible && shortText;
    }).map(function(el) { return el.textContent.trim(); });
    // Deduplicate
    return JSON.stringify([...new Set(all)].filter(function(t) { return /good|till|cancel|date|extended|day|GTC/i.test(t); }));
  })()`).then(JSON.parse);
}

/** clickDayAndSnapshot — diagnostic: clicks the Day TIF button, screenshots the open menu */
/**
 * Click Day TIF button and capture diagnostic screenshot of open menu list.
 * 
 * @returns {Promise<object>} Diagnostics result containing click output and screenshot path
 */
export async function clickDayAndSnapshot() {
  /**
   * Clicks TIF Day button element, sleeps 600ms, and captures full window screenshot.
   */
  const clickResult = await evaluate(`(function() {
    var tifLabel = [...document.querySelectorAll('*')].find(function(el) {
      return el.offsetParent !== null && /^time.in.force$/i.test(el.textContent.trim());
    });
    if (!tifLabel) return JSON.stringify({ error: 'no TIF label found' });
    var parent = tifLabel.parentElement;
    for (var i = 0; i < 6; i++) {
      if (!parent) break;
      var dayEl = [...parent.querySelectorAll('*')].filter(function(el) {
        return el.offsetParent !== null && el.textContent.trim() === 'Day';
      });
      if (dayEl.length > 0) {
        var el = dayEl[dayEl.length - 1];
        el.click();
        return JSON.stringify({ found: true, tag: el.tagName, cls: el.className.substring(0, 100) });
      }
      parent = parent.parentElement;
    }
    return JSON.stringify({ error: 'Day button not found near TIF label' });
  })()`).then(JSON.parse);
  await sleep(600);
  const shot = await captureScreenshot({ region: 'full', filename: 'cbrs_tif_menu' });
  return { clickResult, screenshot: shot.file_path };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
