/**
 * Coder Web Bridge — Chrome Extension Background Service Worker
 *
 * Connects to the local bridge server via WebSocket and relays CDP commands
 * using chrome.debugger API. All data stays local.
 *
 * Tool parity with kimi-webbridge, plus CLI-compatible response format.
 */

const BRIDGE_HOST = '127.0.0.1';
const BRIDGE_PORT = 9223;
const RECONNECT_MS = 2000;

let ws = null;
let reconnectTimer = null;
let attachedTabs = new Set();
let activeTabId = null;

// ---------------------------------------------------------------------------
// WebSocket connection
// ---------------------------------------------------------------------------

function connect() {
  if (ws && ws.readyState === WebSocket.OPEN) return;
  if (reconnectTimer) clearTimeout(reconnectTimer);

  try { ws = new WebSocket(`ws://${BRIDGE_HOST}:${BRIDGE_PORT}`); }
  catch (e) { console.error('[web-bridge] connect error:', e.message); scheduleReconnect(); return; }

  ws.onopen = () => {
    console.log('[web-bridge] connected to bridge');
    send({ type: 'hello', version: '1.0' });
    sendTabList();
  };

  ws.onmessage = async (event) => {
    try { await handleMessage(JSON.parse(event.data)); }
    catch (e) { send({ type: 'error', id: null, error: e.message }); }
  };

  ws.onclose = () => { ws = null; scheduleReconnect(); };
  ws.onerror = () => {};
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) { clearInterval(reconnectTimer); reconnectTimer = null; return; }
    connect();
  }, RECONNECT_MS);
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ---------------------------------------------------------------------------
// Tab helpers
// ---------------------------------------------------------------------------

async function getActiveTab() {
  if (activeTabId) {
    try { const t = await chrome.tabs.get(activeTabId); if (t) return t; } catch {}
  }
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.id) { activeTabId = tab.id; return tab; }
  throw new Error('No active tab found');
}

async function sendTabList() {
  const tabs = await chrome.tabs.query({});
  send({ type: 'tab_list', tabs: tabs.map(t => ({
    id: String(t.id), url: t.url || '', title: t.title || '',
    active: t.active, groupId: t.groupId
  })) });
}

// ---------------------------------------------------------------------------
// Debugger attach / CDP send
// ---------------------------------------------------------------------------

async function attachDebugger(tabId) {
  if (attachedTabs.has(tabId)) return;
  return new Promise((resolve, reject) => {
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else { attachedTabs.add(tabId); resolve(); }
    });
  });
}

async function sendCdp(tabId, method, params) {
  await attachDebugger(tabId);
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (result) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(result);
    });
  });
}

// ---------------------------------------------------------------------------
// Accessibility ref system (for @e snapshot refs)
// ---------------------------------------------------------------------------

let elemRefs = new Map(), refCounter = 1;
function resetRefs() { elemRefs.clear(); refCounter = 1; }
function storeRef(backendNodeId, role, name) {
  const ref = `e${refCounter++}`;
  elemRefs.set(ref, { backendNodeId, role, name });
  return ref;
}
function getRef(ref) { return elemRefs.get(ref.replace(/^@/, '')); }
function isRef(s) { return /^@?e\d+$/.test(s); }

const INTERACTIVE_ROLES = new Set([
  'button','link','textbox','checkbox','radio','combobox','listbox',
  'menuitem','menuitemcheckbox','menuitemradio','option','searchbox',
  'slider','spinbutton','switch','tab','treeitem'
]);

// ---------------------------------------------------------------------------
// Mod key resolution
// ---------------------------------------------------------------------------

let platformOS = null;
async function getOS() {
  if (!platformOS) { const info = await chrome.runtime.getPlatformInfo(); platformOS = info.os; }
  return platformOS;
}
const MOD_MAP = {
  alt:   { bit: 1, key: 'Alt', code: 'AltLeft', vkc: 18 },
  ctrl:  { bit: 2, key: 'Control', code: 'ControlLeft', vkc: 17 },
  control: { bit: 2, key: 'Control', code: 'ControlLeft', vkc: 17 },
  cmd:   { bit: 4, key: 'Meta', code: 'MetaLeft', vkc: 91 },
  meta:  { bit: 4, key: 'Meta', code: 'MetaLeft', vkc: 91 },
  shift: { bit: 8, key: 'Shift', code: 'ShiftLeft', vkc: 16 },
};
const KEY_MAP = {
  enter: { key: 'Enter', code: 'Enter', vkc: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vkc: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vkc: 27 },
  esc: { key: 'Escape', code: 'Escape', vkc: 27 },
  tab: { key: 'Tab', code: 'Tab', vkc: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vkc: 8 },
  delete: { key: 'Delete', code: 'Delete', vkc: 46 },
  space: { key: ' ', code: 'Space', vkc: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vkc: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vkc: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vkc: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vkc: 39 },
  home: { key: 'Home', code: 'Home', vkc: 36 },
  end: { key: 'End', code: 'End', vkc: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vkc: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vkc: 34 },
};
const PAPER_SIZES = { letter: [8.5, 11], legal: [8.5, 14], a4: [8.27, 11.69], a3: [11.69, 16.54], tabloid: [11, 17] };

function parseKey(keystr, os) {
  const t = keystr.toLowerCase();
  if (KEY_MAP[t]) return KEY_MAP[t];
  const fm = t.match(/^f(\d{1,2})$/);
  if (fm) { const n = parseInt(fm[1]); if (n >= 1 && n <= 12) return { key: `F${n}`, code: `F${n}`, vkc: 111 + n }; }
  if (keystr.length === 1) {
    if (/^[a-zA-Z]$/.test(keystr)) { const l = keystr.toLowerCase(); return { key: l, code: `Key${keystr.toUpperCase()}`, vkc: keystr.toUpperCase().charCodeAt(0), text: l }; }
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
    // Uppercase letter if Shift is pressed
    if (!(modBits & 8) || spec.key.length !== 1 || !/[a-z]/.test(spec.key)) return { modBits, modKeys, spec };
    return { modBits, modKeys, spec: { ...spec, key: spec.key.toUpperCase(), text: spec.key.toUpperCase() } };
  });
}

// ---------------------------------------------------------------------------
// Network capture (lightweight, request/response recording)
// ---------------------------------------------------------------------------

let networkCaptures = new Map(); // tabId -> Map<requestId, req>
let networkActive = new Set();   // tabIds with capture enabled
let networkListenerInstalled = false;

function installNetworkListener() {
  if (networkListenerInstalled) return;
  networkListenerInstalled = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    const tabId = source.tabId;
    if (!tabId || !networkActive.has(tabId)) return;
    let store = networkCaptures.get(tabId);
    if (!store) { store = new Map(); networkCaptures.set(tabId, store); }
    if (method === 'Network.requestWillBeSent') {
      store.set(params.requestId, { requestId: params.requestId, url: params.request.url, method: params.request.method, timestamp: params.timestamp });
    } else if (method === 'Network.responseReceived') {
      const req = store.get(params.requestId);
      if (req) { req.status = params.response.status; req.mimeType = params.response.mimeType; }
    } else if (method === 'Network.loadingFinished') {
      const req = store.get(params.requestId);
      if (req) req.completed = true;
    }
  });
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

async function handleMessage(msg) {
  const { id, action, params } = msg;

  try {
    let result;
    switch (action) {
      // Tab management
      case 'get_tabs': result = await cmdGetTabs(); break;
      case 'new_tab':  result = await cmdNewTab(params); break;
      case 'close_tab': result = await cmdCloseTab(params); break;
      case 'switch_tab': result = await cmdSwitchTab(params); break;
      case 'find_tab': result = await cmdFindTab(params); break;
      // Page operations
      case 'navigate':   result = await cmdNavigate(params); break;
      case 'screenshot': result = await cmdScreenshot(params); break;
      case 'click':      result = await cmdClick(params); break;
      case 'mouse_click': result = await cmdMouseClick(params); break;
      case 'fill':       result = await cmdFill(params); break;
      case 'type':       result = await cmdType(params); break;
      case 'send_keys':  result = await cmdSendKeys(params); break;
      case 'scroll':     result = await cmdScroll(params); break;
      case 'extract':    result = await cmdExtract(params); break;
      case 'evaluate':   result = await cmdEvaluate(params); break;
      case 'snapshot':   result = await cmdSnapshot(params); break;
      // Advanced
      case 'cdp':        result = await cmdCdp(params); break;
      case 'network':    result = await cmdNetwork(params); break;
      case 'upload':     result = await cmdUpload(params); break;
      case 'save_as_pdf': result = await cmdSaveAsPdf(params); break;
      default: throw new Error(`Unknown action: ${action}`);
    }
    send({ type: 'result', id, result });
  } catch (e) {
    send({ type: 'error', id, error: e.message });
  }
}

// ---------------------------------------------------------------------------
// Command implementations
// ---------------------------------------------------------------------------

async function cmdGetTabs() {
  return (await chrome.tabs.query({})).map(t => ({
    id: String(t.id), url: t.url || '', title: t.title || '', active: t.active
  }));
}

async function cmdNewTab(p = {}) {
  const tab = await chrome.tabs.create({ url: p.url || 'about:blank', active: true });
  activeTabId = tab.id;
  return { id: String(tab.id), url: tab.url || '', title: tab.title || '', active: true };
}

async function cmdCloseTab(p = {}) {
  if (!p.tab_id) throw new Error('tab_id required');
  await chrome.tabs.remove(Number(p.tab_id));
  if (activeTabId === Number(p.tab_id)) activeTabId = null;
  return { closed: true };
}

async function cmdSwitchTab(p = {}) {
  if (!p.tab_id) throw new Error('tab_id required');
  await chrome.tabs.update(Number(p.tab_id), { active: true });
  activeTabId = Number(p.tab_id);
  return { switched: true };
}

async function cmdFindTab(p = {}) {
  if (!p.url) throw new Error('url required');
  const pattern = p.url.includes('*') ? p.url : `*://${new URL(p.url).hostname}/*`;
  const tabs = await chrome.tabs.query({ url: pattern });
  if (tabs.length === 0) throw new Error(`No tab matching: ${p.url}`);
  const tab = tabs[0];
  if (p.activate !== false) { await chrome.tabs.update(tab.id, { active: true }); activeTabId = tab.id; }
  return { id: String(tab.id), url: tab.url || '', title: tab.title || '' };
}

// ---------------------------------------------------------------------------
// Page commands (require debugger)
// ---------------------------------------------------------------------------

async function cmdNavigate(p = {}) {
  if (!p.url) throw new Error('url required');
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  if (p.new_tab) return cmdNewTab({ url: p.url });

  await attachDebugger(tabId);
  // Navigate
  await chrome.tabs.update(tabId, { url: p.url });
  await waitForLoad(tabId);
  const tab = await chrome.tabs.get(tabId);
  const t = await sendCdp(tabId, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true });
  return { url: tab.url, title: t.result?.value || '', tabId };
}

async function waitForLoad(tabId) {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 30000);
    const listener = (tid, info) => {
      if (tid === tabId && info.status === 'complete') { clearTimeout(timeout); chrome.tabs.onUpdated.removeListener(listener); resolve(); }
    };
    chrome.tabs.get(tabId, t => {
      if (t && t.status === 'complete' && t.url && t.url !== 'about:blank') { clearTimeout(timeout); resolve(); }
      else chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function cmdScreenshot(p = {}) {
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  const opts = { format: p.format || 'png' };
  if (p.quality) opts.quality = p.quality;
  // Element clip
  if (p.selector) {
    const objId = await resolveObjectId(tabId, p.selector);
    await sendCdp(tabId, 'Runtime.callFunctionOn', {
      objectId: objId, functionDeclaration: 'function(){this.scrollIntoView({block:"center",inline:"center"})}'
    });
    const box = await sendCdp(tabId, 'DOM.getBoxModel', { objectId: objId });
    const q = box.model?.border || box.model?.content;
    if (!q || q.length < 8) throw new Error('Element has no layout box');
    const xs = [q[0], q[2], q[4], q[6]], ys = [q[1], q[3], q[5], q[7]];
    const x = Math.min(...xs), y = Math.min(...ys);
    opts.clip = { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y, scale: 1 };
  }
  if (p.full_page) opts.captureBeyondViewport = true;
  const r = await sendCdp(tabId, 'Page.captureScreenshot', opts);
  return { data: r.data, format: opts.format };
}

async function cmdClick(p = {}) {
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);

  if (p.selector) {
    if (isRef(p.selector)) {
      const ref = getRef(p.selector);
      if (!ref) throw new Error(`Unknown ref: ${p.selector}`);
      const { object } = await sendCdp(tabId, 'DOM.resolveNode', { backendNodeId: ref.backendNodeId });
      if (!object?.objectId) throw new Error('Could not resolve element ref');
      const r = await sendCdp(tabId, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function(){this.scrollIntoView({block:"center"});this.click();return{tag:this.tagName,text:(this.textContent||"").slice(0,100)}}',
        returnByValue: true,
      });
      return r.result?.value || { clicked: true };
    }
    // CSS selector
    const esc = p.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const r = await sendCdp(tabId, 'Runtime.evaluate', {
      expression: `(function(){var e=document.querySelector('${esc}');if(!e)return JSON.stringify({error:"Not found"});e.scrollIntoView({behavior:"instant",block:"center"});e.click();return JSON.stringify({clicked:true,tag:e.tagName,text:(e.textContent||"").slice(0,80)});})()`,
      returnByValue: true,
    });
    const v = r.result?.value;
    if (v) { const p = JSON.parse(v); if (p.error) throw new Error(p.error); return p; }
    return { clicked: true };
  }
  // Coordinates
  const cx = p.x || 0, cy = p.y || 0;
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
  return { clicked: true, x: cx, y: cy };
}

async function cmdMouseClick(p = {}) {
  if (!p.selector) throw new Error('selector required');
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  const objId = await resolveObjectId(tabId, p.selector);
  await sendCdp(tabId, 'Runtime.callFunctionOn', {
    objectId: objId, functionDeclaration: 'function(){this.scrollIntoView({block:"center",inline:"center"})}'
  });
  const box = await sendCdp(tabId, 'DOM.getBoxModel', { objectId: objId });
  const q = box.model?.content;
  if (!q || q.length < 8) throw new Error('Element has no layout box');
  const cx = (q[0] + q[2] + q[4] + q[6]) / 4, cy = (q[1] + q[3] + q[5] + q[7]) / 4;
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy, button: 'none', buttons: 0 });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', buttons: 1, clickCount: 1 });
  await sendCdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', buttons: 0, clickCount: 1 });
  return { clicked: true, x: Math.round(cx), y: Math.round(cy) };
}

async function cmdFill(p = {}) {
  if (!p.selector) throw new Error('selector required');
  if (p.value == null) throw new Error('value required');
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  const value = JSON.stringify(p.value);

  if (isRef(p.selector)) {
    const ref = getRef(p.selector);
    if (!ref) throw new Error(`Unknown ref: ${p.selector}`);
    const { object } = await sendCdp(tabId, 'DOM.resolveNode', { backendNodeId: ref.backendNodeId });
    if (!object?.objectId) throw new Error('Could not resolve element ref');
    return (await sendCdp(tabId, 'Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: `function(){${fillFn('this', value)}}`,
      returnByValue: true,
    })).result?.value || { filled: true };
  }

  const esc = p.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const r = await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `(function(){var e=document.querySelector('${esc}');if(!e)return JSON.stringify({error:"Not found"});${fillFn('e', value)};return JSON.stringify({filled:true});})()`,
    returnByValue: true,
  });
  const v = r.result?.value;
  if (v) { const p = JSON.parse(v); if (p.error) throw new Error(p.error); }
  return v ? JSON.parse(v) : { filled: true };
}

function fillFn(el, value) {
  return `
    const t = ${el};
    t.focus();
    if (t.isContentEditable) {
      const sel = window.getSelection(); if (sel) { const r = document.createRange(); r.selectNodeContents(t); sel.removeAllRanges(); sel.addRange(r); }
      let inserted = false;
      try { inserted = document.execCommand('insertText', false, ${value}); } catch(_) {}
      if (!inserted) { t.textContent = ${value}; t.dispatchEvent(new InputEvent('input', {inputType:'insertText',data:${value},bubbles:true})); }
      return {filled:true, mode:'contenteditable'};
    }
    const ns = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set
      || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value')?.set;
    if (ns) { ns.call(t, ${value}); }
    else { t.value = ${value}; }
    t.dispatchEvent(new Event('input', {bubbles:true}));
    t.dispatchEvent(new Event('change', {bubbles:true}));
    return {filled:true, mode:'value'};
  `.trim();
}

async function cmdType(p = {}) {
  if (!p.text) throw new Error('text required');
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  if (p.selector) {
    const esc = p.selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    await sendCdp(tabId, 'Runtime.evaluate', {
      expression: `(function(){var e=document.querySelector('${esc}');if(e){e.focus();if(e.tagName==='INPUT'||e.tagName==='TEXTAREA')e.value='';}})()`,
      returnByValue: true,
    });
  }
  await sendCdp(tabId, 'Input.insertText', { text: p.text });
  return { typed: true, length: p.text.length };
}

async function cmdSendKeys(p = {}) {
  if (!p.keys) throw new Error('keys required (e.g. "Enter" or "Mod+A" or "Shift+Tab")');
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  const os = await getOS();
  const repeat = p.repeat || 1;
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('repeat must be 1-100');
  const segments = parseKeys(p.keys, os);
  await attachDebugger(tabId);
  let dispatched = 0;
  for (let r = 0; r < repeat; r++) {
    for (const { modBits, modKeys, spec } of segments) {
      // KeyDown modifiers
      let currentMods = 0;
      for (const m of modKeys) {
        currentMods |= m.bit;
        await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: currentMods, key: m.key, code: m.code, windowsVirtualKeyCode: m.vkc });
      }
      // KeyDown + KeyUp for main key
      const textParam = (modBits & 8) === 0 && spec.text ? { text: spec.text } : {};
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', modifiers: modBits, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vkc, ...textParam });
      await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: modBits, key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vkc });
      // KeyUp modifiers (reverse order)
      for (let i = modKeys.length - 1; i >= 0; i--) {
        currentMods &= ~modKeys[i].bit;
        await sendCdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers: currentMods, key: modKeys[i].key, code: modKeys[i].code, windowsVirtualKeyCode: modKeys[i].vkc });
      }
      dispatched++;
    }
  }
  return { dispatched, os };
}

async function cmdScroll(p = {}) {
  const amount = p.amount ?? 500;
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  await sendCdp(tabId, 'Runtime.evaluate', {
    expression: `window.scrollBy({top:${amount},behavior:'instant'})`, returnByValue: true,
  });
  return { scrolled: amount };
}

async function cmdExtract(p = {}) {
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  const expr = p.selector
    ? `(function(){var e=document.querySelector('${p.selector.replace(/\\/g,'\\\\').replace(/'/g,"\\'")}');return e?(e.textContent||e.innerText||''):'';})()`
    : 'document.body?document.body.innerText:""';
  const r = await sendCdp(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true });
  const content = r.result?.value || '';
  return { content, length: content.length };
}

async function cmdEvaluate(p = {}) {
  if (!p.script) throw new Error('script required');
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  const r = await sendCdp(tabId, 'Runtime.evaluate', {
    expression: p.script, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'evaluate failed');
  return { type: r.result.type, value: r.result.value };
}

async function cmdSnapshot(_p = {}) {
  const tabId = _p.tab_id ? Number(_p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  resetRefs();
  const { nodes } = await sendCdp(tabId, 'Accessibility.getFullAXTree', {});
  const tree = buildAXTree(nodes);
  const tab = await chrome.tabs.get(tabId);
  return { url: tab.url, title: tab.title, tree };
}

function buildAXTree(nodes) {
  const byId = new Map(nodes.map(n => [n.nodeId, n]));
  if (nodes.length === 0) return [];
  const root = nodes[0];
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
  if (root.childIds) return root.childIds.map(id => walk(byId.get(id))).filter(Boolean);
  return [];
}

// ---------------------------------------------------------------------------
// Advanced commands
// ---------------------------------------------------------------------------

async function cmdCdp(p = {}) {
  if (!p.method) throw new Error('method required');
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  return sendCdp(tabId, p.method, p.params || {});
}

async function cmdNetwork(p = {}) {
  if (!p.cmd) throw new Error('cmd required (start/stop/list/detail)');
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  installNetworkListener();

  switch (p.cmd) {
    case 'start':
      networkActive.add(tabId);
      networkCaptures.set(tabId, new Map());
      await sendCdp(tabId, 'Network.enable');
      return { started: true };
    case 'stop':
      networkActive.delete(tabId);
      try { await sendCdp(tabId, 'Network.disable'); } catch {}
      return { stopped: true };
    case 'list': {
      const store = networkCaptures.get(tabId) || new Map();
      let requests = [...store.values()];
      if (p.filter) requests = requests.filter(r => r.url.includes(p.filter));
      return { count: requests.length, requests };
    }
    case 'detail': {
      if (!p.requestId) throw new Error('requestId required');
      const store = networkCaptures.get(tabId);
      const req = store?.get(p.requestId);
      if (!req) throw new Error(`Request ${p.requestId} not found`);
      const body = await sendCdp(tabId, 'Network.getResponseBody', { requestId: p.requestId });
      return { ...req, body: body.body, base64Encoded: body.base64Encoded };
    }
    default: throw new Error(`Unknown network cmd: ${p.cmd}`);
  }
}

async function cmdUpload(p = {}) {
  if (!p.selector) throw new Error('selector required');
  if (!p.files || !Array.isArray(p.files) || p.files.length === 0) throw new Error('files required');
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  const { root } = await sendCdp(tabId, 'DOM.getDocument');
  const { nodeId } = await sendCdp(tabId, 'DOM.querySelector', { nodeId: root.nodeId, selector: p.selector });
  if (!nodeId) throw new Error(`Element not found: ${p.selector}`);
  await sendCdp(tabId, 'DOM.setFileInputFiles', { files: p.files, nodeId });
  return { uploaded: true, fileCount: p.files.length };
}

async function cmdSaveAsPdf(p = {}) {
  const tabId = p.tab_id ? Number(p.tab_id) : (await getActiveTab()).id;
  await attachDebugger(tabId);
  const [w, h] = PAPER_SIZES[(p.paper_format || 'a4').toLowerCase()] || PAPER_SIZES.a4;
  const scale = typeof p.scale === 'number' ? p.scale : 1;
  if (scale < 0.1 || scale > 2) throw new Error('scale must be 0.1-2.0');
  const r = await sendCdp(tabId, 'Page.printToPDF', {
    printBackground: p.print_background !== false,
    landscape: !!p.landscape,
    scale, paperWidth: w, paperHeight: h,
    preferCSSPageSize: true,
  });
  let title = '';
  try { title = (await sendCdp(tabId, 'Runtime.evaluate', { expression: 'document.title', returnByValue: true })).result?.value || ''; } catch {}
  return { data: r.data, mimeType: 'application/pdf', dataLength: r.data.length, pageTitle: title };
}

async function resolveObjectId(tabId, selector) {
  if (isRef(selector)) {
    const ref = getRef(selector);
    if (!ref) throw new Error(`Unknown ref: ${selector}`);
    const { object } = await sendCdp(tabId, 'DOM.resolveNode', { backendNodeId: ref.backendNodeId });
    if (!object?.objectId) throw new Error('Could not resolve ref');
    return object.objectId;
  }
  const esc = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const r = await sendCdp(tabId, 'Runtime.evaluate', { expression: `document.querySelector('${esc}')`, returnByValue: false });
  if (r.result.subtype === 'null' || !r.result.objectId) throw new Error(`Element not found: ${selector}`);
  return r.result.objectId;
}

// ---------------------------------------------------------------------------
// Cleanup & lifecycle
// ---------------------------------------------------------------------------

chrome.tabs.onRemoved.addListener(tabId => {
  attachedTabs.delete(tabId); networkActive.delete(tabId); networkCaptures.delete(tabId);
  if (activeTabId === tabId) activeTabId = null;
});

chrome.runtime.onInstalled.addListener(connect);
chrome.runtime.onStartup.addListener(connect);
connect();
