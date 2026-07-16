#!/usr/bin/env node
/**
 * Web Bridge Server — HTTP API + WebSocket relay.
 *
 * Two paths for every command:
 *   1. Extension (WebSocket) — uses chrome.debugger, controls user's real browser
 *   2. Direct CDP — connects to Chrome via --remote-debugging-port, no extension needed
 *
 * Start: node bridge-server.cjs [--port 9223] [--browser-path ...] [--headless] [--no-auto-launch]
 */

const http = require('http');
const { Server: WebSocketServer } = require('ws');
const { existsSync, readFileSync, writeFileSync, mkdirSync } = require('fs');
const { join, dirname } = require('path');
const { homedir } = require('os');
const { spawn } = require('child_process');
const { isIP } = require('net');

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

let PORT = 9223;
let CDP_PORT = 9222;
let BROWSER_PATH = null;
let HEADLESS = false;
let NO_AUTO_LAUNCH = false;
let lastActiveSession = null;  // for close_session without explicit session name
const serverStartTime = Date.now();
let cdpVersion = 'unknown';

for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === '--port' && process.argv[i + 1]) {
    PORT = parseInt(process.argv[++i], 10) || 9223;
  } else if (process.argv[i] === '--cdp-port' && process.argv[i + 1]) {
    CDP_PORT = parseInt(process.argv[++i], 10) || 9222;
  } else if (process.argv[i] === '--browser-path' && process.argv[i + 1]) {
    BROWSER_PATH = process.argv[++i];
  } else if (process.argv[i] === '--headless') {
    HEADLESS = true;
  } else if (process.argv[i] === '--no-auto-launch') {
    NO_AUTO_LAUNCH = true;
  }
}

// ---------------------------------------------------------------------------
// Lazy CDP loader
// ---------------------------------------------------------------------------

let CDP = null;
function loadCDP() {
  if (CDP) return CDP;
  CDP = require('chrome-remote-interface');
  return CDP;
}

// ---------------------------------------------------------------------------
// Session state — session name → Set of tab IDs
// ---------------------------------------------------------------------------

const sessions = new Map();

function registerTab(sessionName, tabId) {
  if (!sessionName) return;
  lastActiveSession = sessionName;
  let tabs = sessions.get(sessionName);
  if (!tabs) { tabs = new Set(); sessions.set(sessionName, tabs); }
  tabs.add(tabId);
}

function unregisterTab(sessionName, tabId) {
  if (!sessionName) return;
  const tabs = sessions.get(sessionName);
  if (tabs) { tabs.delete(tabId); if (tabs.size === 0) sessions.delete(sessionName); }
}

function getActiveTabId(params, pages) {
  if (params.tab_id) return params.tab_id;
  if (params.session) {
    lastActiveSession = params.session;
    const tabs = sessions.get(params.session);
    if (tabs && tabs.size > 0) return [...tabs][tabs.size - 1];
    throw new Error(`No tabs in session "${params.session}". Use navigate with newTab:true first.`);
  }
  return pages[0]?.id;
}

// ---------------------------------------------------------------------------
// Extension state
// ---------------------------------------------------------------------------

let extWs = null;
let pendingRequests = new Map();
let requestId = 0;

// ---------------------------------------------------------------------------
// Accessibility ref system (shared between CDP and extension paths)
// ---------------------------------------------------------------------------

let elemRefs = new Map();
let refCounter = 1;

function resetRefs() { elemRefs.clear(); refCounter = 1; }

function storeRef(backendNodeId, role, name) {
  const ref = `e${refCounter++}`;
  elemRefs.set(ref, { backendNodeId, role, name });
  return ref;
}

function getRef(ref) { return elemRefs.get(ref.replace(/^@/, '')); }
function isRef(s) { return /^@?e\d+$/.test(s); }

const INTERACTIVE_ROLES = new Set([
  'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
  'slider', 'spinbutton', 'switch', 'tab', 'treeitem',
]);

// ---------------------------------------------------------------------------
// AX Tree builder
// ---------------------------------------------------------------------------

function buildAXTree(nodes) {
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  if (nodes.length === 0) return [];

  const walk = (node) => {
    const role = node.role?.value;
    if (!role || role === 'none' || role === 'generic') {
      if (node.childIds) {
        const children = node.childIds.map(id => walk(byId.get(id))).filter(Boolean);
        if (children.length === 1) return children[0];
        if (children.length > 0) return children;
      }
      return null;
    }
    const item = { role };
    if (node.name?.value) item.name = node.name.value;
    if (node.value?.value) item.value = node.value.value;
    if (node.description?.value) item.description = node.description.value;
    if (INTERACTIVE_ROLES.has(role) && node.backendDOMNodeId != null) {
      item.ref = '@' + storeRef(node.backendDOMNodeId, role, node.name?.value || '');
    }
    if (node.childIds) {
      const children = node.childIds.map(id => walk(byId.get(id))).filter(Boolean);
      if (children.length > 0) item.children = children;
    }
    return item;
  };

  const roots = nodes.filter(n => !n.parentId);
  if (roots.length > 0 && roots[0].childIds) {
    return roots[0].childIds.map(id => walk(byId.get(id))).filter(Boolean);
  }
  return nodes[0]?.childIds
    ? nodes[0].childIds.map(id => walk(byId.get(id))).filter(Boolean)
    : [];
}

// ---------------------------------------------------------------------------
// Keyboard / modifier resolution (ported from extension)
// ---------------------------------------------------------------------------

const MOD_MAP = {
  alt:    { bit: 1,  key: 'Alt',      code: 'AltLeft',      vkc: 18 },
  ctrl:   { bit: 2,  key: 'Control',  code: 'ControlLeft',  vkc: 17 },
  control:{ bit: 2,  key: 'Control',  code: 'ControlLeft',  vkc: 17 },
  cmd:    { bit: 4,  key: 'Meta',     code: 'MetaLeft',     vkc: 91 },
  meta:   { bit: 4,  key: 'Meta',     code: 'MetaLeft',     vkc: 91 },
  shift:  { bit: 8,  key: 'Shift',    code: 'ShiftLeft',    vkc: 16 },
};

const KEY_MAP = {
  enter:     { key: 'Enter',     code: 'Enter',     vkc: 13, text: '\r' },
  return:    { key: 'Enter',     code: 'Enter',     vkc: 13, text: '\r' },
  escape:    { key: 'Escape',    code: 'Escape',    vkc: 27 },
  esc:       { key: 'Escape',    code: 'Escape',    vkc: 27 },
  tab:       { key: 'Tab',       code: 'Tab',       vkc: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vkc: 8 },
  delete:    { key: 'Delete',    code: 'Delete',    vkc: 46 },
  space:     { key: ' ',         code: 'Space',     vkc: 32, text: ' ' },
  arrowup:   { key: 'ArrowUp',   code: 'ArrowUp',   vkc: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vkc: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vkc: 37 },
  arrowright:{ key: 'ArrowRight',code: 'ArrowRight',vkc: 39 },
  home:      { key: 'Home',      code: 'Home',      vkc: 36 },
  end:       { key: 'End',       code: 'End',       vkc: 35 },
  pageup:    { key: 'PageUp',    code: 'PageUp',    vkc: 33 },
  pagedown:  { key: 'PageDown',  code: 'PageDown',  vkc: 34 },
};

const PAPER_SIZES = {
  letter: [8.5, 11], legal: [8.5, 14], a4: [8.27, 11.69],
  a3: [11.69, 16.54], tabloid: [11, 17],
};

function parseKey(keystr, os) {
  const t = keystr.toLowerCase();
  if (KEY_MAP[t]) return KEY_MAP[t];
  const fm = t.match(/^f(\d{1,2})$/);
  if (fm) { const n = parseInt(fm[1]); if (n >= 1 && n <= 12) return { key: `F${n}`, code: `F${n}`, vkc: 111 + n }; }
  if (keystr.length === 1) {
    if (/^[a-zA-Z]$/.test(keystr)) {
      const l = keystr.toLowerCase();
      return { key: l, code: `Key${keystr.toUpperCase()}`, vkc: keystr.toUpperCase().charCodeAt(0), text: l };
    }
    if (/^[0-9]$/.test(keystr)) return { key: keystr, code: `Digit${keystr}`, vkc: keystr.charCodeAt(0), text: keystr };
  }
  throw new Error(`Unknown key: "${keystr}". Use Enter, Tab, Escape, Space, F1-F12, letters, digits, or arrow keys.`);
}

function parseKeys(keys, os) {
  const modKey = os === 'mac' ? MOD_MAP.cmd : MOD_MAP.ctrl;
  return keys.trim().split(/\s+/).map(seg => {
    const parts = seg.split('+').map(s => s.trim()).filter(Boolean);
    if (parts.length === 0) throw new Error('Empty key segment');
    let modBits = 0, modKeys = [];
    for (let i = 0; i < parts.length - 1; i++) {
      const name = parts[i].toLowerCase();
      const mod = name === 'mod' ? modKey : MOD_MAP[name];
      if (!mod) throw new Error(`Unknown modifier: "${parts[i]}"`);
      modBits |= mod.bit; modKeys.push(mod);
    }
    const spec = parseKey(parts[parts.length - 1], os);
    if (!(modBits & 8) || spec.key.length !== 1 || !/[a-z]/.test(spec.key)) {
      return { modBits, modKeys, spec };
    }
    return { modBits, modKeys, spec: { ...spec, key: spec.key.toUpperCase(), text: spec.key.toUpperCase() } };
  });
}

// ---------------------------------------------------------------------------
// Resolve selector (CSS or @e ref) to an objectId for CDP operations
// ---------------------------------------------------------------------------

async function resolveObjectId(client, selector) {
  if (isRef(selector)) {
    const ref = getRef(selector);
    if (!ref) throw new Error(`Unknown ref: ${selector}`);
    const { object } = await client.DOM.resolveNode({ backendNodeId: ref.backendNodeId });
    if (!object?.objectId) throw new Error('Could not resolve ref');
    return object.objectId;
  }
  const esc = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const r = await client.Runtime.evaluate({
    expression: `document.querySelector('${esc}')`, returnByValue: false,
  });
  if (r.result.subtype === 'null' || !r.result.objectId) {
    throw new Error(`Element not found: ${selector}`);
  }
  return r.result.objectId;
}

// ---------------------------------------------------------------------------
// fill logic — shared function for <input>/<textarea>/[contenteditable]
// ---------------------------------------------------------------------------

function fillExpression(elRef, valueJson) {
  return `
    (function(){
      const t = ${elRef};
      if (!t) return JSON.stringify({error:"Element not found"});
      t.focus();
      if (t.isContentEditable) {
        const sel = window.getSelection();
        if (sel) { const r = document.createRange(); r.selectNodeContents(t); sel.removeAllRanges(); sel.addRange(r); }
        let inserted = false;
        try { inserted = document.execCommand('insertText', false, ${valueJson}); } catch(_) {}
        if (!inserted) {
          t.textContent = ${valueJson};
          t.dispatchEvent(new InputEvent('input', {inputType:'insertText',data:${valueJson},bubbles:true}));
        }
        return JSON.stringify({filled:true, mode:'contenteditable'});
      }
      const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set;
      if (ns) { ns.call(t, ${valueJson}); }
      else { t.value = ${valueJson}; }
      t.dispatchEvent(new Event('input', {bubbles:true}));
      t.dispatchEvent(new Event('change', {bubbles:true}));
      return JSON.stringify({filled:true, mode:'value'});
    })()
  `.trim();
}

// ===========================================================================
// DIRECT CDP ENGINE — no extension required
// ===========================================================================

async function executeDirectCdp(action, params, cdpPort) {
  const cdp = loadCDP();
  const host = 'localhost';

  // --- Standalone actions (no target needed) ---

  if (action === 'status') {
    let version = 'unknown';
    try { version = (await cdp.Version({ host, port: cdpPort })).Browser || 'unknown'; } catch {}
    cdpVersion = version;
    let targets = [];
    try { targets = await cdp.List({ host, port: cdpPort }); } catch {}
    const pages = targets.filter(t => t.type === 'page');
    const uptime = Math.floor((Date.now() - serverStartTime) / 1000);
    return {
      connected: true, debugPort: cdpPort, version,
      uptime_seconds: uptime,
      tabCount: pages.length, sessionCount: sessions.size,
      sessions: [...sessions.keys()],
    };
  }

  if (action === 'get_tabs') {
    const targets = await cdp.List({ host, port: cdpPort });
    const pages = targets.filter(t => t.type === 'page');
    return pages.map(p => {
      const tabSessions = [];
      for (const [name, tabIds] of sessions) {
        if (tabIds.has(p.id)) tabSessions.push(name);
      }
      return { id: p.id, url: p.url || '', title: p.title || '', active: p.id === pages[0]?.id, sessions: tabSessions };
    });
  }

  if (action === 'new_tab') {
    const client = await cdp({ host, port: cdpPort });
    const result = await client.Target.createTarget({ url: params.url || 'about:blank' });
    await client.close();
    registerTab(params.session, result.targetId);
    return { created: true, tabId: result.targetId };
  }

  if (action === 'find_tab') {
    if (!params.url && !params.active) throw new Error('url or active:true required');
    const targets = await cdp.List({ host, port: cdpPort });
    const pages = targets.filter(t => t.type === 'page');

    let f;
    if (params.active) {
      // Find the currently focused/active tab
      f = pages.find(p => p.title && p.url && !p.url.startsWith('chrome://') && !p.url.startsWith('devtools://')) || pages[0];
      if (!f) throw new Error('No active tab found');
    } else {
      let hn;
      try { hn = new URL(params.url).hostname; } catch { hn = params.url; }
      f = pages.find(p => {
        try { return new URL(p.url || '').hostname === hn; } catch { return false; }
      });
      if (!f) throw new Error(`No tab matching: ${params.url}`);
    }
    const tc = await cdp({ host, port: cdpPort, target: f.id });
    try { await tc.Target.activateTarget({ targetId: f.id }); } catch {}
    await tc.close();
    return { id: f.id, url: f.url || '', title: f.title || '' };
  }

  // --- Actions that need a target client ---

  const targets = await cdp.List({ host, port: cdpPort });
  const pages = targets.filter(t => t.type === 'page');

  // Actions that create new tabs don't need an existing tab
  const createsNewTab = action === 'new_tab' || (action === 'navigate' && params.new_tab);
  const needsNoTab = action === 'close_session';
  const tabId = (createsNewTab || needsNoTab) ? null : getActiveTabId(params, pages);

  if (!tabId && !createsNewTab && !needsNoTab) {
    if (action === 'close_tab') throw new Error('No tabs to close');
    if (action === 'switch_tab') throw new Error('No tabs to switch');
    throw new Error('No open tabs. Use navigate with newTab:true and session:"name" first.');
  }

  if (action === 'close_session') {
    const sessionName = params.session || lastActiveSession;
    if (!sessionName) throw new Error('session required — none active. Specify a session name or use navigate with session:"name" first.');
    const sessionTabs = sessions.get(sessionName);
    if (!sessionTabs || sessionTabs.size === 0) { sessions.delete(sessionName); return { closed: 0 }; }
    let closed = 0;
    for (const tid of [...sessionTabs]) {
      try {
        const cc = await cdp({ host, port: cdpPort, target: tid });
        await cc.Target.closeTarget({ targetId: tid });
        await cc.close();
        closed++;
      } catch { /* tab may already be gone */ }
    }
    sessions.delete(sessionName);
    if (lastActiveSession === sessionName) lastActiveSession = null;
    return { closed };
  }

  if (action === 'close_tab') {
    if (!params.tab_id) throw new Error('tab_id required');
    const cc = await cdp({ host, port: cdpPort, target: params.tab_id });
    await cc.Target.closeTarget({ targetId: params.tab_id });
    await cc.close();
    for (const [name, tabs] of sessions) { tabs.delete(params.tab_id); if (tabs.size === 0) sessions.delete(name); }
    return { closed: true };
  }

  if (action === 'switch_tab') {
    if (!params.tab_id) throw new Error('tab_id required');
    const sc = await cdp({ host, port: cdpPort, target: params.tab_id });
    try { await sc.Target.activateTarget({ targetId: params.tab_id }); } catch {}
    await sc.close();
    return { switched: true };
  }

  // Navigate with newTab doesn't need a target client — just creates a fresh tab
  if (action === 'navigate' && params.new_tab) {
    const c = await cdp({ host, port: cdpPort });
    const result = await c.Target.createTarget({ url: params.url });
    await c.close();
    registerTab(params.session, result.targetId);
    return { url: params.url, newTab: true, tabId: result.targetId };
  }

  if (!tabId) {
    throw new Error('No open tabs. Use navigate with newTab:true and session:"name" first.');
  }

  const client = await cdp({ host, port: cdpPort, target: tabId });
  await client.Page.enable();
  await client.Runtime.enable();

  try {
    switch (action) {

      // ===================================================================
      // NAVIGATE
      // ===================================================================
      case 'navigate': {
        if (!params.url) throw new Error('url required');
        await client.Page.navigate({ url: params.url });
        await new Promise(r => setTimeout(r, 1500));
        const t = await client.Runtime.evaluate({
          expression: 'document.title', returnByValue: true,
        });
        return { url: params.url, title: t.result?.value || '' };
      }

      // ===================================================================
      // SNAPSHOT — Accessibility tree with @e refs
      // ===================================================================
      case 'snapshot': {
        resetRefs();
        await client.Accessibility.enable();
        const { nodes } = await client.Accessibility.getFullAXTree({});
        const tree = buildAXTree(nodes);
        const titleEval = await client.Runtime.evaluate({
          expression: 'document.title', returnByValue: true,
        });
        return { url: (pages.find(p => p.id === tabId) || {}).url || '', title: titleEval.result?.value || '', tree };
      }

      // ===================================================================
      // SCREENSHOT — write to file, return path
      // ===================================================================
      case 'screenshot': {
        const format = params.format || 'png';
        const quality = params.quality;
        const opts = { format };
        if (quality && format === 'jpeg') opts.quality = quality;

        // Element clip
        if (params.selector) {
          const objId = await resolveObjectId(client, params.selector);
          await client.Runtime.callFunctionOn({
            objectId: objId,
            functionDeclaration: 'function(){this.scrollIntoView({block:"center",inline:"center"})}',
          });
          await client.DOM.enable();
          const box = await client.DOM.getBoxModel({ objectId: objId });
          const q = box.model?.border || box.model?.content;
          if (!q || q.length < 8) throw new Error('Element has no layout box');
          const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
          opts.clip = {
            x: Math.min(...xs), y: Math.min(...ys),
            width: Math.max(...xs) - Math.min(...xs),
            height: Math.max(...ys) - Math.min(...ys),
            scale: 1,
          };
        }

        if (params.full_page) opts.captureBeyondViewport = true;
        const result = await client.Page.captureScreenshot(opts);

        const filePath = params.path || (() => {
          const outDir = join(homedir(), '.coderix', 'screenshots');
          mkdirSync(outDir, { recursive: true });
          const ext = format === 'jpeg' ? 'jpg' : 'png';
          return join(outDir, `screenshot-${Date.now()}.${ext}`);
        })();
        if (params.path) mkdirSync(dirname(params.path), { recursive: true });
        writeFileSync(filePath, Buffer.from(result.data, 'base64'));
        return { path: filePath, format, sizeBytes: Buffer.byteLength(result.data, 'base64'), mimeType: `image/${format}` };
      }

      // ===================================================================
      // CLICK — CSS selector, @e ref, or x/y coordinates
      // ===================================================================
      case 'click': {
        if (params.selector) {
          if (isRef(params.selector)) {
            const ref = getRef(params.selector);
            if (!ref) throw new Error(`Unknown ref: ${params.selector}`);
            await client.DOM.enable();
            const { object } = await client.DOM.resolveNode({ backendNodeId: ref.backendNodeId });
            if (!object?.objectId) throw new Error('Could not resolve element ref');
            const r = await client.Runtime.callFunctionOn({
              objectId: object.objectId,
              functionDeclaration: 'function(){this.scrollIntoView({block:"center"});this.click();return{tag:this.tagName,text:(this.textContent||"").slice(0,100)}}',
              returnByValue: true,
            });
            return r.result?.value || { clicked: true };
          }
          // CSS selector
          const esc = params.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          const r = await client.Runtime.evaluate({
            expression: `(function(){var e=document.querySelector('${esc}');if(!e)return JSON.stringify({error:"Not found"});e.scrollIntoView({behavior:"instant",block:"center"});e.click();return JSON.stringify({clicked:true,tag:e.tagName,text:(e.textContent||"").slice(0,80)});})()`,
            returnByValue: true,
          });
          const v = r.result?.value;
          if (v) { const p = JSON.parse(v); if (p.error) throw new Error(p.error); return p; }
          return { clicked: true };
        }
        // Coordinates
        const cx = params.x || 0, cy = params.y || 0;
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
        return { clicked: true, x: cx, y: cy };
      }

      // ===================================================================
      // MOUSE_CLICK — real mouse events at element center via getBoxModel
      // ===================================================================
      case 'mouse_click': {
        if (!params.selector) throw new Error('selector required');
        await client.DOM.enable();
        const objId = await resolveObjectId(client, params.selector);
        await client.Runtime.callFunctionOn({
          objectId: objId,
          functionDeclaration: 'function(){this.scrollIntoView({block:"center",inline:"center"})}',
        });
        const box = await client.DOM.getBoxModel({ objectId: objId });
        const q = box.model?.content;
        if (!q || q.length < 8) throw new Error('Element has no layout box');
        const mx = (q[0] + q[2] + q[4] + q[6]) / 4;
        const my = (q[1] + q[3] + q[5] + q[7]) / 4;
        await client.Input.dispatchMouseEvent({ type: 'mouseMoved', x: mx, y: my, button: 'none', buttons: 0 });
        await client.Input.dispatchMouseEvent({ type: 'mousePressed', x: mx, y: my, button: 'left', buttons: 1, clickCount: 1 });
        await client.Input.dispatchMouseEvent({ type: 'mouseReleased', x: mx, y: my, button: 'left', buttons: 0, clickCount: 1 });
        return { clicked: true, x: Math.round(mx), y: Math.round(my) };
      }

      // ===================================================================
      // FILL — <input>/<textarea>/[contenteditable] with clear-and-insert
      // ===================================================================
      case 'fill': {
        if (params.value == null) throw new Error('value required');
        if (!params.selector) throw new Error('selector required');
        const valueJson = JSON.stringify(params.value);

        if (isRef(params.selector)) {
          const ref = getRef(params.selector);
          if (!ref) throw new Error(`Unknown ref: ${params.selector}`);
          await client.DOM.enable();
          const { object } = await client.DOM.resolveNode({ backendNodeId: ref.backendNodeId });
          if (!object?.objectId) throw new Error('Could not resolve element ref');
          const r = await client.Runtime.callFunctionOn({
            objectId: object.objectId,
            functionDeclaration: fillExpression('this', valueJson),
            returnByValue: true,
          });
          const v = r.result?.value;
          if (v) { const p = JSON.parse(v); if (p.error) throw new Error(p.error); return p; }
          return { filled: true };
        }

        const esc = params.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        const r = await client.Runtime.evaluate({
          expression: fillExpression(`document.querySelector('${esc}')`, valueJson),
          returnByValue: true,
        });
        const v = r.result?.value;
        if (v) { const p = JSON.parse(v); if (p.error) throw new Error(p.error); return p; }
        return { filled: true };
      }

      // ===================================================================
      // TYPE — Input.insertText (simpler than fill, no clear)
      // ===================================================================
      case 'type': {
        if (!params.text) throw new Error('text required');
        if (params.selector) {
          const esc = params.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
          await client.Runtime.evaluate({
            expression: `(function(){var e=document.querySelector('${esc}');if(e){e.focus();}})()`,
            returnByValue: true,
          });
        }
        await client.Input.insertText({ text: params.text });
        return { typed: true, length: params.text.length };
      }

      // ===================================================================
      // SEND_KEYS — full keyboard dispatch with modifiers
      // ===================================================================
      case 'send_keys': {
        if (!params.keys) throw new Error('keys required (e.g. "Enter" or "Mod+A" or "Shift+Tab")');
        const os = process.platform === 'darwin' ? 'mac' : 'other';
        const repeat = params.repeat || 1;
        if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('repeat must be 1-100');
        const segments = parseKeys(params.keys, os);
        let dispatched = 0;
        for (let rp = 0; rp < repeat; rp++) {
          for (const { modBits, modKeys, spec } of segments) {
            let currentMods = 0;
            for (const m of modKeys) {
              currentMods |= m.bit;
              await client.Input.dispatchKeyEvent({
                type: 'keyDown', modifiers: currentMods,
                key: m.key, code: m.code, windowsVirtualKeyCode: m.vkc,
              });
            }
            const textParam = (modBits & 8) === 0 && spec.text ? { text: spec.text } : {};
            await client.Input.dispatchKeyEvent({
              type: 'keyDown', modifiers: modBits,
              key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vkc,
              ...textParam,
            });
            await client.Input.dispatchKeyEvent({
              type: 'keyUp', modifiers: modBits,
              key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vkc,
            });
            for (let i = modKeys.length - 1; i >= 0; i--) {
              currentMods &= ~modKeys[i].bit;
              await client.Input.dispatchKeyEvent({
                type: 'keyUp', modifiers: currentMods,
                key: modKeys[i].key, code: modKeys[i].code, windowsVirtualKeyCode: modKeys[i].vkc,
              });
            }
            dispatched++;
          }
        }
        return { dispatched, os };
      }

      // ===================================================================
      // SCROLL
      // ===================================================================
      case 'scroll': {
        const amount = params.amount ?? 500;
        await client.Runtime.evaluate({
          expression: `window.scrollBy({top:${amount},behavior:'instant'})`,
          returnByValue: true,
        });
        return { scrolled: amount };
      }

      // ===================================================================
      // EXTRACT — get text content
      // ===================================================================
      case 'extract': {
        const expr = params.selector
          ? `(function(){var e=document.querySelector('${params.selector.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}');return e?(e.textContent||e.innerText||''):'';})()`
          : 'document.body?document.body.innerText:""';
        const r = await client.Runtime.evaluate({ expression: expr, returnByValue: true });
        const content = r.result?.value || '';
        return { content, length: content.length };
      }

      // ===================================================================
      // EVALUATE — run arbitrary JS, supports async/await
      // ===================================================================
      case 'evaluate': {
        if (!params.script) throw new Error('script required');
        const r = await client.Runtime.evaluate({
          expression: params.script, returnByValue: true, awaitPromise: true,
        });
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
        }
        return { type: r.result.type, value: r.result.value };
      }

      // ===================================================================
      // UPLOAD — set files on a file input
      // ===================================================================
      case 'upload': {
        if (!params.selector) throw new Error('selector required');
        if (!params.files || !Array.isArray(params.files) || params.files.length === 0) {
          throw new Error('files array required');
        }
        await client.DOM.enable();
        const { root } = await client.DOM.getDocument();
        const { nodeId } = await client.DOM.querySelector({
          nodeId: root.nodeId, selector: params.selector,
        });
        if (!nodeId) throw new Error(`Element not found: ${params.selector}`);
        await client.DOM.setFileInputFiles({ files: params.files, nodeId });
        return { uploaded: true, fileCount: params.files.length };
      }

      // ===================================================================
      // SAVE_AS_PDF
      // ===================================================================
      case 'save_as_pdf': {
        const [w, h] = PAPER_SIZES[(params.paper_format || 'a4').toLowerCase()] || PAPER_SIZES.a4;
        const scale = typeof params.scale === 'number' ? params.scale : 1;
        if (scale < 0.1 || scale > 2) throw new Error('scale must be 0.1-2.0');
        await client.Page.enable();
        const r = await client.Page.printToPDF({
          printBackground: params.print_background !== false,
          landscape: !!params.landscape,
          scale,
          paperWidth: w,
          paperHeight: h,
          preferCSSPageSize: true,
        });
        let title = '';
        try {
          title = (await client.Runtime.evaluate({
            expression: 'document.title', returnByValue: true,
          })).result?.value || '';
        } catch {}
        const filePath = params.path || (() => {
          const outDir = join(homedir(), '.coderix', 'pdfs');
          mkdirSync(outDir, { recursive: true });
          const safeName = (title || 'page').replace(/[^a-zA-Z0-9一-鿿_-]/g, '_').slice(0, 64);
          return join(outDir, `${safeName}-${Date.now()}.pdf`);
        })();
        if (params.path) mkdirSync(dirname(params.path), { recursive: true });
        writeFileSync(filePath, Buffer.from(r.data, 'base64'));
        return { path: filePath, mimeType: 'application/pdf', sizeBytes: Buffer.byteLength(r.data, 'base64'), pageTitle: title };
      }

      // ===================================================================
      // NETWORK — capture/query HTTP requests
      // ===================================================================
      case 'network': {
        if (!params.cmd) throw new Error('cmd required (start/stop/list/detail)');
        await client.Network.enable();

        if (params.cmd === 'start') {
          const store = new Map();
          client._networkStore = store;

          client.on('Network.requestWillBeSent', p => {
            store.set(p.requestId, {
              requestId: p.requestId, url: p.request.url,
              method: p.request.method, timestamp: p.timestamp,
            });
          });
          client.on('Network.responseReceived', p => {
            const req = store.get(p.requestId);
            if (req) { req.status = p.response.status; req.mimeType = p.response.mimeType; }
          });
          client.on('Network.loadingFinished', p => {
            const req = store.get(p.requestId);
            if (req) req.completed = true;
          });
          return { started: true };
        }

        if (params.cmd === 'stop') {
          try { await client.Network.disable(); } catch {}
          return { stopped: true };
        }

        const store = client._networkStore || new Map();

        if (params.cmd === 'list') {
          let requests = [...store.values()];
          if (params.filter) requests = requests.filter(r => r.url.includes(params.filter));
          return { count: requests.length, requests };
        }

        if (params.cmd === 'detail') {
          if (!params.requestId) throw new Error('requestId required');
          const req = store.get(params.requestId);
          if (!req) throw new Error(`Request ${params.requestId} not found`);
          const body = await client.Network.getResponseBody({ requestId: params.requestId });
          return { ...req, body: body.body, base64Encoded: body.base64Encoded };
        }

        throw new Error(`Unknown network cmd: ${params.cmd}`);
      }

      // ===================================================================
      // CDP — raw CDP method passthrough
      // ===================================================================
      case 'cdp': {
        if (!params.method) throw new Error('method required');
        const domain = params.method.split('.')[0];
        return await client[domain](params.params || {});
      }

      default:
        throw new Error(`Unknown action: ${action}. Available: navigate, snapshot, screenshot, click, mouse_click, fill, type, send_keys, scroll, extract, evaluate, upload, save_as_pdf, network, cdp, get_tabs, new_tab, close_tab, close_session, switch_tab, find_tab, status`);
    }
  } finally {
    await client.close().catch(() => {});
  }
}

// ===========================================================================
// BROWSER AUTO-LAUNCH
// ===========================================================================

function findBrowserPath() {
  if (process.platform !== 'win32') {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser',
      'microsoft-edge', 'microsoft-edge-stable']) {
      try {
        const p = require('child_process').execSync(`command -v ${name} 2>/dev/null`, { encoding: 'utf-8' }).trim();
        if (p && existsSync(p)) return p;
      } catch {}
    }
    for (const p of ['/opt/google/chrome/chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
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

async function isCdpAvailable(port) {
  try {
    await fetch(`http://localhost:${port}/json`, { signal: AbortSignal.timeout(1000) });
    return true;
  } catch { return false; }
}

async function launchBrowser(port) {
  const browserPath = BROWSER_PATH || findBrowserPath();
  if (!browserPath) {
    console.log('[bridge] No Chrome/Edge found. Set --browser-path or install Chrome.');
    return false;
  }
  const userDataDir = join(process.env.TEMP || '/tmp', `cdp-profile-${Date.now()}`);
  const spawnArgs = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run', '--no-default-browser-check',
    'about:blank',
  ];
  if (HEADLESS) spawnArgs.push('--headless=new');

  const proc = spawn(browserPath, spawnArgs, { detached: true, stdio: 'ignore' });
  proc.unref();

  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (await isCdpAvailable(port)) {
      console.log(`[bridge] Browser launched on port ${port} (PID ${proc.pid})`);
      return true;
    }
  }
  console.log('[bridge] WARNING: Browser started but CDP not available within 15s. Continuing anyway.');
  return false;
}

// ===========================================================================
// HTTP SERVER
// ===========================================================================

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      version: cdpVersion,
      uptime_seconds: Math.floor((Date.now() - serverStartTime) / 1000),
      extensionConnected: !!(extWs && extWs.readyState === 1),
      mode: (extWs && extWs.readyState === 1) ? 'extension' : 'cdp',
      port: PORT,
      cdpPort: CDP_PORT,
    }));
    return;
  }

  if (req.method === 'POST' && req.url === '/cmd') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      let msg;
      try { msg = JSON.parse(body); } catch {
        res.writeHead(400); res.end(JSON.stringify({ error: 'Invalid JSON' })); return;
      }

      // Extension path — relay via WebSocket
      if (extWs && extWs.readyState === 1) {
        const id = ++requestId;
        const promise = new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            pendingRequests.delete(id);
            reject(new Error('Extension timeout'));
          }, 30000);
          pendingRequests.set(id, { resolve, reject, timer });
        });
        const relayParams = { ...(msg.params || {}), session: msg.session };
        extWs.send(JSON.stringify({ id, action: msg.action, params: relayParams }));
        try {
          const result = await promise;
          res.writeHead(200); res.end(JSON.stringify({ result }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      // CDP direct path
      try {
        const params = { ...(msg.params || {}), session: msg.session };
        const result = await executeDirectCdp(msg.action, params, msg.params?.cdpPort || CDP_PORT);
        res.writeHead(200); res.end(JSON.stringify({ result }));
      } catch (e) {
        res.writeHead(500); res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404); res.end('Not found');
});

// ===========================================================================
// WEBSOCKET SERVER (for extension relay)
// ===========================================================================

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
          ws.send(JSON.stringify({ type: 'hello_ack' }));
        }
      } catch {}
    });
    ws.on('close', () => { console.log('[bridge] Extension disconnected'); extWs = null; });
  } else {
    console.log('[bridge] CLI WebSocket connected');
    ws.on('message', data => handleCliMessage(ws, data.toString()));
  }
});

async function handleCliMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch {
    ws.send(JSON.stringify({ type: 'error', error: 'Invalid JSON' })); return;
  }
  if (extWs && extWs.readyState === 1) {
    const id = ++requestId;
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        reject(new Error('Timeout'));
      }, 30000);
      pendingRequests.set(id, { resolve, reject, timer });
    });
    const relayParams = { ...(msg.params || {}), session: msg.session };
    extWs.send(JSON.stringify({ id, action: msg.action, params: relayParams }));
    try {
      const result = await promise;
      ws.send(JSON.stringify({ type: 'result', action: msg.action, result }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', action: msg.action, error: e.message }));
    }
    return;
  }
  try {
    const params = { ...(msg.params || {}), session: msg.session };
    const result = await executeDirectCdp(msg.action, params, params?.cdpPort || CDP_PORT);
    ws.send(JSON.stringify({ type: 'result', action: msg.action, result }));
  } catch (e) {
    ws.send(JSON.stringify({ type: 'error', action: msg.action, error: e.message }));
  }
}

// ===========================================================================
// STARTUP
// ===========================================================================

server.listen(PORT, '127.0.0.1', async () => {
  console.log(`BRIDGE_READY port=${PORT} cdp_port=${CDP_PORT}`);

  if (!NO_AUTO_LAUNCH) {
    const available = await isCdpAvailable(CDP_PORT);
    if (!available) {
      console.log(`[bridge] No browser on port ${CDP_PORT}, attempting auto-launch...`);
      await launchBrowser(CDP_PORT);
    }
  }
});

if (process.platform !== 'win32') {
  process.on('SIGINT', () => process.exit(0));
}
