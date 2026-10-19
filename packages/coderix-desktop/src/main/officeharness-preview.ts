/**
 * OfficeHarness preview manager — starts/reuses the OfficeHarness managed host
 * and exposes its workspace URL to the renderer's app display panel.
 *
 * Unlike cad/blender, OfficeHarness is a browser-hosted LibreOffice WASM editor.
 * The plugin ships a `managed-host.cjs` that owns the local HTTP service, the
 * persistent origin, the profile lock and client leases. We call it through
 * `createRequire` (the plugin is CJS) so the desktop does not duplicate any of
 * that lifecycle logic: the MCP server and this preview manager attach to the
 * exact same host and profile.
 *
 * Profile lives at `~/.coderix/officeharness/embedded` (outside the plugin dir)
 * so refreshing the bundled plugin never deletes mounts or source archives.
 */

import { ipcMain } from 'electron';
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readPluginRegistry } from '../../../../packages/coderix-core/src/plugins/registry.js';
import type { WindowManager } from './window-manager.js';
import { safeSend } from './safe-send.js';

export const OFFICE_HARNESS_CHANNELS = {
  START: 'officeHarness:start',
  STOP: 'officeHarness:stop',
  STATUS: 'officeHarness:status',
  // Push channel (main → renderer)
  STATUS_CHANGED: 'officeHarness:statusChanged',
} as const;

export type OfficeHarnessStatus = 'stopped' | 'starting' | 'running' | 'error';

export interface OfficeHarnessInfo {
  status: OfficeHarnessStatus;
  url: string;
  port: number;
  root: string;
  error?: string;
}

interface ManagedHostService {
  url: string;
  port: number;
  pid: number;
  instance_id: string;
}

interface ManagedHostModule {
  ensureHost(opts: {
    profile: string;
    root: string;
    packageRoot: string;
    port: number;
    idleGraceMs?: number;
  }): Promise<ManagedHostService>;
  attachClient(opts: {
    profile: string;
    root: string;
    service: ManagedHostService;
    kind: 'preview';
  }): Promise<{ release(): Promise<void> }>;
}

interface ClientLease {
  release(): Promise<void>;
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The bundled OfficeHarness plugin root: runtime env → registry → dev checkout. */
export function resolveOfficeHarnessRoot(): string {
  const fromEnv = process.env.OFFICEHARNESS_PLUGIN_ROOT?.trim();
  if (fromEnv && existsSync(path.join(fromEnv, 'host', 'managed-service.cjs'))) return fromEnv;

  for (const entry of readPluginRegistry()) {
    const isOfficeHarness = entry.name === 'office-harness' || /officeharness/i.test(path.basename(entry.path));
    if (isOfficeHarness && existsSync(path.join(entry.path, 'host', 'managed-service.cjs'))) return entry.path;
  }

  const fallback =
    process.env.OFFICEHARNESS_SRC?.trim() ??
    path.join(os.homedir(), 'Documents', 'apps', 'OfficeHarness', 'officeharness-v3');
  return fallback;
}

/** Profile shared with the plugin's MCP server (see the plugin's `.env`). */
export function resolveOfficeHarnessProfile(): string {
  return (
    process.env.OFFICEHARNESS_PROFILE_DIR?.trim() ??
    path.join(os.homedir(), '.coderix', 'officeharness', 'embedded')
  );
}

function loadManagedHost(root: string): ManagedHostModule {
  const requireCjs = createRequire(import.meta.url);
  return requireCjs(path.join(root, 'host', 'managed-host.cjs')) as ManagedHostModule;
}

/**
 * Read `connection.json` and verify the live host. Returns null when the file is
 * absent, the process is dead, or the origin/protocol does not match.
 */
async function probeHost(profile: string): Promise<ManagedHostService | null> {
  let metadata: { url?: string; pid?: number; tokenFile?: string; instance_id?: string };
  try {
    metadata = JSON.parse(readFileSync(path.join(profile, 'connection.json'), 'utf8')) as typeof metadata;
  } catch {
    return null;
  }
  if (typeof metadata.url !== 'string' || typeof metadata.tokenFile !== 'string') return null;
  const pid = metadata.pid;
  if (typeof pid !== 'number' || !isAlive(pid)) return null;
  const tokenFile = metadata.tokenFile;

  let url: URL;
  try {
    url = new URL(metadata.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== 'http:' ||
    url.hostname !== '127.0.0.1' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    return null;
  }

  try {
    const token = readFileSync(tokenFile, 'utf8').trim();
    // `/status` is authenticated and tiny; `/capabilities` carries the full tool
    // catalog, so it is reserved for the actual attach handshake.
    const response = await fetch(new URL('/status', url), {
      headers: { 'X-OfficeHarness-Token': token },
      redirect: 'error',
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { online?: boolean; host?: string };
    if (!payload || typeof payload !== 'object') return null;
    return {
      url: url.origin,
      port: Number(url.port),
      pid,
      instance_id: metadata.instance_id ?? '',
    };
  } catch {
    return null;
  }
}

export interface OfficeHarnessManager {
  start(): Promise<OfficeHarnessInfo>;
  stop(): Promise<OfficeHarnessInfo>;
  status(): Promise<OfficeHarnessInfo>;
  destroy(): void;
}

export function createOfficeHarnessManager(windowManager: WindowManager): OfficeHarnessManager {
  let status: OfficeHarnessStatus = 'stopped';
  let current: OfficeHarnessInfo = {
    status: 'stopped',
    url: '',
    port: 0,
    root: resolveOfficeHarnessRoot(),
  };
  let starting: Promise<OfficeHarnessInfo> | null = null;
  let lease: ClientLease | null = null;
  let leasedProfile = '';
  let hostPid = 0;

  function mainWindow() {
    return windowManager.getMainWindow() ?? null;
  }

  function setStatus(next: OfficeHarnessStatus, info: Partial<OfficeHarnessInfo> = {}, error = ''): void {
    status = next;
    current = {
      ...current,
      status: next,
      root: info.root ?? current.root,
      url: info.url ?? (next === 'running' ? current.url : ''),
      port: info.port ?? (next === 'running' ? current.port : 0),
      ...(error ? { error } : { error: undefined }),
    };
    safeSend(mainWindow(), OFFICE_HARNESS_CHANNELS.STATUS_CHANGED, current);
  }

  async function attach(root: string, profile: string, assets: string, service: ManagedHostService): Promise<void> {
    if (lease && leasedProfile === profile) return;
    await releaseLease();
    try {
      const managed = loadManagedHost(root);
      lease = await managed.attachClient({ profile, root: assets, service, kind: 'preview' });
      leasedProfile = profile;
    } catch (error) {
      // The editor page also holds ownership once it registers; a failed lease
      // must not turn a working host into a panel error. It only means the host
      // may idle-close after the panel stops heartbeating.
      console.warn('[OfficeHarness] preview lease failed:', String(error));
    }
  }

  async function releaseLease(): Promise<void> {
    if (!lease) return;
    const held = lease;
    lease = null;
    leasedProfile = '';
    try {
      await held.release();
    } catch {
      // The host may already be closing — the lease is advisory.
    }
  }

  async function getStatus(): Promise<OfficeHarnessInfo> {
    const root = resolveOfficeHarnessRoot();
    const profile = resolveOfficeHarnessProfile();

    if (starting) return current;
    const running = await probeHost(profile);
    if (running) {
      status = 'running';
      hostPid = running.pid;
      current = { status: 'running', url: running.url, port: running.port, root };
      return current;
    }
    if (status === 'running') {
      current = { status: 'stopped', url: '', port: 0, root };
      status = 'stopped';
    }
    return { ...current, root };
  }

  async function start(): Promise<OfficeHarnessInfo> {
    if (starting) return starting;

    starting = (async () => {
      const root = resolveOfficeHarnessRoot();
      const profile = resolveOfficeHarnessProfile();
      const assets = path.join(root, 'host', 'assets');

      const serviceFile = path.join(root, 'host', 'managed-service.cjs');
      if (!existsSync(serviceFile) || !existsSync(path.join(root, 'runtime', 'bin', 'node'))) {
        setStatus('error', { root }, `OfficeHarness plugin not found at ${root}. Run scripts/setup-officeharness-plugin.mjs.`);
        return current;
      }

      setStatus('starting', { root });

      try {
        let service = await probeHost(profile);
        if (!service) {
          const managed = loadManagedHost(root);
          service = await managed.ensureHost({
            profile,
            root: assets,
            packageRoot: root,
            port: 0,
            idleGraceMs: 120_000,
          });
        }
        await attach(root, profile, assets, service);
        hostPid = service.pid;
        setStatus('running', { root, url: service.url, port: service.port });
        return current;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        // A corrupted connection.json is written atomically by the host, so it
        // only appears after manual damage; give the user the exact recovery
        // step instead of surfacing a raw JSON parse error.
        const friendly = /JSON|Unexpected token|Expected property|Unexpected end/i.test(message)
          ? `OfficeHarness connection metadata is unreadable (${path.join(profile, 'connection.json')}). Remove that file and retry.`
          : message;
        setStatus('error', { root }, friendly);
        return current;
      } finally {
        starting = null;
      }
    })();

    return starting;
  }

  async function stop(): Promise<OfficeHarnessInfo> {
    await releaseLease();
    setStatus('stopped', { root: resolveOfficeHarnessRoot() });
    return current;
  }

  ipcMain.handle(OFFICE_HARNESS_CHANNELS.START, () => start());
  ipcMain.handle(OFFICE_HARNESS_CHANNELS.STOP, () => stop());
  ipcMain.handle(OFFICE_HARNESS_CHANNELS.STATUS, () => getStatus());

  return {
    start,
    stop,
    status: getStatus,
    destroy(): void {
      void releaseLease();
      // The host is detached and its editor registration only clears on an
      // explicit native close receipt. The WebContentsView dies with the app,
      // so leaving the host behind would leak a process with a stale editor.
      if (hostPid) {
        try {
          process.kill(hostPid, 'SIGTERM');
        } catch {
          // already exited
        }
        hostPid = 0;
      }
      ipcMain.removeHandler(OFFICE_HARNESS_CHANNELS.START);
      ipcMain.removeHandler(OFFICE_HARNESS_CHANNELS.STOP);
      ipcMain.removeHandler(OFFICE_HARNESS_CHANNELS.STATUS);
    },
  };
}
