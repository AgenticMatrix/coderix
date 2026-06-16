#!/usr/bin/env npx tsx
/**
 * Web Bridge CLI — standalone browser automation tool.
 *
 * Usage:
 *   npx tsx web-bridge-cli.ts --action navigate   --url https://example.com
 *   npx tsx web-bridge-cli.ts --action screenshot  --full-page
 *   npx tsx web-bridge-cli.ts --action click       --selector "#btn"
 *   npx tsx web-bridge-cli.ts --action type        --text "hello" --selector input
 *   npx tsx web-bridge-cli.ts --action scroll      --amount 500
 *   npx tsx web-bridge-cli.ts --action extract     [--selector ...]
 *   npx tsx web-bridge-cli.ts --action evaluate    --script "document.title"
 *   npx tsx web-bridge-cli.ts --action get-tabs
 *   npx tsx web-bridge-cli.ts --action new-tab     [--url ...]
 *   npx tsx web-bridge-cli.ts --action close-tab   --tab-id <id>
 *   npx tsx web-bridge-cli.ts --action switch-tab  --tab-id <id>
 *   npx tsx web-bridge-cli.ts --action start-browser
 *   npx tsx web-bridge-cli.ts --action connect
 *   npx tsx web-bridge-cli.ts --action status
 *
 * Config (read from ~/.coder/settings.json web_bridge section):
 *   debugPort:    CDP port (default 9222)
 *   browserPath:  path to Chrome/Edge binary
 *   headless:     run headless (default false)
 *   userDataDir:  browser profile directory
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { isIP } from 'node:net';
import { createInterface } from 'node:readline';
import { spawn, type ChildProcess } from 'node:child_process';
import { URL } from 'node:url';
import { readFileSync } from 'node:fs';

// ---------------------------------------------------------------------------
// Parse command line args
// ---------------------------------------------------------------------------

function parseArgs(): Record<string, string | boolean | number> {
  const args: Record<string, string | boolean | number> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-/g, '_');
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        // Boolean flags
        if (next === 'true') { args[key] = true; i++; continue; }
        if (next === 'false') { args[key] = false; i++; continue; }
        // Numbers
        const num = Number(next);
        if (!isNaN(num) && next.trim() !== '') { args[key] = num; i++; continue; }
        args[key] = next;
        i++;
      } else {
        args[key] = true; // flag without value
      }
    }
  }
  return args;
}

// ---------------------------------------------------------------------------
// Load config
// ---------------------------------------------------------------------------

interface WbConfig {
  debugPort: number;
  browserPath?: string;
  headless: boolean;
  userDataDir?: string;
}

function loadConfig(): WbConfig {
  try {
    const settingsPath = join(homedir(), '.coder', 'settings.json');
    if (existsSync(settingsPath)) {
      const raw = readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(raw);
      const wb = settings.web_bridge ?? {};
      return {
        debugPort: wb.debugPort ?? 9222,
        browserPath: wb.browserPath,
        headless: wb.headless ?? false,
        userDataDir: wb.userDataDir,
      };
    }
  } catch { /* fall through */ }
  return { debugPort: 9222, headless: false };
}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

function isPrivateHost(hostname: string): boolean {
  if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(hostname)) return true;
  const ipv = isIP(hostname);
  if (ipv === 4) {
    const parts = hostname.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    return false;
  }
  if (ipv === 6) {
    const l = hostname.toLowerCase();
    if (l === '::1' || l.startsWith('fc') || l.startsWith('fd')) return true;
    if (['fe8', 'fe9', 'fea', 'feb'].some(p => l.startsWith(p))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Browser detection
// ---------------------------------------------------------------------------

function findBrowserPath(): string | null {
  if (process.platform !== 'win32') {
    for (const name of ['google-chrome','google-chrome-stable','chromium','chromium-browser',
      'microsoft-edge','microsoft-edge-stable']) {
      try {
        const { execSync } = require('node:child_process');
        const p = execSync(`command -v ${name} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (p && existsSync(p)) return p;
      } catch {}
    }
    for (const p of ['/opt/google/chrome/chrome','/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge']) {
      if (existsSync(p)) return p;
    }
    return null;
  }
  const candidates = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  ];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    candidates.push(`${local}\\Google\\Chrome\\Application\\chrome.exe`);
    candidates.push(`${local}\\Microsoft\\Edge\\Application\\msedge.exe`);
  }
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// ---------------------------------------------------------------------------
// CDP client (WebSocket-based, no chrome-remote-interface dependency needed)
// ---------------------------------------------------------------------------

// We use fetch() to talk to the CDP HTTP endpoint and raw ws for the connection.
// But for simplicity and reliability, we dynamically import chrome-remote-interface.

let CDP: any = null;
async function loadCDP() {
  if (CDP) return CDP;
  try {
    const mod = await import('chrome-remote-interface');
    CDP = (mod as any).default ?? mod;
    return CDP;
  } catch {
    throw new Error('chrome-remote-interface not installed. Run: npm install chrome-remote-interface');
  }
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs();
  const action = (args.action as string) || 'status';
  const config = loadConfig();
  const port = config.debugPort;

  // Actions that don't need CDP connection
  if (action === 'start-browser' || action === 'start_browser') {
    const browserPath = config.browserPath || findBrowserPath();
    if (!browserPath) {
      console.error('ERROR: No Chrome/Edge found. Set web_bridge.browserPath in ~/.coder/settings.json');
      process.exit(1);
    }
    const userDataDir = config.userDataDir || `${process.env.TEMP || '/tmp'}/cdp-profile-${Date.now()}`;
    const spawnArgs = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run', '--no-default-browser-check',
      'about:blank',
    ];
    if (config.headless) spawnArgs.push('--headless=new');

    const proc = spawn(browserPath, spawnArgs, { detached: true, stdio: 'ignore' });
    proc.unref();

    // Wait for CDP to be ready
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 500));
      try {
        const resp = await fetch(`http://localhost:${port}/json`, { signal: AbortSignal.timeout(1000) });
        if (resp.ok) {
          console.log(`Browser started on port ${port} (PID ${proc.pid}).`);
          return;
        }
      } catch {}
    }
    console.error('ERROR: Browser did not become ready within 15s.');
    process.exit(1);
  }

  // All other actions need CDP
  const cdp = await loadCDP();
  const host = 'localhost';

  // connect / status
  if (action === 'connect') {
    const targets = await cdp.List({ host, port });
    const pages = targets.filter((t: any) => t.type === 'page');
    console.log(`Connected to browser on port ${port}. ${pages.length} tab(s) open.`);
    for (const p of pages) {
      console.log(`  [${p.id.slice(0, 8)}] ${p.title || '(untitled)'} — ${p.url}`);
    }
    return;
  }

  if (action === 'status') {
    let version = 'unknown';
    try { const v = await cdp.Version({ host, port }); version = v.Browser || 'unknown'; } catch {}
    const targets = await cdp.List({ host, port });
    const pages = targets.filter((t: any) => t.type === 'page');
    console.log(`Port: ${port}  Version: ${version}  Tabs: ${pages.length}`);
    for (const p of pages) {
      console.log(`  [${p.id.slice(0, 8)}] ${p.title || '(untitled)'} — ${p.url}`);
    }
    return;
  }

  // Get or create a client for a specific tab (or the first available)
  async function getClient(tabId?: string) {
    const targets = await cdp.List({ host, port });
    const pages = targets.filter((t: any) => t.type === 'page');
    const targetId = tabId || pages[0]?.id;
    if (!targetId) {
      // No tab — create one
      const client = await cdp({ host, port });
      await client.Page.enable();
      await client.Runtime.enable();
      await client.DOM.enable();
      await client.Target.createTarget({ url: 'about:blank' });
      return client;
    }
    const client = await cdp({ host, port, target: targetId });
    await client.Page.enable();
    await client.Runtime.enable();
    await client.DOM.enable();
    return client;
  }

  // -------------------------------------------------------------------
  // Tab management
  // -------------------------------------------------------------------

  if (action === 'get-tabs' || action === 'get_tabs') {
    const targets = await cdp.List({ host, port });
    const pages = targets.filter((t: any) => t.type === 'page');
    for (const p of pages) {
      console.log(`[${p.id.slice(0, 8)}] ${p.title || '(untitled)'}\n  ${p.url}`);
    }
    return;
  }

  if (action === 'new-tab' || action === 'new_tab') {
    const url = (args.url as string) || 'about:blank';
    const client = await cdp({ host, port });
    await client.Page.enable();
    const result = await client.Target.createTarget({ url });
    await client.close();
    console.log(`Tab created: [${result.targetId.slice(0, 8)}] ${url}`);
    return;
  }

  if (action === 'close-tab' || action === 'close_tab') {
    const tabId = args.tab_id as string;
    if (!tabId) { console.error('ERROR: --tab-id required'); process.exit(1); }
    const client = await getClient(tabId);
    await client.Target.closeTarget({ targetId: tabId });
    await client.close();
    console.log(`Tab ${tabId.slice(0, 8)} closed.`);
    return;
  }

  if (action === 'switch-tab' || action === 'switch_tab') {
    const tabId = args.tab_id as string;
    if (!tabId) { console.error('ERROR: --tab-id required'); process.exit(1); }
    const client = await getClient(tabId);
    try { await client.Target.activateTarget({ targetId: tabId }); } catch {}
    await client.close();
    console.log(`Switched to tab ${tabId.slice(0, 8)}.`);
    return;
  }

  // -------------------------------------------------------------------
  // Page operations (need a target client)
  // -------------------------------------------------------------------

  const client = await getClient(args.tab_id as string | undefined);

  try {
    if (action === 'navigate') {
      const url = args.url as string;
      if (!url) { console.error('ERROR: --url required'); process.exit(1); }
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        console.error(`ERROR: Unsupported protocol "${parsed.protocol}"`); process.exit(1);
      }
      if (isPrivateHost(parsed.hostname)) {
        console.error(`ERROR: Cannot navigate to private address: ${parsed.hostname}`); process.exit(1);
      }
      const result = await client.Page.navigate({ url });
      if (result.errorText) { console.error(`ERROR: ${result.errorText}`); process.exit(1); }
      await new Promise(r => setTimeout(r, 500));
      const title = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
      console.log(`Navigated: ${url}`);
      console.log(`Title: ${title.result.value || ''}`);
      return;
    }

    if (action === 'screenshot') {
      const fullPage = args.full_page ?? false;
      const result = await client.Page.captureScreenshot({
        format: 'png',
        ...(fullPage ? { captureBeyondViewport: true } : {}),
      });
      // Output base64 data to stdout (with marker for parsing)
      console.log('SCREENSHOT_DATA_START');
      console.log(result.data);
      console.log('SCREENSHOT_DATA_END');
      // Also output to a temp file for convenience
      const tempPath = '/tmp/web-bridge-screenshot.png';
      const { writeFileSync } = require('node:fs');
      writeFileSync(tempPath, Buffer.from(result.data, 'base64'));
      console.log(`Screenshot saved to ${tempPath}`);
      return;
    }

    if (action === 'click') {
      const selector = args.selector as string;
      const x = args.x as number | undefined;
      const y = args.y as number | undefined;
      if (!selector && (x === undefined || y === undefined)) {
        console.error('ERROR: Need --selector or --x/--y'); process.exit(1);
      }
      if (selector) {
        const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const r = await client.Runtime.evaluate({
          expression: `(function(){var e=document.querySelector('${escaped}');if(!e)return JSON.stringify({error:'Not found: ${escaped}'});e.scrollIntoView({behavior:'instant',block:'center'});e.click();return JSON.stringify({clicked:true,tag:e.tagName,text:(e.textContent||'').slice(0,80)});})()`,
          returnByValue: true,
        });
        const v = r.result.value;
        if (v) { const p = JSON.parse(v); if (p.error) throw new Error(p.error); console.log(`Clicked ${p.tag}: "${p.text}"`); }
        else console.log('Clicked.');
      } else {
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: x!, y: y!, button: 'left', clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: x!, y: y!, button: 'left', clickCount: 1 });
        console.log(`Clicked at (${x}, ${y}).`);
      }
      return;
    }

    if (action === 'type') {
      const text = args.text as string;
      if (!text) { console.error('ERROR: --text required'); process.exit(1); }
      const selector = args.selector as string | undefined;
      if (selector) {
        const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        await client.Runtime.evaluate({
          expression: `(function(){var e=document.querySelector('${escaped}');if(!e)throw new Error('Not found: ${escaped}');e.focus();if(e.tagName==='INPUT'||e.tagName==='TEXTAREA')e.value='';})()`,
          returnByValue: true,
        });
      }
      await client.Input.insertText({ text });
      console.log(`Typed "${text.slice(0, 50)}"${selector ? ` into ${selector}` : ''}.`);
      return;
    }

    if (action === 'scroll') {
      const amount = (args.amount as number) ?? 500;
      await client.Runtime.evaluate({
        expression: `window.scrollBy({top:${amount},behavior:'instant'})`,
        returnByValue: true,
      });
      console.log(`Scrolled ${amount > 0 ? 'down' : 'up'} by ${Math.abs(amount)}px.`);
      return;
    }

    if (action === 'extract') {
      const selector = args.selector as string | undefined;
      let content = '';
      if (selector) {
        const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const r = await client.Runtime.evaluate({
          expression: `(function(){var e=document.querySelector('${escaped}');if(!e)return'';return e.textContent||e.innerText||'';})()`,
          returnByValue: true,
        });
        content = (r.result.value as string) || '';
      } else {
        const r = await client.Runtime.evaluate({
          expression: 'document.body?document.body.innerText:""',
          returnByValue: true,
        });
        content = (r.result.value as string) || '';
      }
      console.log(content);
      return;
    }

    if (action === 'evaluate') {
      const script = args.script as string;
      if (!script) { console.error('ERROR: --script required'); process.exit(1); }
      const r = await client.Runtime.evaluate({
        expression: script,
        returnByValue: true,
        awaitPromise: true,
      });
      const v = r.result.value;
      console.log(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      return;
    }

    console.error(`ERROR: Unknown action "${action}".`);
    console.error('Actions: navigate, screenshot, click, type, scroll, extract, evaluate, get-tabs, new-tab, close-tab, switch-tab, start-browser, connect, status');
    process.exit(1);
  } finally {
    await client.close().catch(() => {});
  }
}

main().catch(err => {
  console.error(`ERROR: ${err.message}`);
  process.exit(1);
});
