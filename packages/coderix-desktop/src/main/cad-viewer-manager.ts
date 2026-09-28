/**
 * CAD Viewer Manager — spawns the self-contained cad-viewer runtime (port 3245)
 * on demand and exposes its lifecycle + URL builder over IPC.
 *
 * The cad-viewer is a standalone SPA + stdlib-Python backend that renders a
 * `.step.py`/`.step`/`.glb` etc. file at `http://127.0.0.1:3245/<abs-dir>?file=<rel>`.
 * This manager mirrors cad_harness's own viewer-manager (spawn `npm --prefix
 * <viewer>/scripts/viewer run start -- ...` and read the JSON launcher line),
 * but exposes it to the Coderix renderer so the "apps" display panel can embed
 * the 3D viewer without running cad_harness's full Node server.
 */

import { ipcMain } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import net from 'node:net';
import type { WindowManager } from './window-manager.js';
import { safeSend } from './safe-send.js';
import {
  resolveCadViewerScriptDir,
  resolveCadPython,
} from './cad-paths.js';

export const CAD_VIEWER_CHANNELS = {
  START: 'cadViewer:start',
  STOP: 'cadViewer:stop',
  STATUS: 'cadViewer:status',
  // Push channel (main → renderer)
  STATUS_CHANGED: 'cadViewer:statusChanged',
} as const;

export type CadViewerStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface CadViewerInfo {
  status: CadViewerStatus;
  port: number;
  baseUrl: string;
  error?: string;
}

export const CAD_VIEWER_HOST = '127.0.0.1';
export const CAD_VIEWER_PORT = 3245;

/** Build the cad-viewer URL for an artifact: path = absolute dir, file= = relative path. */
export function buildViewerUrl(workspaceDir: string, fileRel: string): string {
  const abs = workspaceDir.replace(/\\/g, '/');
  const pathPart = abs.startsWith('/') ? abs : `/${abs}`;
  const base = `http://${CAD_VIEWER_HOST}:${CAD_VIEWER_PORT}${pathPart}`;
  return fileRel ? `${base}?file=${encodeURIComponent(fileRel)}` : base;
}

function isPortOpen(host: string, port: number, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, timeout: timeoutMs });
    let settled = false;
    const done = (open: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

function parseJsonLine(stdout: string): { url?: string; port?: number } | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line.startsWith('{')) {
      try {
        return JSON.parse(line) as { url?: string; port?: number };
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

export interface CadViewerManager {
  start(): Promise<CadViewerInfo>;
  stop(): void;
  status(): Promise<CadViewerInfo>;
  destroy(): void;
}

export function createCadViewerManager(windowManager: WindowManager): CadViewerManager {
  let child: ChildProcess | null = null;
  let status: CadViewerStatus = 'stopped';
  let lastError = '';

  function mainWindow() {
    return windowManager.getMainWindow() ?? null;
  }

  function setStatus(next: CadViewerStatus, error = ''): void {
    status = next;
    lastError = error;
    safeSend(mainWindow(), CAD_VIEWER_CHANNELS.STATUS_CHANGED, { status, error });
  }

  async function getStatus(): Promise<CadViewerInfo> {
    const running = await isPortOpen(CAD_VIEWER_HOST, CAD_VIEWER_PORT);
    const effective: CadViewerStatus = running ? 'running' : status;
    return {
      status: effective,
      port: CAD_VIEWER_PORT,
      baseUrl: `http://${CAD_VIEWER_HOST}:${CAD_VIEWER_PORT}`,
      error: lastError || undefined,
    };
  }

  function stop(): void {
    if (child) {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
      child = null;
    }
    setStatus('stopped');
  }

  async function start(): Promise<CadViewerInfo> {
    // Already up (whether we spawned it or the user did) — reuse it.
    if (await isPortOpen(CAD_VIEWER_HOST, CAD_VIEWER_PORT)) {
      setStatus('running');
      return { status: 'running', port: CAD_VIEWER_PORT, baseUrl: `http://${CAD_VIEWER_HOST}:${CAD_VIEWER_PORT}` };
    }

    const viewerScriptDir = resolveCadViewerScriptDir();
    if (!existsSync(viewerScriptDir)) {
      setStatus('error', 'viewerMissing');
      return { status: 'error', port: CAD_VIEWER_PORT, baseUrl: '', error: 'cad-viewer not found' };
    }

    setStatus('starting');

    const npmCmd = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = [
      '--prefix', viewerScriptDir,
      'run', 'start', '--',
      '--host', CAD_VIEWER_HOST,
      '--port', String(CAD_VIEWER_PORT),
      '--json',
    ];
    const cadPython = resolveCadPython();

    const info = await new Promise<CadViewerInfo>((resolve) => {
      const proc = spawn(npmCmd, args, {
        cwd: viewerScriptDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          ...(cadPython ? { CAD_PYTHON: cadPython, VIEWER_CAD_PYTHON: cadPython } : {}),
        },
      });
      child = proc;

      let stdoutBuf = '';
      let stderrBuf = '';
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          setStatus('error', `cad-viewer startup timed out\n${stderrBuf.slice(-2000)}`);
          resolve({ status: 'error', port: CAD_VIEWER_PORT, baseUrl: '', error: 'startup timed out' });
        }
      }, 60_000);

      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString('utf-8');
        const match = parseJsonLine(stdoutBuf);
        if (match && !settled) {
          settled = true;
          clearTimeout(timer);
          setStatus('running');
          resolve({
            status: 'running',
            port: match.port ?? CAD_VIEWER_PORT,
            baseUrl: match.url ?? `http://${CAD_VIEWER_HOST}:${CAD_VIEWER_PORT}`,
          });
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString('utf-8');
      });
      proc.once('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          setStatus('error', String(err));
          resolve({ status: 'error', port: CAD_VIEWER_PORT, baseUrl: '', error: String(err) });
        }
      });
      proc.once('exit', (code) => {
        if (child === proc) child = null;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          setStatus('error', `cad-viewer exited with code ${code}\n${stderrBuf.slice(-2000)}`);
          resolve({ status: 'error', port: CAD_VIEWER_PORT, baseUrl: '', error: `exited with code ${code}` });
        }
      });
    });

    return info;
  }

  ipcMain.handle(CAD_VIEWER_CHANNELS.START, () => start());
  ipcMain.handle(CAD_VIEWER_CHANNELS.STOP, () => {
    stop();
    return { status: 'stopped' as const, port: CAD_VIEWER_PORT, baseUrl: '' };
  });
  ipcMain.handle(CAD_VIEWER_CHANNELS.STATUS, () => getStatus());

  return {
    start,
    stop,
    status: getStatus,
    destroy(): void {
      stop();
      ipcMain.removeHandler(CAD_VIEWER_CHANNELS.START);
      ipcMain.removeHandler(CAD_VIEWER_CHANNELS.STOP);
      ipcMain.removeHandler(CAD_VIEWER_CHANNELS.STATUS);
    },
  };
}
