#!/usr/bin/env npx tsx
/**
 * Web Bridge Server — WebSocket relay between CLI and Chrome extension.
 *
 * Usage:
 *   npx tsx bridge-server.ts [--port 9223]
 *
 * Architecture:
 *   CLI <──WebSocket──> bridge-server <──WebSocket──> Chrome extension
 *
 * The bridge server waits for the extension to connect, then relays
 * CDP-style commands from the CLI to the extension (which uses chrome.debugger).
 * If no extension connects within 5 seconds, it falls back to direct CDP mode
 * (connecting to Chrome via --remote-debugging-port).
 *
 * This is the RECOMMENDED mode — it uses the user's existing browser session,
 * preserving cookies, localStorage, and login state.
 */

import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let port = 9223;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) {
    port = parseInt(args[i + 1]!, 10) || 9223;
    i++;
  }
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let extWs: WebSocket | null = null;     // Extension connection
let pendingRequests = new Map<number, {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}>();
let requestId = 0;

// ---------------------------------------------------------------------------
// CLI message handler
// ---------------------------------------------------------------------------

async function handleCliMessage(ws: WebSocket, raw: string) {
  let msg: { action: string; params?: Record<string, unknown> };
  try {
    msg = JSON.parse(raw);
  } catch {
    ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' }));
    return;
  }

  // If extension is connected, relay to it
  if (extWs && extWs.readyState === WebSocket.OPEN) {
    const id = ++requestId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('Extension request timed out (30s)'));
      }, 30_000);
      pendingRequests.set(id, { resolve, reject, timer });
    });

    extWs.send(JSON.stringify({ id, action: msg.action, params: msg.params }));

    try {
      const result = await promise;
      ws.send(JSON.stringify({ type: 'result', action: msg.action, result }));
    } catch (e: any) {
      ws.send(JSON.stringify({ type: 'error', action: msg.action, error: e.message }));
    }
    return;
  }

  // No extension — fall back to direct CDP
  const cdpPort = msg.params?.cdpPort as number || 9222;

  try {
    const result = await executeDirectCdp(msg.action, msg.params || {}, cdpPort);
    ws.send(JSON.stringify({ type: 'result', action: msg.action, result }));
  } catch (e: any) {
    ws.send(JSON.stringify({ type: 'error', action: msg.action, error: e.message }));
  }
}

// ---------------------------------------------------------------------------
// Extension message handler
// ---------------------------------------------------------------------------

function handleExtMessage(raw: string) {
  try {
    const msg = JSON.parse(raw);
    if (msg.type === 'result' && msg.id && pendingRequests.has(msg.id)) {
      const { resolve, timer } = pendingRequests.get(msg.id)!;
      clearTimeout(timer);
      pendingRequests.delete(msg.id);
      resolve(msg.result);
    } else if (msg.type === 'error' && msg.id && pendingRequests.has(msg.id)) {
      const { reject, timer } = pendingRequests.get(msg.id)!;
      clearTimeout(timer);
      pendingRequests.delete(msg.id);
      reject(new Error(msg.error));
    } else if (msg.type === 'tab_list') {
      // Tab list update — relay to any connected CLI
      // (used for state sync, not request-response)
    }
  } catch { /* malformed message */ }
}

// ---------------------------------------------------------------------------
// Direct CDP fallback (when no extension is available)
// ---------------------------------------------------------------------------

// Network capture state (shared across CDP fallback calls)
const networkStores = new Map<string, Map<string, any>>();
const networkActiveTabs = new Set<string>();
let networkListenerInstalled = false;

async function executeDirectCdp(action: string, params: Record<string, unknown>, cdpPort: number) {
  let CDP: any;
  try {
    const mod = await import('chrome-remote-interface');
    CDP = (mod as any).default ?? mod;
  } catch {
    throw new Error('chrome-remote-interface not installed and no extension connected.');
  }

  const host = 'localhost';
  const targets = await CDP.List({ host, port: cdpPort });
  const pages = targets.filter((t: any) => t.type === 'page');
  const tabId = (params.tab_id as string) || pages[0]?.id;

  if (!tabId && action !== 'get_tabs' && action !== 'new_tab' && action !== 'status') {
    throw new Error('No open tabs. Use new_tab or open a tab in Chrome first.');
  }

  // For tab management, don't need a specific client
  if (action === 'get_tabs') {
    return pages.map((p: any) => ({ id: p.id, url: p.url || '', title: p.title || '', active: p.id === pages[0]?.id }));
  }
  if (action === 'new_tab') {
    const client = await CDP({ host, port: cdpPort });
    await client.Target.createTarget({ url: (params.url as string) || 'about:blank' });
    await client.close();
    return { created: true };
  }
  if (action === 'status') {
    let version = 'unknown';
    try { const v = await CDP.Version({ host, port: cdpPort }); version = v.Browser || 'unknown'; } catch {}
    return { connected: true, debugPort: cdpPort, version, tabCount: pages.length };
  }

  const client = await CDP({ host, port: cdpPort, target: tabId });
  await client.Page.enable();
  await client.Runtime.enable();

  try {
    switch (action) {
      case 'navigate': {
        if (!params.url) throw new Error('Missing url');
        await client.Page.navigate({ url: params.url as string });
        await new Promise((r) => setTimeout(r, 500));
        const t = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
        return { url: params.url, title: t.result?.value || '' };
      }

      case 'screenshot': {
        const opts: any = { format: 'png' };
        if (params.full_page) opts.captureBeyondViewport = true;
        const r = await client.Page.captureScreenshot(opts);
        return { data: r.data };
      }

      case 'click': {
        if (params.selector) {
          const esc = (params.selector as string).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const r = await client.Runtime.evaluate({
            expression: `(function(){var e=document.querySelector('${esc}');if(!e)return'{"error":"Not found"}';e.scrollIntoView({behavior:'instant',block:'center'});e.click();return'{"clicked":true,"tag":"'+e.tagName+'","text":"'+(e.textContent||'').slice(0,80).replace(/"/g,'\\\\"')+'"}';})()`,
            returnByValue: true,
          });
          const v = r.result?.value as string;
          if (v) {
            const p = JSON.parse(v);
            if (p.error) throw new Error(p.error);
            return `Clicked ${p.tag}: "${p.text}"`;
          }
          return 'Clicked.';
        }
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: (params.x as number) || 0, y: (params.y as number) || 0, button: 'left', clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: (params.x as number) || 0, y: (params.y as number) || 0, button: 'left', clickCount: 1 });
        return `Clicked at (${params.x}, ${params.y}).`;
      }

      case 'type': {
        if (!params.text) throw new Error('Missing text');
        if (params.selector) {
          const esc = (params.selector as string).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          await client.Runtime.evaluate({ expression: `document.querySelector('${esc}')?.focus()` });
        }
        await client.Input.insertText({ text: params.text as string });
        return `Typed "${(params.text as string).slice(0, 50)}".`;
      }

      case 'scroll': {
        const amt = (params.amount as number) ?? 500;
        await client.Runtime.evaluate({ expression: `window.scrollBy({top:${amt},behavior:'instant'})` });
        return `Scrolled ${amt > 0 ? 'down' : 'up'} by ${Math.abs(amt)}px.`;
      }

      case 'extract': {
        const expr = params.selector
          ? `(function(){var e=document.querySelector('${(params.selector as string).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');return e?(e.textContent||e.innerText||''):'';})()`
          : 'document.body?document.body.innerText:""';
        const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true });
        const content = (r.result?.value as string) || '';
        return { content, length: content.length };
      }

      case 'evaluate': {
        if (!params.script) throw new Error('Missing script');
        const r = await client.Runtime.evaluate({ expression: params.script as string, returnByValue: true, awaitPromise: true });
        return r.result?.value;
      }

      case 'fill': {
        if (!params.value && params.value !== '') throw new Error('Missing value');
        const escF = (params.selector as string || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const valueF = JSON.stringify(params.value);
        await client.Runtime.evaluate({
          expression: `(function(){const t=document.querySelector('${escF}');if(!t)throw new Error('Not found');const v=${valueF};t.focus();const ns=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set||Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set;if(ns)ns.call(t,v);else t.value=v;t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));return{filled:true};})()`,
          returnByValue: true,
        });
        return 'Filled.';
      }

      case 'send_keys': {
        if (!params.keys) throw new Error('Missing keys');
        // Simplified: insert text for printable keys
        await client.Input.insertText({ text: params.keys as string });
        return `Sent keys: ${params.keys}`;
      }

      case 'cdp': {
        if (!params.method) throw new Error('Missing CDP method');
        const cdpResult = await client.send(params.method as string, (params.params || {}) as any);
        return cdpResult;
      }

      case 'snapshot': {
        const axResult = await client.Accessibility?.getFullAXTree?.({}) || { nodes: [] };
        return axResult;
      }

      case 'network': {
        if (!params.cmd) throw new Error('Missing network cmd (start/stop/list/detail)');

        if (params.cmd === 'start') {
          await (client as any).Network.enable();
          // Store captured requests in a module-level cache keyed by tabId
          const tabKey = tabId || 'default';
          const store: Map<string, any> = networkStores.get(tabKey) || new Map();
          networkStores.set(tabKey, store);
          networkActiveTabs.add(tabKey);

          // Install one-shot event listener
          if (!networkListenerInstalled) {
            networkListenerInstalled = true;
            client.on('Network.requestWillBeSent', (p: any) => {
              const store = networkStores.get(tabKey);
              if (store) store.set(p.requestId, { requestId: p.requestId, url: p.request.url, method: p.request.method, timestamp: p.timestamp });
            });
            client.on('Network.responseReceived', (p: any) => {
              const store = networkStores.get(tabKey);
              const req = store?.get(p.requestId);
              if (req) { req.status = p.response.status; req.mimeType = p.response.mimeType; }
            });
            client.on('Network.loadingFinished', (p: any) => {
              const store = networkStores.get(tabKey);
              const req = store?.get(p.requestId);
              if (req) req.completed = true;
            });
          }
          return { started: true };
        }

        if (params.cmd === 'stop') {
          const tabKey = tabId || 'default';
          networkActiveTabs.delete(tabKey);
          try { await (client as any).Network.disable(); } catch {}
          return { stopped: true };
        }

        if (params.cmd === 'list') {
          const tabKey = tabId || 'default';
          const store = networkStores.get(tabKey) || new Map();
          let requests = [...store.values()];
          if (params.filter) requests = requests.filter((r: any) => r.url.includes(params.filter as string));
          return { count: requests.length, requests };
        }

        if (params.cmd === 'detail') {
          if (!params.requestId) throw new Error('requestId required');
          const tabKey = tabId || 'default';
          const store = networkStores.get(tabKey);
          const req = store?.get(params.requestId as string);
          if (!req) throw new Error('Request not found');
          const body = await (client as any).Network.getResponseBody({ requestId: params.requestId as string });
          return { ...req, body: body.body, base64Encoded: body.base64Encoded };
        }

        throw new Error(`Unknown network cmd: ${params.cmd}`);
      }

      case 'upload': {
        if (!params.selector) throw new Error('Missing selector');
        if (!params.files) throw new Error('Missing files');
        const doc = await (client as any).DOM.getDocument();
        const { nodeId } = await (client as any).DOM.querySelector({ nodeId: doc.root.nodeId, selector: params.selector });
        if (!nodeId) throw new Error(`Element not found: ${params.selector}`);
        await (client as any).DOM.setFileInputFiles({ files: params.files, nodeId });
        return `Uploaded ${(params.files as string[]).length} file(s).`;
      }

      case 'save_as_pdf': {
        const [pw, ph] = [8.27, 11.69];
        const pdfResult = await (client as any).Page.printToPDF({
          printBackground: true, landscape: false, scale: 1,
          paperWidth: pw, paperHeight: ph, preferCSSPageSize: true,
        });
        return { data: pdfResult.data, mimeType: 'application/pdf' };
      }

      case 'find_tab': {
        if (!params.url) throw new Error('URL required');
        // Extract hostname for matching
        let hostname: string;
        try { hostname = new URL(params.url as string).hostname; } catch { hostname = params.url as string; }
        const targets = await CDP.List({ host, port: cdpPort });
        const pages = targets.filter((t: any) => t.type === 'page');
        const found = pages.find((p: any) => {
          try { return new URL(p.url || '').hostname === hostname; } catch { return false; }
        });
        if (!found) throw new Error(`No tab matching URL: ${params.url}`);
        // Activate the tab by connecting to it
        const tabClient = await CDP({ host, port: cdpPort, target: found.id });
        try { await tabClient.Target.activateTarget({ targetId: found.id }); } catch {}
        await tabClient.close();
        return { id: found.id, url: found.url || '', title: found.title || '' };
      }

      default:
        throw new Error(`Unknown action: ${action}`);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Server setup
// ---------------------------------------------------------------------------

// Pending HTTP responses (for request-response via POST)
let httpResolvers = new Map<number, (result: unknown) => void>();

const httpServer = createServer(async (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (_req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // POST /cmd — relay a command to the extension or execute directly via CDP
  if (_req.method === 'POST' && _req.url === '/cmd') {
    let body = '';
    _req.on('data', (chunk) => body += chunk);
    _req.on('end', async () => {
      let msg: { action: string; params?: Record<string, unknown> };
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // Relay to extension if connected
      if (extWs && extWs.readyState === WebSocket.OPEN) {
        const id = ++requestId;
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(id);
            httpResolvers.delete(id);
            reject(new Error('Extension request timed out (30s)'));
          }, 30_000);
          pendingRequests.set(id, { resolve, reject, timer });
          httpResolvers.set(id, resolve);
        });

        extWs.send(JSON.stringify({ id, action: msg.action, params: msg.params }));

        try {
          const result = await promise;
          res.writeHead(200);
          res.end(JSON.stringify({ result }));
        } catch (e: any) {
          res.writeHead(500);
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // Fallback to direct CDP
      try {
        const result = await executeDirectCdp(msg.action, msg.params || {}, msg.params?.cdpPort as number || 9222);
        res.writeHead(200);
        res.end(JSON.stringify({ result }));
      } catch (e: any) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // GET / — status
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    extensionConnected: extWs !== null && extWs.readyState === WebSocket.OPEN,
    mode: extWs ? 'extension' : 'cdp',
    port,
  }));
});

const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws, req) => {
  const clientType = req.headers['x-bridge-client'] || 'cli';

  if (clientType === 'extension') {
    console.log('[bridge] Extension connected');
    if (extWs) { extWs.close(); }
    extWs = ws;

    ws.on('message', (data) => handleExtMessage(data.toString()));
    ws.on('close', () => {
      console.log('[bridge] Extension disconnected');
      extWs = null;
    });
  } else {
    console.log('[bridge] CLI connected');
    ws.on('message', (data) => handleCliMessage(ws, data.toString()));
  }
});

httpServer.listen(port, '127.0.0.1', () => {
  console.log(`BRIDGE_READY port=${port}`);
});

// Graceful shutdown
process.on('SIGINT', () => { process.exit(0); });
process.on('SIGTERM', () => { process.exit(0); });
