#!/usr/bin/env node
/**
 * Web Bridge Server — WebSocket + HTTP bridge.
 * Start: node bridge-server.js [--port 9223]
 */
const http = require('http');
const { WebSocketServer } = require('ws');

let CDP = null;
async function loadCDP() {
  if (CDP) return CDP;
  CDP = require('chrome-remote-interface');
  return CDP;
}

// State
let extWs = null;
let pendingRequests = new Map();
let requestId = 0;
const networkStores = new Map();
const networkActiveTabs = new Set();
let networkListenerInstalled = false;

// Parse args
let PORT = 9223;
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && process.argv[i + 1]) {
    PORT = parseInt(process.argv[++i], 10) || 9223;
  }
}

// CDP fallback
async function executeDirectCdp(action, params, cdpPort) {
  const cdp = await loadCDP();
  const host = 'localhost';
  const targets = await cdp.List({ host, port: cdpPort });
  const pages = targets.filter(t => t.type === 'page');
  const tabId = params.tab_id || pages[0]?.id;

  if (!tabId && !['get_tabs', 'new_tab', 'status', 'find_tab'].includes(action)) {
    throw new Error('No open tabs');
  }

  if (action === 'get_tabs') return pages.map(p => ({ id: p.id, url: p.url || '', title: p.title || '', active: p.id === pages[0]?.id }));
  if (action === 'new_tab') { const c = await cdp({ host, port: cdpPort }); await c.Target.createTarget({ url: params.url || 'about:blank' }); await c.close(); return { created: true }; }
  if (action === 'status') { let v = 'unknown'; try { v = (await cdp.Version({ host, port: cdpPort })).Browser || 'unknown'; } catch {} return { connected: true, debugPort: cdpPort, version: v, tabCount: pages.length }; }
  if (action === 'find_tab') {
    if (!params.url) throw new Error('URL required');
    let hn; try { hn = new URL(params.url).hostname; } catch { hn = params.url; }
    const f = pages.find(p => { try { return new URL(p.url || '').hostname === hn; } catch { return false; } });
    if (!f) throw new Error('No tab matching: ' + params.url);
    const tc = await cdp({ host, port: cdpPort, target: f.id });
    try { await tc.Target.activateTarget({ targetId: f.id }); } catch {}
    await tc.close();
    return { id: f.id, url: f.url || '', title: f.title || '' };
  }

  const client = await cdp({ host, port: cdpPort, target: tabId });
  await client.Page.enable(); await client.Runtime.enable();

  try {
    switch (action) {
      case 'navigate': {
        if (!params.url) throw new Error('url required');
        await client.Page.navigate({ url: params.url });
        await new Promise(r => setTimeout(r, 500));
        const t = await client.Runtime.evaluate({ expression: 'document.title', returnByValue: true });
        return { url: params.url, title: t.result?.value || '' };
      }
      case 'screenshot': {
        const opts = { format: 'png' };
        if (params.full_page) opts.captureBeyondViewport = true;
        const r = await client.Page.captureScreenshot(opts);
        return { data: r.data, format: 'png' };
      }
      case 'click': {
        if (params.selector) {
          const esc = params.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const r = await client.Runtime.evaluate({
            expression: "(function(){var e=document.querySelector('" + esc + "');if(!e)return JSON.stringify({error:'Not found'});e.scrollIntoView({behavior:'instant',block:'center'});e.click();return JSON.stringify({clicked:true,tag:e.tagName,text:(e.textContent||'').slice(0,80)});})()",
            returnByValue: true
          });
          const v = r.result?.value;
          if (v) { const p = JSON.parse(v); if (p.error) throw new Error(p.error); return p; }
          return { clicked: true };
        }
        const cx = params.x || 0, cy = params.y || 0;
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
        return { clicked: true, x: cx, y: cy };
      }
      case 'fill': {
        if (params.value == null) throw new Error('value required');
        const esc = (params.selector || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const v = JSON.stringify(params.value);
        await client.Runtime.evaluate({
          expression: "(function(){const t=document.querySelector('" + esc + "');const ns=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set||Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;ns.call(t," + v + ");t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));return{filled:true};})()",
          returnByValue: true
        });
        return { filled: true };
      }
      case 'type': {
        if (!params.text) throw new Error('text required');
        await client.Input.insertText({ text: params.text });
        return { typed: true };
      }
      case 'scroll': {
        const a = params.amount ?? 500;
        await client.Runtime.evaluate({ expression: 'window.scrollBy({top:' + a + ',behavior:"instant"})' });
        return { scrolled: a };
      }
      case 'extract': {
        const ex = params.selector
          ? "(function(){var e=document.querySelector('" + params.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "');return e?(e.textContent||e.innerText||''):'';})()"
          : 'document.body?document.body.innerText:""';
        const r = await client.Runtime.evaluate({ expression: ex, returnByValue: true });
        return { content: r.result?.value || '', length: (r.result?.value || '').length };
      }
      case 'evaluate': {
        if (!params.script) throw new Error('script required');
        const r = await client.Runtime.evaluate({ expression: params.script, returnByValue: true, awaitPromise: true });
        return { value: r.result?.value };
      }
      case 'network': {
        await (client.Network || client).Network?.enable?.();
        const tabKey = tabId || 'default';

        if (params.cmd === 'start') {
          const store = new Map(); networkStores.set(tabKey, store); networkActiveTabs.add(tabKey);
          if (!networkListenerInstalled) {
            networkListenerInstalled = true;
            client.on('Network.requestWillBeSent', p => { const s = networkStores.get(tabKey); if (s) s.set(p.requestId, { requestId: p.requestId, url: p.request.url, method: p.request.method, timestamp: p.timestamp }); });
            client.on('Network.responseReceived', p => { const s = networkStores.get(tabKey); const r = s?.get(p.requestId); if (r) { r.status = p.response.status; r.mimeType = p.response.mimeType; } });
            client.on('Network.loadingFinished', p => { const s = networkStores.get(tabKey); const r = s?.get(p.requestId); if (r) r.completed = true; });
          }
          return { started: true };
        }
        if (params.cmd === 'stop') { networkActiveTabs.delete(tabKey); try { await client.Network.disable(); } catch {} return { stopped: true }; }
        if (params.cmd === 'list') { const s = networkStores.get(tabKey) || new Map(); let reqs = [...s.values()]; if (params.filter) reqs = reqs.filter(r => r.url.includes(params.filter)); return { count: reqs.length, requests: reqs }; }
        if (params.cmd === 'detail') { if (!params.requestId) throw new Error('requestId required'); const s = networkStores.get(tabKey); const r = s?.get(params.requestId); if (!r) throw new Error('Not found'); const b = await client.Network.getResponseBody({ requestId: params.requestId }); return { ...r, body: b.body, base64Encoded: b.base64Encoded }; }
        throw new Error('Unknown network cmd: ' + params.cmd);
      }
      default: throw new Error('Unknown action: ' + action);
    }
  } finally { await client.close().catch(() => {}); }
}

// HTTP server
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'POST' && req.url === '/cmd') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let msg; try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return; }
      if (extWs && extWs.readyState === 1) {
        const id = ++requestId;
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => { pendingRequests.delete(id); reject(new Error('Extension timeout')); }, 30000);
          pendingRequests.set(id, { resolve, reject, timer });
        });
        extWs.send(JSON.stringify({ id, action: msg.action, params: msg.params }));
        try { const result = await promise; res.writeHead(200); res.end(JSON.stringify({ result })); }
        catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
        return;
      }
      try {
        const result = await executeDirectCdp(msg.action, msg.params || {}, msg.params?.cdpPort || 9222);
        res.writeHead(200); res.end(JSON.stringify({ result }));
      } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); }
    });
    return;
  }

  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok', extensionConnected: !!(extWs && extWs.readyState === 1), mode: extWs ? 'extension' : 'cdp', port: PORT }));
});

const wss = new WebSocketServer({ server });
wss.on('connection', (ws, req) => {
  const clientType = req.headers['x-bridge-client'] || 'cli';
  if (clientType === 'extension') {
    console.log('[bridge] Extension connected');
    if (extWs) extWs.close();
    extWs = ws;
    ws.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'result' && msg.id && pendingRequests.has(msg.id)) {
          const { resolve, timer } = pendingRequests.get(msg.id);
          clearTimeout(timer); pendingRequests.delete(msg.id); resolve(msg.result);
        } else if (msg.type === 'error' && msg.id && pendingRequests.has(msg.id)) {
          const { reject, timer } = pendingRequests.get(msg.id);
          clearTimeout(timer); pendingRequests.delete(msg.id); reject(new Error(msg.error));
        } else if (msg.type === 'hello') {
          console.log('[bridge] Extension version:', msg.version);
          // Send tab list
          ws.send(JSON.stringify({ type: 'hello_ack' }));
        }
      } catch {}
    });
    ws.on('close', () => { console.log('[bridge] Extension disconnected'); extWs = null; });
  } else {
    console.log('[bridge] CLI connected');
    ws.on('message', data => handleCliMessage(ws, data.toString()));
  }
});

async function handleCliMessage(ws, raw) {
  let msg; try { msg = JSON.parse(raw); } catch { ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' })); return; }
  if (extWs && extWs.readyState === 1) {
    const id = ++requestId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pendingRequests.delete(id); reject(new Error('Timeout')); }, 30000);
      pendingRequests.set(id, { resolve, reject, timer });
    });
    extWs.send(JSON.stringify({ id, action: msg.action, params: msg.params }));
    try { const result = await promise; ws.send(JSON.stringify({ type: 'result', action: msg.action, result })); }
    catch (e) { ws.send(JSON.stringify({ type: 'error', action: msg.action, error: e.message })); }
    return;
  }
  try {
    const result = await executeDirectCdp(msg.action, msg.params || {}, msg.params?.cdpPort || 9222);
    ws.send(JSON.stringify({ type: 'result', action: msg.action, result }));
  } catch (e) { ws.send(JSON.stringify({ type: 'error', action: msg.action, error: e.message })); }
}

server.listen(PORT, '127.0.0.1', () => {
  console.log('BRIDGE_READY port=' + PORT);
});
process.on('SIGINT', () => process.exit(0));
