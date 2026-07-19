/**
 * CdpClient — Chrome DevTools Protocol client for browser automation.
 *
 * Wraps chrome-remote-interface for direct CDP connection.
 * Manages browser lifecycle (auto-launch), tab targeting, and all CDP operations.
 *
 * CDP domains used:
 *   Target  — tab management (list/create/close/activate)
 *   Page    — navigation, screenshots, PDF, viewport
 *   Runtime — JS evaluation, console collection
 *   Input   — mouse/keyboard dispatch
 *   Accessibility — page snapshot (AX tree)
 *   Network — request/response capture
 *   DOM     — file input
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';
import type {
  CdpConfig,
  TabInfo,
  ScreenshotResult,
  AccessibilityNode,
  ConsoleMessage,
  NetworkRequest,
  NetworkDetail,
  ComputerAction,
} from './types.js';
import { validateUrl } from './ssrf.js';

// chrome-remote-interface is CJS with default export
let CDP: any = null;
async function loadCDP(): Promise<any> {
  if (CDP) return CDP;
  CDP = await import('chrome-remote-interface');
  return CDP.default || CDP;
}

// ── Constants ───────────────────────────────────────────────────────────

const DEFAULT_CDP_PORT = 9222;
const DEFAULT_HOST = '127.0.0.1';
const NAVIGATE_TIMEOUT_MS = 30_000;
const CONNECT_TIMEOUT_MS = 10_000;

// ── Helpers ────────────────────────────────────────────────────────────

/** Check if a TCP port is listening. */
function isPortOpen(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = createConnection(port, host);
    sock.on('connect', () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.setTimeout(2000, () => { sock.destroy(); resolve(false); });
  });
}

/** Wait for a port to become available (Chrome startup). */
async function waitForPort(
  host: string,
  port: number,
  timeoutMs: number = 15_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await isPortOpen(host, port)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timeout waiting for Chrome on ${host}:${port}`);
}

/** Detect Chrome browser paths on macOS. */
function detectChromePath(): string | null {
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc',
  ];
  for (const p of candidates) {
    try { readFileSync(p); return p; } catch { /* not found */ }
  }
  return null;
}

// ── CdpClient ──────────────────────────────────────────────────────────

export class CdpClient {
  private config: CdpConfig;
  private host: string;
  private port: number;
  private browserProcess: ChildProcess | null = null;
  private connected = false;
  private activeClient: any = null; // active CDP client (last used)
  private activeTabId: string | null = null;

  // Per-tab state
  private networkStores = new Map<string, Map<string, NetworkRequest>>();
  private networkActiveTabs = new Set<string>();
  private consoleStores = new Map<string, ConsoleMessage[]>();

  // GIF recording state
  private gifRecording = false;
  private gifFrames: string[] = []; // base64 frames

  // Event listener cleanup registry
  private listenerCleanups: Array<() => void> = [];

  constructor(config: CdpConfig = {}) {
    this.config = config;
    this.host = DEFAULT_HOST;
    this.port = config.port ?? DEFAULT_CDP_PORT;
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  /** Ensure we are connected to a Chrome instance. */
  async connect(): Promise<void> {
    if (this.connected) return;

    // Check if Chrome is already running on the CDP port
    const isOpen = await isPortOpen(this.host, this.port);

    if (!isOpen) {
      await this.launchBrowser();
    }

    // Verify we can connect
    try {
      const cdp = await loadCDP();
      // Use List to verify the port works
      await cdp.List({ host: this.host, port: this.port });
      this.connected = true;
    } catch (err) {
      throw new Error(
        `Failed to connect to Chrome DevTools on ${this.host}:${this.port}. ` +
        `Ensure Chrome is running with --remote-debugging-port=${this.port}. ` +
        `Error: ${(err as Error).message}`,
      );
    }
  }

  /** Disconnect and optionally kill the browser (only if we launched it). */
  async disconnect(): Promise<void> {
    // Remove all CDP event listeners
    for (const cleanup of this.listenerCleanups) {
      try { cleanup(); } catch { /* ignore */ }
    }
    this.listenerCleanups = [];

    if (this.activeClient) {
      try { await this.activeClient.close(); } catch { /* ignore */ }
      this.activeClient = null;
    }
    this.activeTabId = null;
    this.connected = false;

    // Clear all accumulated per-tab state
    this.networkStores.clear();
    this.networkActiveTabs.clear();
    this.consoleStores.clear();
    this.gifFrames = [];
    this.gifRecording = false;
  }

  /** Shutdown: disconnect + kill browser if we spawned it. */
  async shutdown(): Promise<void> {
    await this.disconnect();
    if (this.browserProcess) {
      this.browserProcess.kill();
      this.browserProcess = null;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  // ── Browser Launch ──────────────────────────────────────────────────

  private async launchBrowser(): Promise<void> {
    const chromePath = this.config.browserPath ?? detectChromePath();
    if (!chromePath) {
      throw new Error(
        'No Chrome browser found. Install Chrome or set browserPath in config.',
      );
    }

    const args: string[] = [
      `--remote-debugging-port=${this.port}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
    ];

    if (this.config.headless) {
      args.push('--headless=new');
    }

    if (this.config.userDataDir) {
      args.push(`--user-data-dir=${this.config.userDataDir}`);
    }

    this.browserProcess = spawn(chromePath, args, {
      stdio: 'ignore',
      detached: true,
    });

    this.browserProcess.unref();

    // Wait for Chrome to start
    await waitForPort(this.host, this.port, 15_000);
    this.connected = true;
  }

  // ── CDP Client per Target ───────────────────────────────────────────

  /** Get or create a CDP client for a specific tab. */
  private async getClient(tabId?: string): Promise<any> {
    await this.connect();

    const targetId = tabId ?? this.activeTabId;
    if (!targetId) {
      // Get the first available page target
      const tabs = await this.getTabs();
      if (tabs.length === 0) {
        throw new Error('No open tabs. Use browser_new_tab to create one.');
      }
      const firstTab = tabs[0]!;
      this.activeTabId = firstTab.id;
      return this.getClientForTarget(firstTab.id);
    }

    return this.getClientForTarget(targetId);
  }

  private async getClientForTarget(targetId: string): Promise<any> {
    const cdp = await loadCDP();

    // Close existing client if switching targets
    if (this.activeClient && this.activeTabId !== targetId) {
      try { await this.activeClient.close(); } catch { /* ignore */ }
      this.activeClient = null;
    }

    if (this.activeClient && this.activeTabId === targetId) {
      return this.activeClient;
    }

    const client = await cdp({
      host: this.host,
      port: this.port,
      target: targetId,
    });

    // Enable essential domains
    await client.Page.enable();
    await client.Runtime.enable();
    await client.DOM.enable();

    // Restore network monitoring if active for this tab
    if (this.networkActiveTabs.has(targetId)) {
      try { await client.Network.enable(); } catch { /* ignore */ }
    }

    this.activeClient = client;
    this.activeTabId = targetId;
    return client;
  }

  // ── Tab Management ──────────────────────────────────────────────────

  async getTabs(): Promise<TabInfo[]> {
    const cdp = await loadCDP();
    const targets = await cdp.List({ host: this.host, port: this.port });
    return targets
      .filter((t: any) => t.type === 'page')
      .map((t: any) => ({
        id: t.id,
        url: t.url || '',
        title: t.title || '',
        active: t.id === this.activeTabId,
      }));
  }

  async newTab(url?: string): Promise<TabInfo> {
    const client = await this.getClient(); // ensure connected
    const result = await client.Target.createTarget({
      url: url || 'about:blank',
    });
    const targetId = result.targetId;
    this.activeTabId = targetId;

    // Get tab info
    const tabs = await this.getTabs();
    const tab = tabs.find((t) => t.id === targetId);
    return tab ?? { id: targetId, url: url || 'about:blank', title: '', active: true };
  }

  async closeTab(tabId: string): Promise<{ closed: boolean }> {
    const client = await this.getClient();
    await client.Target.closeTarget({ targetId: tabId });
    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      if (this.activeClient) {
        try { await this.activeClient.close(); } catch { /* ignore */ }
        this.activeClient = null;
      }
    }
    return { closed: true };
  }

  async switchTab(tabId: string): Promise<TabInfo> {
    const client = await this.getClient();
    await client.Target.activateTarget({ targetId: tabId });
    this.activeTabId = tabId;

    const tabs = await this.getTabs();
    const tab = tabs.find((t) => t.id === tabId);
    return tab ?? { id: tabId, url: '', title: '', active: true };
  }

  async findTab(url: string): Promise<TabInfo> {
    const tabs = await this.getTabs();
    let hostname: string;
    try { hostname = new URL(url).hostname; } catch { hostname = url; }

    const found = tabs.find((t) => {
      try { return new URL(t.url).hostname === hostname; } catch { return false; }
    });

    if (!found) {
      throw new Error(`No tab matching URL: ${url}`);
    }

    // Activate the found tab
    const client = await this.getClient();
    await client.Target.activateTarget({ targetId: found.id });
    this.activeTabId = found.id;

    return found;
  }

  // ── Page Operations ─────────────────────────────────────────────────

  async navigate(url: string, tabId?: string): Promise<{ url: string; title: string }> {
    validateUrl(url);
    const client = await this.getClient(tabId);
    await client.Page.navigate({ url });

    // Wait for page load
    await this.waitForPageLoad(client);

    const result = await client.Runtime.evaluate({
      expression: 'document.title',
      returnByValue: true,
    });

    return {
      url,
      title: result.result?.value ?? '',
    };
  }

  async screenshot(
    tabId?: string,
    fullPage: boolean = false,
    selector?: string,
  ): Promise<ScreenshotResult> {
    const client = await this.getClient(tabId);

    // If selector is given, scroll it into view first
    if (selector) {
      const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      await client.Runtime.evaluate({
        expression: `(function(){var e=document.querySelector('${escaped}');if(e)e.scrollIntoView({behavior:'instant',block:'center'});})()`,
        returnByValue: true,
      });
      await new Promise((r) => setTimeout(r, 200));
    }

    const opts: any = { format: 'png' };
    if (fullPage) {
      opts.captureBeyondViewport = true;
    }

    const result = await client.Page.captureScreenshot(opts);

    // Get viewport dimensions
    const layoutMetrics = await client.Page.getLayoutMetrics();
    const width = layoutMetrics.cssVisualViewport?.clientWidth ?? 0;
    const height = layoutMetrics.cssVisualViewport?.clientHeight ?? 0;

    return {
      data: result.data,
      width,
      height,
      format: 'png',
    };
  }

  async savePdf(
    tabId?: string,
    paperSize: string = 'a4',
  ): Promise<{ data: string }> {
    const client = await this.getClient(tabId);
    const PAPER_SIZES: Record<string, [number, number]> = {
      letter: [8.5, 11],
      legal: [8.5, 14],
      a4: [8.27, 11.69],
      a3: [11.69, 16.54],
      tabloid: [11, 17],
    };
    const [pw, ph] = PAPER_SIZES[paperSize] ?? PAPER_SIZES['a4']!;

    const result = await client.Page.printToPDF({
      paperWidth: pw,
      paperHeight: ph,
      printBackground: true,
    });

    return { data: result.data };
  }

  async resizeWindow(
    width: number,
    height: number,
    tabId?: string,
  ): Promise<{ width: number; height: number }> {
    const client = await this.getClient(tabId);
    await client.Page.setDeviceMetricsOverride({
      width,
      height,
      deviceScaleFactor: 1,
      mobile: false,
      fitWindow: true,
    });
    return { width, height };
  }

  // ── Runtime ─────────────────────────────────────────────────────────

  async evaluate(script: string, tabId?: string): Promise<any> {
    const client = await this.getClient(tabId);
    const result = await client.Runtime.evaluate({
      expression: script,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result?.value;
  }

  async getPageText(tabId?: string): Promise<string> {
    const client = await this.getClient(tabId);
    const result = await client.Runtime.evaluate({
      expression: 'document.body ? document.body.innerText : ""',
      returnByValue: true,
    });
    return result.result?.value ?? '';
  }

  async extract(selector?: string, tabId?: string): Promise<{ content: string; length: number }> {
    const client = await this.getClient(tabId);
    const expression = selector
      ? `(function(){var e=document.querySelector('${selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}');return e?(e.textContent||e.innerText||''):'';})()`
      : 'document.body?document.body.innerText:""';

    const result = await client.Runtime.evaluate({
      expression,
      returnByValue: true,
    });

    const content = String(result.result?.value ?? '');
    return { content, length: content.length };
  }

  // ── Console Messages ────────────────────────────────────────────────

  async getConsoleMessages(
    tabId?: string,
    opts: { onlyErrors?: boolean; clear?: boolean; pattern?: string; limit?: number } = {},
  ): Promise<ConsoleMessage[]> {
    const client = await this.getClient(tabId);
    const targetId = tabId ?? this.activeTabId ?? 'default';

    // Initialize store for this tab
    if (!this.consoleStores.has(targetId)) {
      this.consoleStores.set(targetId, []);
      // Set up listener
      client.Runtime.consoleAPICalled((params: any) => {
        const store = this.consoleStores.get(targetId);
        if (!store) return;
        const msg: ConsoleMessage = {
          level: params.type,
          text: params.args?.map((a: any) => a.value ?? a.description ?? JSON.stringify(a)).join(' ') ?? '',
          timestamp: Date.now(),
          source: 'console',
        };
        store.push(msg);
        // Cap at 10,000 entries to prevent unbounded memory growth
        if (store.length > 10_000) {
          store.splice(0, store.length - 10_000);
        }
      });
      // Enable console if not already
      try { await client.Runtime.enable(); } catch { /* ignore */ }
    }

    let messages = this.consoleStores.get(targetId) ?? [];

    if (opts.onlyErrors) {
      messages = messages.filter((m) => m.level === 'error' || m.level === 'warning');
    }
    if (opts.pattern) {
      const re = new RegExp(opts.pattern, 'i');
      messages = messages.filter((m) => re.test(m.text));
    }
    if (opts.limit) {
      messages = messages.slice(-opts.limit);
    }

    if (opts.clear) {
      this.consoleStores.set(targetId, []);
    }

    return messages;
  }

  // ── Input: Mouse ────────────────────────────────────────────────────

  async mouseClick(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle' = 'left',
    clickCount: number = 1,
    tabId?: string,
  ): Promise<{ clicked: true; x: number; y: number }> {
    const client = await this.getClient(tabId);
    await client.Input.dispatchMouseEvent({
      type: 'mousePressed',
      x, y,
      button,
      clickCount,
    });
    await client.Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x, y,
      button,
      clickCount,
    });
    return { clicked: true, x, y };
  }

  async mouseDown(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle' = 'left',
    tabId?: string,
  ): Promise<void> {
    const client = await this.getClient(tabId);
    await client.Input.dispatchMouseEvent({
      type: 'mousePressed',
      x, y,
      button,
      clickCount: 1,
    });
  }

  async mouseUp(
    x: number,
    y: number,
    button: 'left' | 'right' | 'middle' = 'left',
    tabId?: string,
  ): Promise<void> {
    const client = await this.getClient(tabId);
    await client.Input.dispatchMouseEvent({
      type: 'mouseReleased',
      x, y,
      button,
      clickCount: 1,
    });
  }

  async mouseMove(x: number, y: number, tabId?: string): Promise<void> {
    const client = await this.getClient(tabId);
    await client.Input.dispatchMouseEvent({
      type: 'mouseMoved',
      x, y,
      button: 'none',
    });
  }

  // ── Input: Keyboard ─────────────────────────────────────────────────

  async insertText(text: string, selector?: string, tabId?: string): Promise<{ typed: true }> {
    const client = await this.getClient(tabId);

    if (selector) {
      // Focus the element first
      const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      await client.Runtime.evaluate({
        expression: `(function(){var e=document.querySelector('${escaped}');if(e)e.focus();})()`,
        returnByValue: true,
      });
    }

    await client.Input.insertText({ text });
    return { typed: true };
  }

  /** Send key combinations like "ctrl+c", "cmd+v", "Enter", "Tab" */
  async sendKeys(keys: string, tabId?: string): Promise<{ sent: true }> {
    const client = await this.getClient(tabId);
    const chords = this.parseKeys(keys);

    for (const chord of chords) {
      // Press modifiers
      for (const mod of chord.modifiers) {
        await client.Input.dispatchKeyEvent({
          type: 'keyDown',
          key: mod,
        });
      }
      // Press main key
      await client.Input.dispatchKeyEvent({
        type: 'rawKeyDown',
        key: chord.key,
        windowsVirtualKeyCode: chord.vkCode,
      });
      await client.Input.dispatchKeyEvent({
        type: 'keyUp',
        key: chord.key,
      });
      // Release modifiers (reverse order)
      for (const mod of chord.modifiers.reverse()) {
        await client.Input.dispatchKeyEvent({
          type: 'keyUp',
          key: mod,
        });
      }
    }

    return { sent: true };
  }

  private KEY_MAP: Record<string, { key: string; vkCode: number }> = {
    enter: { key: 'Enter', vkCode: 13 },
    return: { key: 'Enter', vkCode: 13 },
    escape: { key: 'Escape', vkCode: 27 },
    esc: { key: 'Escape', vkCode: 27 },
    tab: { key: 'Tab', vkCode: 9 },
    backspace: { key: 'Backspace', vkCode: 8 },
    delete: { key: 'Delete', vkCode: 46 },
    space: { key: ' ', vkCode: 32 },
    arrowup: { key: 'ArrowUp', vkCode: 38 },
    arrowdown: { key: 'ArrowDown', vkCode: 40 },
    arrowleft: { key: 'ArrowLeft', vkCode: 37 },
    arrowright: { key: 'ArrowRight', vkCode: 39 },
    home: { key: 'Home', vkCode: 36 },
    end: { key: 'End', vkCode: 35 },
    pageup: { key: 'PageUp', vkCode: 33 },
    pagedown: { key: 'PageDown', vkCode: 34 },
  };

  private parseKeys(keysStr: string): Array<{ key: string; vkCode: number; modifiers: string[] }> {
    return keysStr.trim().split(/\s+/).map((segment) => {
      const parts = segment.split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
      if (parts.length === 0) throw new Error('Empty key segment');

      const mainKeyStr = parts.pop()!;
      const modifierNames = parts;
      const modifiers: string[] = [];

      for (const mod of modifierNames) {
        const normalized = mod === 'cmd' || mod === 'meta' ? 'Meta' :
          mod === 'ctrl' || mod === 'control' ? 'Control' :
          mod === 'alt' || mod === 'option' ? 'Alt' :
          mod === 'shift' ? 'Shift' : mod;
        modifiers.push(normalized);
      }

      // Special keys
      const spec = this.KEY_MAP[mainKeyStr];
      if (spec) return { key: spec.key, vkCode: spec.vkCode, modifiers };

      // F-keys
      const fMatch = mainKeyStr.match(/^f(\d{1,2})$/);
      if (fMatch) {
        const n = parseInt(fMatch[1]!);
        return { key: `F${n}`, vkCode: 111 + n, modifiers };
      }

      // Single characters
      if (mainKeyStr.length === 1) {
        const upper = mainKeyStr.toUpperCase();
        const vkCode = upper.charCodeAt(0);
        return {
          key: modifiers.includes('Shift') ? upper : mainKeyStr,
          vkCode,
          modifiers,
        };
      }

      throw new Error(
        `Unknown key: "${mainKeyStr}". Use Enter, Tab, Escape, Space, F1-F12, letters, digits, or arrow keys.`,
      );
    });
  }

  // ── Click by Selector ───────────────────────────────────────────────

  async clickSelector(selector: string, tabId?: string): Promise<any> {
    const client = await this.getClient(tabId);
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await client.Runtime.evaluate({
      expression: `(function(){var e=document.querySelector('${escaped}');if(!e)return JSON.stringify({error:'Not found'});e.scrollIntoView({behavior:'instant',block:'center'});e.click();return JSON.stringify({clicked:true,tag:e.tagName,text:(e.textContent||'').slice(0,80)});})()`,
      returnByValue: true,
    });
    const val = result.result?.value;
    if (val) {
      try {
        const parsed = JSON.parse(val);
        if (parsed.error) throw new Error(parsed.error);
        return parsed;
      } catch (e) {
        if ((e as Error).message === val || val.includes('error')) throw e;
        return { clicked: true };
      }
    }
    return { clicked: true };
  }

  // ── Fill Form ───────────────────────────────────────────────────────

  async fill(selector: string, value: string | number | boolean, tabId?: string): Promise<{ filled: true }> {
    const client = await this.getClient(tabId);
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const jsonValue = JSON.stringify(value);
    await client.Runtime.evaluate({
      expression: `(function(){const t=document.querySelector('${escaped}');const ns=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set||Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;ns.call(t,${jsonValue});t.dispatchEvent(new Event('input',{bubbles:true}));t.dispatchEvent(new Event('change',{bubbles:true}));return{filled:true};})()`,
      returnByValue: true,
    });
    return { filled: true };
  }

  // ── Scroll ──────────────────────────────────────────────────────────

  async scroll(
    amount: number = 500,
    direction: 'up' | 'down' | 'left' | 'right' = 'down',
    tabId?: string,
  ): Promise<{ scrolled: number }> {
    const client = await this.getClient(tabId);
    const offset = direction === 'up' ? -amount : direction === 'left' ? -amount : amount;
    const axis = (direction === 'left' || direction === 'right') ? 'left' : 'top';

    await client.Runtime.evaluate({
      expression: `window.scrollBy({${axis}:${offset},behavior:'instant'})`,
    });
    return { scrolled: amount };
  }

  // ── Accessibility Snapshot ──────────────────────────────────────────

  async snapshot(
    tabId?: string,
    filter: 'interactive' | 'all' = 'all',
    depth: number = 15,
    maxChars: number = 50000,
  ): Promise<AccessibilityNode[]> {
    const client = await this.getClient(tabId);

    try {
      const result = await client.Accessibility.getFullAXTree({
        depth,
      });

      const nodes = this.buildAXTree(result.nodes, filter);
      return nodes;
    } catch {
      // Fallback: DOM-based snapshot
      return this.domSnapshot(tabId);
    }
  }

  private INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'searchbox',
    'slider', 'spinbutton', 'switch', 'tab', 'treeitem', 'heading', 'article',
  ]);

  private buildAXTree(rawNodes: any[], filter: 'interactive' | 'all'): AccessibilityNode[] {
    const nodeMap = new Map<string, any>();
    const roots: any[] = [];

    for (const node of rawNodes) {
      nodeMap.set(node.nodeId, node);
    }

    const convert = (raw: any): AccessibilityNode | null => {
      const role = (raw.role?.value ?? '').toLowerCase();
      const name = raw.name?.value ?? '';

      if (filter === 'interactive' && !this.INTERACTIVE_ROLES.has(role)) {
        // Still check children
        const children = (raw.childIds ?? [])
          .map((id: string) => convert(nodeMap.get(id)))
          .filter(Boolean) as AccessibilityNode[];
        if (children.length === 0) return null;
        return {
          role,
          name,
          ref: `e${raw.backendDOMNodeId}`,
          children,
          backendNodeId: raw.backendDOMNodeId,
        };
      }

      const children = (raw.childIds ?? [])
        .map((id: string) => convert(nodeMap.get(id)))
        .filter(Boolean) as AccessibilityNode[];

      return {
        role,
        name,
        ref: raw.backendDOMNodeId ? `e${raw.backendDOMNodeId}` : undefined,
        children: children.length > 0 ? children : undefined,
        value: raw.value?.value,
        description: raw.description?.value,
        backendNodeId: raw.backendDOMNodeId,
      };
    };

    for (const node of rawNodes) {
      const parentId = node.parentId;
      if (!parentId || !nodeMap.has(parentId)) {
        const converted = convert(node);
        if (converted) roots.push(converted);
      }
    }

    return roots;
  }

  /** Fallback DOM-based snapshot when Accessibility domain is not available. */
  private async domSnapshot(tabId?: string): Promise<AccessibilityNode[]> {
    const client = await this.getClient(tabId);
    const result = await client.Runtime.evaluate({
      expression: `(function(){
        function build(parent, depth) {
          if (depth > 10) return [];
          const nodes = [];
          for (const child of parent.children) {
            const tag = child.tagName.toLowerCase();
            const role = tag === 'a' ? 'link' : tag === 'button' ? 'button' :
              tag === 'input' ? (child.type === 'checkbox' ? 'checkbox' : child.type === 'radio' ? 'radio' : 'textbox') :
              tag === 'select' ? 'combobox' : tag === 'textarea' ? 'textbox' : tag;
            const name = child.textContent?.trim().slice(0, 100) || child.getAttribute('aria-label') || child.getAttribute('placeholder') || '';
            nodes.push({
              role, name,
              children: build(child, depth + 1),
              ref: 'e' + (child.getAttribute('data-ref') || '')
            });
          }
          return nodes;
        }
        return build(document.body || document.documentElement, 0);
      })()`,
      returnByValue: true,
    });
    return result.result?.value ?? [];
  }

  // ── Find Elements ───────────────────────────────────────────────────

  async find(query: string, tabId?: string): Promise<AccessibilityNode[]> {
    // Get the full accessibility tree and search by name/text
    const tree = await this.snapshot(tabId, 'interactive', 15);

    const searchInNode = (node: AccessibilityNode, q: string): AccessibilityNode[] => {
      const results: AccessibilityNode[] = [];
      const qLower = q.toLowerCase();
      const nameMatch = node.name?.toLowerCase().includes(qLower);
      const roleMatch = node.role?.toLowerCase().includes(qLower);
      const descMatch = node.description?.toLowerCase().includes(qLower);

      if (nameMatch || roleMatch || descMatch) {
        results.push(node);
      }

      if (node.children) {
        for (const child of node.children) {
          results.push(...searchInNode(child, q));
        }
      }

      return results;
    };

    const results: AccessibilityNode[] = [];
    for (const node of tree) {
      results.push(...searchInNode(node, query));
    }
    return results;
  }

  // ── Network Capture ─────────────────────────────────────────────────

  async networkStart(tabId?: string): Promise<{ started: boolean }> {
    const client = await this.getClient(tabId);
    const targetId = tabId ?? this.activeTabId!;

    // Guard: don't re-register listeners if already active for this tab
    if (this.networkActiveTabs.has(targetId)) {
      return { started: true };
    }

    if (!this.networkStores.has(targetId)) {
      this.networkStores.set(targetId, new Map());
    }
    this.networkActiveTabs.add(targetId);

    // Install event listeners
    await client.Network.enable();

    const onRequestWillBeSent = (params: any) => {
      const store = this.networkStores.get(targetId);
      if (store) {
        store.set(params.requestId, {
          requestId: params.requestId,
          url: params.request.url,
          method: params.request.method,
          timestamp: params.timestamp,
        });
      }
    };

    const onResponseReceived = (params: any) => {
      const store = this.networkStores.get(targetId);
      const req = store?.get(params.requestId);
      if (req) {
        req.status = params.response.status;
        req.mimeType = params.response.mimeType;
      }
    };

    const onLoadingFinished = (params: any) => {
      const store = this.networkStores.get(targetId);
      const req = store?.get(params.requestId);
      if (req) {
        req.completed = true;
      }
    };

    client.on('Network.requestWillBeSent', onRequestWillBeSent);
    client.on('Network.responseReceived', onResponseReceived);
    client.on('Network.loadingFinished', onLoadingFinished);

    // Register cleanup handlers
    this.listenerCleanups.push(() => {
      try { client.off('Network.requestWillBeSent', onRequestWillBeSent); } catch { /* */}
      try { client.off('Network.responseReceived', onResponseReceived); } catch { /* */}
      try { client.off('Network.loadingFinished', onLoadingFinished); } catch { /* */}
    });

    return { started: true };
  }

  async networkStop(tabId?: string): Promise<{ stopped: boolean }> {
    const targetId = tabId ?? this.activeTabId!;
    this.networkActiveTabs.delete(targetId);
    this.networkStores.delete(targetId);
    try {
      const client = await this.getClient(tabId);
      await client.Network.disable();
    } catch { /* ignore */ }
    return { stopped: true };
  }

  async networkList(
    tabId?: string,
    filter?: string,
    limit?: number,
  ): Promise<{ count: number; requests: NetworkRequest[] }> {
    const targetId = tabId ?? this.activeTabId ?? '';
    const store = this.networkStores.get(targetId) ?? new Map();
    let requests = [...store.values()];

    if (filter) {
      requests = requests.filter((r) => r.url.includes(filter));
    }

    requests.sort((a, b) => b.timestamp - a.timestamp);

    if (limit) {
      requests = requests.slice(0, limit);
    }

    return { count: requests.length, requests };
  }

  async networkDetail(requestId: string, tabId?: string): Promise<NetworkDetail | null> {
    const client = await this.getClient(tabId);
    const targetId = tabId ?? this.activeTabId ?? '';
    const store = this.networkStores.get(targetId);
    const req = store?.get(requestId);
    if (!req) return null;

    try {
      const body = await client.Network.getResponseBody({ requestId });
      return { ...req, body: body.body, base64Encoded: body.base64Encoded };
    } catch {
      return { ...req };
    }
  }

  // ── File Upload ─────────────────────────────────────────────────────

  async uploadFile(
    selector: string,
    filePaths: string[],
    tabId?: string,
  ): Promise<{ uploaded: true; files: string[] }> {
    const client = await this.getClient(tabId);

    // Find the file input element
    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const nodeResult = await client.Runtime.evaluate({
      expression: `(function(){var e=document.querySelector('${escaped}');if(!e)return null;return{backendNodeId:0};})()`,
      returnByValue: true,
    });

    if (!nodeResult.result?.value) {
      throw new Error(`File input not found: ${selector}`);
    }

    // Use DOM.setFileInputFiles — need the node
    const docResult = await client.DOM.getDocument({ depth: -1 });
    const nodeId = await this.findNodeId(docResult.root, selector);
    if (nodeId === null) {
      throw new Error(`Could not resolve node for selector: ${selector}`);
    }

    await client.DOM.setFileInputFiles({
      files: filePaths,
      nodeId,
    });

    return { uploaded: true, files: filePaths };
  }

  private async findNodeId(root: any, selector: string): Promise<number | null> {
    // Use Runtime.evaluate with querySelector + DOM.requestNode
    const client = this.activeClient;
    if (!client) return null;

    const escaped = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const result = await client.Runtime.evaluate({
      expression: `document.querySelector('${escaped}')`,
      returnByValue: false,
    });

    if (!result.result?.objectId) return null;

    const nodeResult = await client.DOM.requestNode({
      objectId: result.result.objectId,
    });

    return nodeResult.nodeId ?? null;
  }

  // ── GIF Creator (simplified) ────────────────────────────────────────

  /** Start recording screenshots for GIF creation. */
  async gifStart(tabId?: string): Promise<{ recording: true }> {
    await this.getClient(tabId);
    this.gifRecording = true;
    this.gifFrames = [];
    return { recording: true };
  }

  /** Stop recording. */
  async gifStop(): Promise<{ stopped: true }> {
    this.gifRecording = false;
    return { stopped: true };
  }

  /** Get recorded frames. Full GIF encoding would need ffmpeg. */
  async gifExport(filename?: string): Promise<{ frames: number; filename?: string }> {
    this.gifRecording = false;
    return { frames: this.gifFrames.length, filename };
  }

  /** Clear recorded frames. */
  async gifClear(): Promise<{ cleared: true }> {
    this.gifFrames = [];
    return { cleared: true };
  }

  // ── Combined Computer Tool ──────────────────────────────────────────

  async computerAction(
    action: ComputerAction,
    params: {
      coordinate?: [number, number];
      start_coordinate?: [number, number];
      text?: string;
      duration?: number;
      scroll_direction?: 'up' | 'down' | 'left' | 'right';
      scroll_amount?: number;
      region?: [number, number, number, number];
      repeat?: number;
      ref?: string;
      modifiers?: string;
      tabId?: number;
    },
  ): Promise<any> {
    const tabId = params.tabId ? String(params.tabId) : undefined;
    const client = await this.getClient(tabId);
    const [x, y] = params.coordinate ?? [0, 0];

    switch (action) {
      case 'left_click':
        return this.mouseClick(x, y, 'left', 1, tabId);

      case 'right_click':
        return this.mouseClick(x, y, 'right', 1, tabId);

      case 'double_click':
        return this.mouseClick(x, y, 'left', 2, tabId);

      case 'triple_click':
        return this.mouseClick(x, y, 'left', 3, tabId);

      case 'hover':
        await this.mouseMove(x, y, tabId);
        return { hovered: true, x, y };

      case 'scroll': {
        const amount = params.scroll_amount ?? 1;
        const direction = params.scroll_direction ?? 'down';
        // Convert scroll_amount (1-10) to pixels
        return this.scroll(amount * 100, direction, tabId);
      }

      case 'scroll_to': {
        if (params.coordinate) {
          await client.Runtime.evaluate({
            expression: `window.scrollTo(${x},${y})`,
          });
        }
        return { scrolled_to: { x, y } };
      }

      case 'type': {
        if (!params.text) throw new Error('text is required for type action');
        return this.insertText(params.text, undefined, tabId);
      }

      case 'key': {
        if (!params.text) throw new Error('text is required for key action');
        const repeat = params.repeat ?? 1;
        for (let i = 0; i < repeat; i++) {
          await this.sendKeys(params.text, tabId);
        }
        return { key: params.text, repeat };
      }

      case 'left_click_drag': {
        const [sx, sy] = params.start_coordinate ?? params.coordinate ?? [0, 0];
        await this.mouseDown(sx, sy, 'left', tabId);
        // Move to end coordinate
        for (let i = 0; i <= 10; i++) {
          const mx = sx + (x - sx) * (i / 10);
          const my = sy + (y - sy) * (i / 10);
          await this.mouseMove(Math.round(mx), Math.round(my), tabId);
          await new Promise((r) => setTimeout(r, 20));
        }
        await this.mouseUp(x, y, 'left', tabId);
        return { dragged: true, from: [sx, sy], to: [x, y] };
      }

      case 'screenshot': {
        const result = await this.screenshot(tabId);
        // Also capture a frame for GIF if recording
        if (this.gifRecording) {
          this.gifFrames.push(result.data);
        }
        return result;
      }

      case 'wait': {
        const duration = Math.min(params.duration ?? 1, 30) * 1000;
        await new Promise((r) => setTimeout(r, duration));
        return { waited: params.duration ?? 1 };
      }

      case 'zoom': {
        if (!params.region) throw new Error('region is required for zoom');
        const [rx0, ry0, rx1, ry1] = params.region;
        // Take a full screenshot then crop it
        const result = await this.screenshot(tabId);
        // Return the region info — client handles cropping
        return {
          ...result,
          region: { x: rx0, y: ry0, width: rx1 - rx0, height: ry1 - ry0 },
        };
      }

      default:
        throw new Error(`Unknown computer action: ${action}`);
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────

  private async waitForPageLoad(client: any): Promise<void> {
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          const handler = (params: any) => {
            if (params?.frameId === client.target) {
              client.off('Page.loadEventFired', handler);
              resolve();
            }
          };
          client.on('Page.loadEventFired', handler);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, NAVIGATE_TIMEOUT_MS)),
      ]);
    } catch {
      // Timeout is OK — page may still be loading
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────────

let defaultClient: CdpClient | null = null;

/** Get or create the default CdpClient singleton. */
export function getCdpClient(config?: CdpConfig): CdpClient {
  if (!defaultClient) {
    defaultClient = new CdpClient(config);
  }
  return defaultClient;
}

/** Reset the default client (for testing). */
export function resetCdpClient(): void {
  defaultClient = null;
}
