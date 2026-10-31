/**
 * router.js - CLI command router using node:util parseArgs.
 * 
 * Purpose:
 *   Handles CLI subcommand routing and parsing for the CDP client application.
 *   Zero dependencies — uses only Node.js built-ins.
 * 
 * Key Input Dependencies:
 *   None
 * 
 * Key Output Dependencies:
 *   None
 */
import { parseArgs } from 'node:util';

/** @type {Map<string, { description: string, options?: object, handler: Function, subcommands?: Map<string, object> }>} */
const commands = new Map();

export function register(name, config) {
  commands.set(name, config);
}

function printHelp() {
  console.log('Usage: tv <command> [options]\n');
  console.log('Commands:');
  const maxLen = Math.max(...[...commands.keys()].map(k => k.length));
  for (const [name, cmd] of commands) {
    if (cmd.subcommands) {
      const subs = [...cmd.subcommands.keys()].join(', ');
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}  [${subs}]`);
    } else {
      console.log(`  ${name.padEnd(maxLen + 2)}${cmd.description}`);
    }
  }
}

function printCommandHelp(name, cmd) {
  if (cmd.subcommands) {
    console.log(`Usage: tv ${name} <subcommand> [options]\n`);
    console.log('Subcommands:');
    for (const [sub, subConf] of cmd.subcommands) {
      console.log(`  ${sub.padEnd(12)}${subConf.description}`);
    }
  } else {
    console.log(`Usage: tv ${name} [options]\n`);
    console.log(cmd.description);
  }
  const opts = cmd.options || {};
  if (Object.keys(opts).length > 0) {
    console.log('\nOptions:');
    for (const [k, v] of Object.entries(opts)) {
      const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
      console.log(`  ${flag.padEnd(20)}${v.description || ''}`);
    }
  }
}

export async function run(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  const cmdName = args[0];
  const cmd = commands.get(cmdName);

  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    process.exit(1);
  }

  let handler, options;
  if (cmd.subcommands) {
    const subName = args[1];
    if (!subName || subName === '--help' || subName === '-h') {
      printCommandHelp(cmdName, cmd);
      process.exit(0);
    }
    const sub = cmd.subcommands.get(subName);
    if (!sub) {
      console.error(`Unknown subcommand: ${cmdName} ${subName}`);
      process.exit(1);
    }
    handler = sub.handler;
    options = sub.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  } else {
    handler = cmd.handler;
    options = cmd.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  }
}

/**
 * Execute the registered handler and write results to stdout.
 */
async function execute(handler, values, positionals) {
  /**
   * Helper function to execute command handler, stringify the JSON result,
   * dismiss any open dialogs/panes to maintain clean chart hygiene, flush to stdout, and cleanly exit.
   */
  try {
    const result = await handler(values, positionals);

    // Enforce Pitfall #31: Unconditional UI modal & pane close hygiene before process exit
    try {
      const { evaluate, evaluateAsync, getClient } = await import('./connection.js');
      const client = await getClient();
      await client.Runtime.evaluate({
        expression: `(function() {
          // 1. Close Indicators dialog if open
          var indDialog = document.querySelector('[data-name="indicators-dialog"]') ||
                          document.querySelector('[data-dialog-name="indicators-dialog"]') ||
                          [...document.querySelectorAll('[class*="dialog-"]')].find(function(d) {
                            return d.textContent && d.textContent.includes('Indicators, metrics, and strategies');
                          });
          if (indDialog) {
            var closeBtn = indDialog.querySelector('button[data-name="close"]') ||
                           indDialog.querySelector('[class*="close-"]') ||
                           indDialog.querySelector('button[aria-label="Close"]') ||
                           [...indDialog.querySelectorAll('button')].find(function(b) {
                             return b.textContent.trim() === '×' || (b.getAttribute('aria-label') || '').toLowerCase().includes('close');
                           });
            if (closeBtn) closeBtn.click();
          }

          // 2. Close Pine Editor if open (target visible top-right close button)
          var btns = Array.from(document.querySelectorAll('button[title="Close"], button[aria-label="Close"], button[data-name="close"]'));
          var visibleClose = btns.find(function(b) {
            var r = b.getBoundingClientRect();
            return r.width > 0 && r.height > 0 && r.y < 150 && r.x > 500;
          });
          if (visibleClose) {
            visibleClose.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
            visibleClose.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
            visibleClose.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
          }
        })()`,
        returnByValue: true,
        awaitPromise: false,
      });
      // Send hardware Escape to dismiss any stray dropdowns/overlays
      await client.Input.dispatchKeyEvent({ type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    } catch (_) {
      // Non-fatal if CDP disconnects or target is already closed
    }

    process.stdout.write(JSON.stringify(result, null, 2) + '\n', () => {
      process.exit(0);
    });
  } catch (err) {
    handleError(err);
  }
}

/**
 * Handle execution errors and write JSON error message to stderr.
 */
function handleError(err) {
  /**
   * Helper function to format and log execution errors, exiting with code 1 or 2.
   */
  const message = err.message || String(err);
  if (err.code === 'TV_SESSION_REQUIRED') {
    console.error(JSON.stringify({ success: false, error: message, code: 'TV_SESSION_REQUIRED' }, null, 2));
    process.exit(1);
  }
  if (/CDP|connection|ECONNREFUSED|not running/i.test(message)) {
    console.error(JSON.stringify({ success: false, error: message }, null, 2));
    process.exit(2);
  }
  console.error(JSON.stringify({ success: false, error: message }, null, 2));
  process.exit(1);
}
