/**
 * FreeCAD preview manager — drives the FreeCAD addon's XML-RPC endpoint directly
 * to fetch a live screenshot of the active view, and exposes that preview (plus
 * connection status) to the renderer over IPC. Also auto-launches FreeCAD and
 * keeps its window pinned flush to the right of coderix, resizing it live as
 * coderix moves/resizes (mirrors blender-preview.ts).
 *
 * Mirrors blender-preview.ts, but the transport is XML-RPC (port 9875) instead of
 * Blender's null-byte-delimited JSON socket (port 9876), and the screenshot comes
 * straight back as base64 PNG (no render-to-file step). The XML-RPC codec is ported
 * from freecad-harness's `server/freecad-rpc.mjs`.
 *
 * Window follow repositions FreeCAD's own window from *inside* FreeCAD — the
 * addon's `execute_code` RPC runs a Qt snippet on the GUI thread
 * (`Gui.getMainWindow().setGeometry(...)`), so no Accessibility permission is
 * needed. (Blender uses a ctypes/ObjC equivalent; FreeCAD exposes its main
 * window directly via Qt, which is simpler and more reliable.)
 *
 * FreeCAD returns null from `get_active_screenshot` until a document is open, so
 * the preview is empty before the first model is created (unlike Blender, which
 * always has a default scene).
 */

import { ipcMain, screen } from 'electron';
import type { BrowserWindow } from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  resolveFreecadBin,
  resolveFreecadRoot,
  resolveFreecadRpcUrl,
} from './freecad-paths.js';
import type { WindowManager } from './window-manager.js';

export const FREECAD_PREVIEW_CHANNELS = {
  STATUS: 'freecad:status',
  PREVIEW: 'freecad:preview',
  LAUNCH: 'freecad:launch',
} as const;

export interface FreecadStatusInfo {
  connected: boolean;
}

export interface FreecadPreviewInfo {
  connected: boolean;
  /** Base64-encoded PNG of the active view, present only when a document is open. */
  png?: string;
}

export interface FreecadLaunchInfo {
  connected: boolean;
  /** True when this call actually spawned a new FreeCAD process. */
  launched?: boolean;
}

// ---------------------------------------------------------------------------
// Minimal XML-RPC codec (ported from freecad-harness server/freecad-rpc.mjs)
// ---------------------------------------------------------------------------

const XML_ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
};

const XML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
};

function escapeXml(s: unknown): string {
  return String(s).replace(/[&<>]/g, (c) => XML_ESCAPE[c] ?? c);
}

function decodeEntities(s: string): string {
  return String(s).replace(/&(amp|lt|gt|quot|apos);/g, (m, e) => XML_ENTITIES['&' + e + ';'] ?? m);
}

function paramValue(v: unknown): string {
  if (v === undefined || v === null) return '<value><nil/></value>';
  if (typeof v === 'number') return `<value><int>${v}</int></value>`;
  if (typeof v === 'boolean') return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  return `<value><string>${escapeXml(v)}</string></value>`;
}

function buildMethodCall(methodName: string, params: unknown[] = []): string {
  const ps = params.map(paramValue).join('');
  return (
    '<?xml version="1.0"?>\n' +
    '<methodCall>\n' +
    `<methodName>${escapeXml(methodName)}</methodName>\n` +
    `<params>${ps}</params>\n` +
    '</methodCall>'
  );
}

interface RpcResult {
  type: 'base64' | 'nil' | 'string' | 'boolean' | 'int' | 'unknown';
  data: string | number | boolean | null;
}

async function callRpc(url: string, methodName: string, params: unknown[] = []): Promise<RpcResult> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildMethodCall(methodName, params),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`XML-RPC HTTP ${res.status}`);
  const text = await res.text();

  const fault = text.match(/<fault>[\s\S]*?<value>[\s\S]*?<string>([\s\S]*?)<\/string>/);
  if (fault) throw new Error(`XML-RPC fault: ${decodeEntities(fault[1])}`);

  const b64 = text.match(/<base64>([\s\S]*?)<\/base64>/);
  if (b64) return { type: 'base64', data: b64[1].trim() };
  if (/<nil\/?>/.test(text)) return { type: 'nil', data: null };
  const str = text.match(/<string>([\s\S]*?)<\/string>/);
  if (str) return { type: 'string', data: decodeEntities(str[1]) };
  const bool = text.match(/<boolean>([01])<\/boolean>/);
  if (bool) return { type: 'boolean', data: bool[1] === '1' };
  const int = text.match(/<int>(-?\d+)<\/int>/);
  if (int) return { type: 'int', data: parseInt(int[1], 10) };
  return { type: 'unknown', data: text };
}

/** Probe whether the FreeCAD addon is reachable (swallows errors, for status). */
async function pingFreecad(url: string): Promise<boolean> {
  try {
    const r = await callRpc(url, 'ping', []);
    return r.type === 'boolean' ? r.data === true : false;
  } catch {
    return false;
  }
}

/**
 * Fetch the active view's screenshot as a base64 PNG string. The addon returns a
 * base64 *string* (not an XML-RPC `<base64>`), and null when there's no active view.
 */
async function getScreenshot(url: string, viewName = 'Isometric'): Promise<string | null> {
  const r = await callRpc(url, 'get_active_screenshot', [viewName, null, null, null]);
  return r.type === 'base64' || r.type === 'string' ? (r.data as string) : null;
}

/**
 * Run a snippet of Python inside FreeCAD on its GUI thread (the addon's
 * `execute_code` RPC), and throw when it reports failure. Used for window
 * repositioning; the snippet itself swallows its own errors, so this only
 * fails when the addon is unreachable or the call faults.
 */
async function executeCode(url: string, code: string, timeoutMs = 5_000): Promise<void> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: buildMethodCall('execute_code', [code]),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`XML-RPC HTTP ${res.status}`);
  const text = await res.text();

  const fault = text.match(/<fault>[\s\S]*?<value>[\s\S]*?<string>([\s\S]*?)<\/string>/);
  if (fault) throw new Error(`XML-RPC fault: ${decodeEntities(fault[1])}`);

  // `execute_code` returns a struct with a `success` boolean member.
  const success = text.match(/<name>success<\/name>[\s\S]*?<value><boolean>([01])<\/boolean>/);
  if (success && success[1] === '0') {
    const msg = text.match(/<name>message<\/name>[\s\S]*?<value><string>([\s\S]*?)<\/string>/);
    throw new Error(msg ? decodeEntities(msg[1]) : 'execute_code failed');
  }
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

export interface FreecadPreviewManager {
  status(): Promise<FreecadStatusInfo>;
  preview(): Promise<FreecadPreviewInfo>;
  launch(): Promise<FreecadLaunchInfo>;
  destroy(): void;
}

export function createFreecadPreviewManager(windowManager: WindowManager): FreecadPreviewManager {
  const rpcUrl = resolveFreecadRpcUrl();

  async function status(): Promise<FreecadStatusInfo> {
    return { connected: await pingFreecad(rpcUrl) };
  }

  async function preview(): Promise<FreecadPreviewInfo> {
    try {
      const png = await getScreenshot(rpcUrl);
      return png ? { connected: true, png } : { connected: false };
    } catch {
      return { connected: false };
    }
  }

  // ── Auto-launch FreeCAD ──────────────────────────────────────────────
  // When the renderer's "Open FreeCAD" nav button is clicked, it calls `launch()`
  // so FreeCAD starts automatically (with the MCP addon's auto-start RPC server).
  // Guarded so we never spawn duplicates: skip when a FreeCAD process is running,
  // or within 10s of a previous attempt.

  let lastLaunchAttempt = 0;

  /** True when a FreeCAD GUI process is running. */
  function isFreecadRunning(): boolean {
    for (const name of ['FreeCAD', 'freecad']) {
      try {
        execFileSync('pgrep', ['-x', name], { stdio: 'ignore' });
        return true;
      } catch {
        // not running under this name
      }
    }
    return false;
  }

  /**
   * Resize coderix to the left portion of the usable area (reserving at least 1/3
   * of the width for FreeCAD on the right), and return FreeCAD's target geometry
   * as `(x, y, w, h)` where `(x, y)` is the TOP-LEFT corner in logical points.
   * Returns null when the coderix window isn't available.
   */
  function tileForFreecad(): { x: number; y: number; w: number; h: number } | null {
    const win = windowManager.getMainWindow();
    if (!win || win.isDestroyed()) return null;
    const display = screen.getDisplayMatching(win.getBounds());
    const wa = display.workArea;

    // FreeCAD gets at least 1/3 of the usable width; coderix keeps the rest.
    const freecadWidth = Math.max(Math.floor(wa.width / 3), 480);
    const coderixWidth = Math.max(wa.width - freecadWidth, 640);
    try {
      win.setBounds({ x: wa.x, y: wa.y, width: coderixWidth, height: wa.height });
    } catch {
      // Resizing coderix is best-effort — still tile FreeCAD on the right.
    }

    const left = wa.x + coderixWidth;
    const top = wa.y;
    return { x: left, y: top, w: freecadWidth, h: wa.height };
  }

  function spawnFreecad(): void {
    const bin = resolveFreecadBin();
    const cwd = resolveFreecadRoot();
    try {
      const child = spawn(bin, [], {
        cwd: existsSync(cwd) ? cwd : undefined,
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
      console.log(`[FreecadPreview] launched FreeCAD: ${bin} (cwd ${cwd})`);
    } catch (err) {
      console.warn('[FreecadPreview] failed to launch FreeCAD:', err instanceof Error ? err.message : err);
    }
  }

  // ── Keep FreeCAD adjacent on coderix move/resize ─────────────────────
  // When the user drags/resizes the coderix window, reposition FreeCAD's window
  // to stay flush on coderix's right. Done from *inside* FreeCAD (a Qt
  // `Gui.getMainWindow().setGeometry` call on its own window), so no
  // Accessibility permission is needed.

  let boundWindow: BrowserWindow | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reposition FreeCAD's own window via Qt. `(x, y)` is the TOP-LEFT corner in
   *  logical points (matches QWidget.setGeometry). */
  function repositionFreecad(x: number, y: number, w: number, h: number): void {
    const code = [
      'import FreeCADGui',
      'mw = FreeCADGui.getMainWindow()',
      'if mw:',
      `    mw.setGeometry(${x}, ${y}, ${w}, ${h})`,
    ].join('\n');
    void executeCode(rpcUrl, code, 5_000).catch(() => {
      // FreeCAD addon unreachable — ignore (window simply stays put).
    });
  }

  function syncTiling(): void {
    if (!isFreecadRunning()) return;
    const win = windowManager.getMainWindow();
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;
    const left = Math.round(bounds.x + bounds.width);
    const top = Math.round(bounds.y);
    const width = Math.round(Math.max(wa.x + wa.width - left, 640));
    const height = Math.round(Math.max(bounds.height, 480));
    repositionFreecad(left, top, width, height);
  }

  function scheduleSync(): void {
    if (syncTimer) clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      syncTimer = null;
      syncTiling();
    }, 200);
  }

  function ensureWindowBinding(): void {
    if (boundWindow) return;
    const win = windowManager.getMainWindow();
    if (!win || win.isDestroyed()) return;
    boundWindow = win;
    win.on('move', scheduleSync);
    win.on('resize', scheduleSync);
  }

  async function launch(): Promise<FreecadLaunchInfo> {
    ensureWindowBinding();
    if (isFreecadRunning()) {
      // Already running — (re)tile: resize coderix to give FreeCAD at least 1/3,
      // then reposition FreeCAD flush on the right (the snippet also activates it).
      const g = tileForFreecad();
      if (g) repositionFreecad(g.x, g.y, g.w, g.h);
      return { connected: true, launched: false };
    }
    const now = Date.now();
    if (now - lastLaunchAttempt < 10_000) return { connected: false };
    lastLaunchAttempt = now;
    tileForFreecad();
    spawnFreecad();
    // FreeCAD has no `--window-geometry` flag, so retry the flush-right
    // reposition a few times while it starts (RPC comes up after the GUI loads).
    for (const ms of [3_000, 6_000, 10_000]) {
      setTimeout(syncTiling, ms);
    }
    return { connected: false, launched: true };
  }

  ipcMain.handle(FREECAD_PREVIEW_CHANNELS.STATUS, () => status());
  ipcMain.handle(FREECAD_PREVIEW_CHANNELS.PREVIEW, () => preview());
  ipcMain.handle(FREECAD_PREVIEW_CHANNELS.LAUNCH, () => launch());

  return {
    status,
    preview,
    launch,
    destroy(): void {
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = null;
      if (boundWindow && !boundWindow.isDestroyed()) {
        boundWindow.removeListener('move', scheduleSync);
        boundWindow.removeListener('resize', scheduleSync);
      }
      boundWindow = null;
      ipcMain.removeHandler(FREECAD_PREVIEW_CHANNELS.STATUS);
      ipcMain.removeHandler(FREECAD_PREVIEW_CHANNELS.PREVIEW);
      ipcMain.removeHandler(FREECAD_PREVIEW_CHANNELS.LAUNCH);
    },
  };
}
