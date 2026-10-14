/**
 * Blender preview manager — drives the Blender MCP addon's TCP endpoint directly
 * (null-byte-delimited JSON) to render a live preview of the current scene, and
 * exposes that preview (plus connection status) to the renderer over IPC.
 *
 * This mirrors blender-harness's `server/blender-rpc.mjs` (sendCode / pingBlender
 * / renderToPath) and its preview polling, but exposes it to the Coderix renderer
 * so the "apps" display panel can show the live render without running
 * blender-harness's full Node server.
 *
 * Blender is single-instance/single-scene, so the preview is one shared image at
 * `~/.coderix/blender/preview.png`, rendered with a lightweight config (EEVEE +
 * half resolution) to avoid hogging Blender's render thread pool on every poll.
 */

import { ipcMain, screen } from 'electron';
import type { BrowserWindow } from 'electron';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {
  resolveBlenderBin,
  resolveBlenderHost,
  resolveBlenderPort,
  resolveBlenderPreviewPath,
} from './blender-paths.js';
import type { WindowManager } from './window-manager.js';

export const BLENDER_PREVIEW_CHANNELS = {
  STATUS: 'blender:status',
  PREVIEW: 'blender:preview',
  LAUNCH: 'blender:launch',
} as const;

export interface BlenderStatusInfo {
  connected: boolean;
}

export interface BlenderPreviewInfo {
  connected: boolean;
  /** Base64-encoded PNG of the last render, present only when connected. */
  png?: string;
}

export interface BlenderLaunchInfo {
  connected: boolean;
  /** True when this call actually spawned a new Blender process. */
  launched?: boolean;
}

interface BlenderResponse {
  status?: string;
  result?: { filepath?: string } & Record<string, unknown>;
  message?: string;
  stderr?: string;
}

/**
 * Send a snippet of Python to the Blender addon and resolve the parsed response.
 * Protocol: null-byte-delimited JSON — `{"type":"execute","code":…,"strict_json":true}\0`.
 */
function sendCode(
  host: string,
  port: number,
  code: string,
  strictJson = true,
  timeoutMs = 30_000,
): Promise<BlenderResponse> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let buffer = Buffer.alloc(0);
    let settled = false;

    const request = JSON.stringify({ type: 'execute', code, strict_json: strictJson }) + '\0';

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(err);
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, host, () => socket.write(request));

    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      let idx: number;
      while ((idx = buffer.indexOf(0)) !== -1) {
        const raw = buffer.subarray(0, idx).toString('utf-8');
        buffer = buffer.subarray(idx + 1);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          fail(new Error(`Blender returned non-JSON data: ${raw.slice(0, 200)}`));
          return;
        }
        if (settled) continue;
        settled = true;
        socket.destroy();
        resolve(parsed as BlenderResponse);
      }
    });

    socket.on('error', fail);
    socket.on('timeout', () => fail(new Error(`Blender socket timed out (${timeoutMs}ms)`)));
  });
}

/** Probe whether the Blender addon is reachable (swallows errors, for status). */
async function pingBlender(host: string, port: number): Promise<boolean> {
  try {
    const r = await sendCode(host, port, 'result = {"pong": True}', true, 5_000);
    return Boolean(r && r.status === 'ok');
  } catch {
    return false;
  }
}

/**
 * Render the current Blender scene to `outputPath` (PNG). Forces EEVEE + 50%
 * resolution and ensures a camera exists, mirroring blender-harness's
 * `renderToPath`. Returns the output path on success.
 */
async function renderToPath(host: string, port: number, outputPath: string, timeoutMs = 120_000): Promise<string> {
  const code = [
    'import bpy, os',
    'scene = bpy.context.scene',
    `out = ${JSON.stringify(outputPath)}`,
    "os.makedirs(os.path.dirname(out), exist_ok=True)",
    'if scene.camera is None:',
    '    cams = [o for o in scene.objects if o.type == "CAMERA"]',
    '    if cams:',
    '        scene.camera = cams[0]',
    '    else:',
    '        bpy.ops.object.camera_add()',
    '        scene.camera = bpy.context.active_object',
    'rd = scene.render',
    "rd.engine = 'BLENDER_EEVEE'",
    'rd.resolution_percentage = 50',
    "rd.filepath = out",
    "rd.image_settings.file_format = 'PNG'",
    'bpy.ops.render.render(write_still=True)',
    'result = {"status": "ok", "filepath": out}',
  ].join('\n');

  const r = await sendCode(host, port, code, true, timeoutMs);
  if (r && r.status === 'ok') return r.result?.filepath || outputPath;
  throw new Error(r?.message || r?.stderr || 'render failed');
}

export interface BlenderPreviewManager {
  status(): Promise<BlenderStatusInfo>;
  preview(): Promise<BlenderPreviewInfo>;
  launch(): Promise<BlenderLaunchInfo>;
  destroy(): void;
}

export function createBlenderPreviewManager(windowManager: WindowManager): BlenderPreviewManager {
  const host = resolveBlenderHost();
  const port = resolveBlenderPort();
  const previewPath = resolveBlenderPreviewPath();

  // Render mutex — a render is blocking (write_still=True), so skip a poll
  // while the previous one is still in flight to avoid stacking renders.
  let renderInFlight = false;

  async function status(): Promise<BlenderStatusInfo> {
    return { connected: await pingBlender(host, port) };
  }

  async function preview(): Promise<BlenderPreviewInfo> {
    if (renderInFlight) {
      // A render is already running — report the last frame (if any) instead.
      const last = readPreview();
      return last ? { connected: true, png: last } : { connected: false };
    }
    renderInFlight = true;
    try {
      await renderToPath(host, port, previewPath);
      const png = readPreview();
      return png ? { connected: true, png } : { connected: false };
    } catch {
      return { connected: false };
    } finally {
      renderInFlight = false;
    }
  }

  function readPreview(): string | undefined {
    if (!existsSync(previewPath)) return undefined;
    try {
      mkdirSync(path.dirname(previewPath), { recursive: true });
      return readFileSync(previewPath).toString('base64');
    } catch {
      return undefined;
    }
  }

  // ── Auto-launch Blender ──────────────────────────────────────────────
  // When the renderer's "Open Blender" nav button is clicked, it calls `launch()`
  // so Blender starts automatically (tiled to the right) — the user no longer has
  // to open it by hand. Guarded so we never spawn duplicates: skip when the addon
  // is already reachable, when a Blender process is running, or within 10s of a
  // previous attempt (covers Blender's startup latency).

  let lastLaunchAttempt = 0;

  /** True when a Blender GUI process (not the blender-mcp server) is running. */
  function isBlenderRunning(): boolean {
    for (const name of ['Blender', 'blender']) {
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
   * of the width for Blender on the right), and return Blender's target geometry
   * as `(x, y, w, h)` where `(x, y)` is the BOTTOM-LEFT corner in AppKit points.
   * Returns null when the coderix window isn't available.
   */
  function tileForBlender(): { x: number; y: number; w: number; h: number } | null {
    const win = windowManager.getMainWindow();
    if (!win || win.isDestroyed()) return null;
    const display = screen.getDisplayMatching(win.getBounds());
    const wa = display.workArea;

    // Blender gets at least 1/3 of the usable width; coderix keeps the rest.
    const blenderWidth = Math.max(Math.floor(wa.width / 3), 480);
    const coderixWidth = Math.max(wa.width - blenderWidth, 640);
    try {
      win.setBounds({ x: wa.x, y: wa.y, width: coderixWidth, height: wa.height });
    } catch {
      // Resizing coderix is best-effort — still tile Blender on the right.
    }

    const left = wa.x + coderixWidth;
    const top = wa.y;
    const height = wa.height;
    const bottom = Math.round(display.bounds.y + display.bounds.height - (top + height));
    return { x: left, y: bottom, w: blenderWidth, h: height };
  }

  /** `--window-geometry` args for launching Blender tiled on the right. */
  function windowGeometryArgs(): string[] {
    const g = tileForBlender();
    if (!g) return [];
    return ['--window-geometry', String(g.x), String(g.y), String(g.w), String(g.h)];
  }

  function spawnBlender(): void {
    const bin = resolveBlenderBin();
    const args = [...windowGeometryArgs(), '--online-mode'];
    try {
      const child = spawn(bin, args, { detached: true, stdio: 'ignore' });
      child.unref();
      console.log(`[BlenderPreview] launched Blender: ${bin} ${args.join(' ')}`);
    } catch (err) {
      console.warn('[BlenderPreview] failed to launch Blender:', err instanceof Error ? err.message : err);
    }
  }

  // ── Keep Blender adjacent on coderix move/resize ─────────────────────
  // When the user drags/resizes the coderix window, reposition Blender's window
  // to stay flush on coderix's right. Done from *inside* Blender (a `ctypes`
  // call to the macOS Objective-C runtime repositions its own window), so no
  // Accessibility permission is needed — unlike AppleScript. arm64-only.

  let boundWindow: BrowserWindow | null = null;
  let syncTimer: ReturnType<typeof setTimeout> | null = null;

  /** Reposition Blender's own window via ctypes/ObjC. `(x, y)` is the BOTTOM-LEFT
   *  corner in AppKit points (matches NSWindow.setFrame:display:). */
  function repositionBlender(x: number, y: number, w: number, h: number): void {
    const code = [
      'import ctypes, ctypes.util',
      'try:',
      '    objc = ctypes.cdll.LoadLibrary(ctypes.util.find_library("objc"))',
      '    objc.objc_getClass.restype = ctypes.c_void_p',
      '    objc.objc_getClass.argtypes = [ctypes.c_char_p]',
      '    objc.sel_registerName.restype = ctypes.c_void_p',
      '    objc.sel_registerName.argtypes = [ctypes.c_char_p]',
      '    class NSRect(ctypes.Structure):',
      '        _fields_ = [("x", ctypes.c_double), ("y", ctypes.c_double), ("w", ctypes.c_double), ("h", ctypes.c_double)]',
      '    NSApp = objc.objc_getClass(b"NSApplication")',
      '    objc.objc_msgSend.restype = ctypes.c_void_p',
      '    objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p]',
      '    app = objc.objc_msgSend(NSApp, objc.sel_registerName(b"sharedApplication"))',
      '    win = objc.objc_msgSend(app, objc.sel_registerName(b"mainWindow"))',
      '    if not win:',
      '        wins = objc.objc_msgSend(app, objc.sel_registerName(b"windows"))',
      '        objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_uint64]',
      '        win = objc.objc_msgSend(wins, objc.sel_registerName(b"objectAtIndex:"), 0)',
      '    if win:',
      `        rect = NSRect(${x}, ${y}, ${w}, ${h})`,
      '        objc.objc_msgSend.restype = None',
      '        objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_int]',
      '        objc.objc_msgSend(app, objc.sel_registerName(b"activateIgnoringOtherApps:"), 1)',
      '        objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]',
      '        objc.objc_msgSend(win, objc.sel_registerName(b"deminiaturize:"), 0)',
      '        objc.objc_msgSend.argtypes = [ctypes.c_void_p, ctypes.c_void_p, NSRect, ctypes.c_int]',
      '        objc.objc_msgSend(win, objc.sel_registerName(b"setFrame:display:"), rect, 1)',
      '        result = {"status": "ok"}',
      '    else:',
      '        result = {"status": "error", "message": "no window"}',
      'except Exception as e:',
      '    result = {"status": "error", "message": str(e)}',
    ].join('\n');
    void sendCode(host, port, code, true, 5_000).catch(() => {
      // Blender addon unreachable — ignore (window simply stays put).
    });
  }

  function syncTiling(): void {
    if (!isBlenderRunning()) return;
    const win = windowManager.getMainWindow();
    if (!win || win.isDestroyed()) return;
    const bounds = win.getBounds();
    const display = screen.getDisplayMatching(bounds);
    const wa = display.workArea;
    const left = Math.round(bounds.x + bounds.width);
    const top = Math.round(bounds.y);
    const width = Math.round(Math.max(wa.x + wa.width - left, 640));
    const height = Math.round(Math.max(bounds.height, 480));
    // AppKit window origin is bottom-left, so flip Electron's top-left `top`.
    const bottom = Math.round(display.bounds.y + display.bounds.height - (top + height));
    repositionBlender(left, bottom, width, height);
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

  /** Bring Blender to the front. `activate` is a plain Apple event (no Accessibility). */
  function activateBlender(): void {
    execFile('osascript', ['-e', 'tell application "Blender" to activate'], () => {
      // best-effort — ignore failures (e.g. Blender not launched yet)
    });
  }

  async function launch(): Promise<BlenderLaunchInfo> {
    ensureWindowBinding();
    if (isBlenderRunning()) {
      // Already running — bring it to front and (re)tile: resize coderix to give
      // Blender at least 1/3, then reposition Blender flush on the right.
      activateBlender();
      const g = tileForBlender();
      if (g) repositionBlender(g.x, g.y, g.w, g.h);
      return { connected: true, launched: false };
    }
    const now = Date.now();
    if (now - lastLaunchAttempt < 10_000) return { connected: false };
    lastLaunchAttempt = now;
    spawnBlender();
    // Bring it to the front once it has finished starting.
    setTimeout(activateBlender, 1_500);
    return { connected: false, launched: true };
  }

  ipcMain.handle(BLENDER_PREVIEW_CHANNELS.STATUS, () => status());
  ipcMain.handle(BLENDER_PREVIEW_CHANNELS.PREVIEW, () => preview());
  ipcMain.handle(BLENDER_PREVIEW_CHANNELS.LAUNCH, () => launch());

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
      ipcMain.removeHandler(BLENDER_PREVIEW_CHANNELS.STATUS);
      ipcMain.removeHandler(BLENDER_PREVIEW_CHANNELS.PREVIEW);
      ipcMain.removeHandler(BLENDER_PREVIEW_CHANNELS.LAUNCH);
    },
  };
}
