/**
 * Native Terminal — node-pty based PTY session manager
 *
 * Creates actual PTY sessions via node-pty for the integrated terminal
 * (xterm.js in renderer). Each terminal session runs in its own PTY, with
 * data piped to the renderer via IPC push events.
 *
 * Robustness ported from ZCode's `terminalService.ts`:
 *   - shell / cwd / env resolution with executable + directory validation
 *   - lazy node-pty loading so a missing native module never crashes startup
 *   - macOS spawn-helper permission repair (posix_spawnp failures)
 *   - Windows ConPTY DLL load fallback
 *   - system terminal font/theme inheritance (see terminal-profile.ts)
 */

import { accessSync, chmodSync, constants, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, release } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { IPty } from 'node-pty';
import {
  resolveTerminalFontProfile,
  type TerminalFontFamilySource,
  type TerminalThemeProfile,
} from './terminal-profile.js';

const require = createRequire(import.meta.url);
type NodePtyModule = typeof import('node-pty');
type PtySpawnOptions = Parameters<NodePtyModule['spawn']>[2];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TerminalWindowsPtyInfo {
  backend: 'conpty' | 'winpty';
  buildNumber?: number;
}

export interface TerminalCreateResult {
  id: string;
  shell: string;
  fontFamily: string;
  fontSize?: number;
  theme?: TerminalThemeProfile;
  fontFamilySource: TerminalFontFamilySource;
  windowsPty?: TerminalWindowsPtyInfo;
}

export interface TerminalSessionConfig {
  /** Working directory for the shell. */
  cwd: string;
  /** Initial terminal rows. */
  rows: number;
  /** Initial terminal columns. */
  cols: number;
  /** Shell to use. Defaults to a validated $SHELL / platform default. */
  shell?: string;
  /** Callback when PTY emits data. */
  onData: (data: string) => void;
  /** Callback when PTY process exits. */
  onExit: (exitCode: number) => void;
}

export interface TerminalSession {
  id: string;
  pty: IPty;
  cwd: string;
  createdAt: number;
}

export interface TerminalManager {
  /** Create a new terminal session. */
  create(id: string, config: TerminalSessionConfig): Promise<TerminalCreateResult>;
  /** Write input to a terminal session. */
  write(id: string, data: string): void;
  /** Resize a terminal session. */
  resize(id: string, rows: number, cols: number): void;
  /** Destroy a terminal session. */
  destroy(id: string): void;
  /** Get a terminal session by ID. */
  get(id: string): TerminalSession | undefined;
  /** List all active terminal sessions. */
  list(): TerminalSession[];
  /** Destroy all sessions (cleanup on app quit). */
  destroyAll(): void;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isExecutable(command: string): boolean {
  try {
    if (/[\\/]/.test(command)) {
      accessSync(command, constants.X_OK);
      return true;
    }

    const pathEnv = process.env.PATH;
    if (!pathEnv) return false;

    return pathEnv.split(delimiter).some((dir) => {
      if (!dir) return false;
      try {
        accessSync(join(dir, command), constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

function isUsableDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function parseWindowsBuildNumber(releaseText: string): number | undefined {
  const buildText = releaseText.split('.')[2];
  if (!buildText) return undefined;
  const buildNumber = Number.parseInt(buildText, 10);
  return Number.isFinite(buildNumber) ? buildNumber : undefined;
}

function resolveTerminalWindowsPtyInfo(
  platform: NodeJS.Platform = process.platform,
  releaseText: string = release(),
): TerminalWindowsPtyInfo | undefined {
  if (platform !== 'win32') return undefined;

  return {
    backend: 'conpty',
    buildNumber: parseWindowsBuildNumber(releaseText),
  };
}

function resolveNodePtySpawnHelperPath(): string | null {
  if (process.platform !== 'darwin') return null;

  try {
    const utils = require('node-pty/lib/utils') as {
      loadNativeModule(name: string): { dir: string };
    };
    const native = utils.loadNativeModule('pty');
    const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal.js');

    let helperPath = resolve(dirname(unixTerminalPath), `${native.dir}/spawn-helper`);
    helperPath = helperPath.replace('app.asar', 'app.asar.unpacked');
    helperPath = helperPath.replace('node_modules.asar', 'node_modules.asar.unpacked');
    return helperPath;
  } catch {
    return null;
  }
}

function ensureNodePtySpawnHelperExecutable(hasEnsuredRef: { value: boolean }): void {
  if (hasEnsuredRef.value || process.platform !== 'darwin') return;
  hasEnsuredRef.value = true;

  const helperPath = resolveNodePtySpawnHelperPath();
  if (!helperPath || !existsSync(helperPath)) return;

  try {
    accessSync(helperPath, constants.X_OK);
    return;
  } catch {
    // node-pty's macOS spawn-helper lost its exec bit; child_process.spawn still
    // works, but node-pty invokes this helper when opening a PTY and fails with
    // posix_spawnp. Repair it to 0755 before spawning.
  }

  try {
    chmodSync(helperPath, 0o755);
    accessSync(helperPath, constants.X_OK);
  } catch (error) {
    throw new Error(`node-pty spawn-helper is not executable: ${helperPath}. ${getErrorMessage(error)}`);
  }
}

function shouldFallbackFromConptyDll(error: unknown): boolean {
  const message = getErrorMessage(error);
  return /conpty\.node module handle|conpty\.node module file name|cannot find conpty\.dll|error code:\s*126/i.test(
    message,
  );
}

function isUtf8Locale(value: string | undefined): boolean {
  return /utf-?8/i.test(value ?? '');
}

function isMissingOrCLocale(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toUpperCase();
  return normalized === '' || normalized === 'C' || normalized === 'POSIX';
}

const DARWIN_GUI_FALLBACK_PATHS = [
  '/opt/homebrew/bin',
  '/opt/homebrew/sbin',
  '/usr/local/bin',
  '/usr/local/sbin',
  '/usr/bin',
  '/bin',
  '/usr/sbin',
  '/sbin',
] as const;

function mergePathEntries(entries: readonly (string | undefined)[]): string {
  const seen = new Set<string>();
  const merged: string[] = [];

  for (const value of entries) {
    for (const entry of value?.split(delimiter) ?? []) {
      const trimmed = entry.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      merged.push(trimmed);
    }
  }

  return merged.join(delimiter);
}

function resolveDarwinTerminalPath(env: NodeJS.ProcessEnv): string {
  return mergePathEntries([env.PATH, ...DARWIN_GUI_FALLBACK_PATHS]);
}

function resolveFallbackUtf8Locale(env: NodeJS.ProcessEnv): string {
  const inheritedUtf8Locale = [env.LC_ALL, env.LC_CTYPE, env.LANG].find(isUtf8Locale);
  if (inheritedUtf8Locale) return inheritedUtf8Locale;

  return process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
}

function resolveTerminalEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const nextEnv = { ...env };
  const fallbackLocale = resolveFallbackUtf8Locale(env);

  // macOS GUI launches inherit a narrow PATH (/usr/bin:/bin:...), so npm/node/
  // pnpm go missing in the shell. Only patch the terminal's env, not process.env.
  if (process.platform === 'darwin') {
    nextEnv.PATH = resolveDarwinTerminalPath(env);
  }

  // The runtime's login-shell env probe uses TERM=dumb / CI=1, but a real
  // terminal panel must be an interactive terminal or starship / p10k / color
  // detection degrade to unstyled output.
  nextEnv.TERM = 'xterm-256color';
  nextEnv.COLORTERM = nextEnv.COLORTERM?.trim() || 'truecolor';
  if (nextEnv.CI === '1' && env.TERM === 'dumb') {
    delete nextEnv.CI;
  }

  // GUI-launched hosts may not inherit a UTF-8 locale, so CJK paths render as
  // \M-^ escapes. Only fill in when locale is missing or C/POSIX.
  if (isMissingOrCLocale(nextEnv.LANG)) {
    nextEnv.LANG = fallbackLocale;
  }
  if (isMissingOrCLocale(nextEnv.LC_CTYPE)) {
    nextEnv.LC_CTYPE = fallbackLocale;
  }
  if (nextEnv.LC_ALL !== undefined && isMissingOrCLocale(nextEnv.LC_ALL)) {
    nextEnv.LC_ALL = fallbackLocale;
  }

  return nextEnv;
}

function resolveTerminalShell(): string {
  if (process.platform === 'win32') {
    const candidates = ['pwsh.exe', 'powershell.exe', process.env.ComSpec, 'cmd.exe'];
    for (const candidate of candidates) {
      if (candidate && isExecutable(candidate)) return candidate;
    }
    throw new Error('No usable Windows shell found for terminal startup');
  }

  // Don't trust SHELL blindly — a stale path would be handed to posix_spawnp.
  const candidates = [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'];
  for (const candidate of candidates) {
    if (candidate && isExecutable(candidate)) return candidate;
  }
  throw new Error('No usable shell found for terminal startup');
}

function resolveTerminalCwd(cwd?: string): string {
  // The workspace dir may have been deleted/moved; prefer it, then fall back.
  const candidates = [cwd, process.env.HOME, homedir(), '/'];
  for (const candidate of candidates) {
    if (candidate && isUsableDirectory(candidate)) return candidate;
  }
  throw new Error('No usable working directory found for terminal startup');
}

function spawnTerminalProcess(params: {
  nodePty: NodePtyModule;
  shell: string;
  cols: number;
  rows: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): IPty {
  const { nodePty, shell, cols, rows, cwd, env } = params;

  if (process.platform !== 'win32') {
    return nodePty.spawn(shell, [], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd,
      env,
      encoding: 'utf8',
    });
  }

  const windowsBaseOptions = {
    useConpty: true,
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    encoding: 'utf8',
  } satisfies PtySpawnOptions;

  try {
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: true,
    });
  } catch (error) {
    if (!shouldFallbackFromConptyDll(error)) {
      throw error;
    }

    // Fall back to the system ConPTY when the experimental useConptyDll native
    // module fails to locate conpty.node / conpty.dll at spawn time.
    return nodePty.spawn(shell, [], {
      ...windowsBaseOptions,
      useConptyDll: false,
    });
  }
}

// ---------------------------------------------------------------------------
// createTerminalManager
// ---------------------------------------------------------------------------

// Default profile settings: inherit the system terminal look. A settings-driven
// `terminalFontFamily` override can be wired here later without changing the
// manager's public contract.
const DEFAULT_PROFILE_SETTINGS = {
  terminalFontFamily: undefined,
  terminalInheritSystemProfile: true,
} as const;

export function createTerminalManager(): TerminalManager {
  const sessions = new Map<string, TerminalSession>();
  let nodePtyModulePromise: Promise<NodePtyModule> | null = null;
  const hasEnsuredNodePtyHelper = { value: false };

  async function loadNodePtyModule(): Promise<NodePtyModule> {
    if (!nodePtyModulePromise) {
      nodePtyModulePromise = Promise.resolve()
        .then(() => require('node-pty') as NodePtyModule)
        .catch((error: unknown) => {
          nodePtyModulePromise = null;
          const message = getErrorMessage(error);
          throw new Error(`node-pty is unavailable in this runtime: ${message}`);
        });
    }

    return nodePtyModulePromise;
  }

  return {
    async create(id: string, config: TerminalSessionConfig): Promise<TerminalCreateResult> {
      const nodePty = await loadNodePtyModule();
      ensureNodePtySpawnHelperExecutable(hasEnsuredNodePtyHelper);

      // Clean up any existing session with the same ID
      if (sessions.has(id)) {
        this.destroy(id);
      }

      const shell = config.shell ?? resolveTerminalShell();
      const cwd = resolveTerminalCwd(config.cwd);
      const env = resolveTerminalEnv();
      const fontProfile = resolveTerminalFontProfile({
        settings: DEFAULT_PROFILE_SETTINGS,
        env: process.env,
      });

      let ptyProcess: IPty;
      try {
        ptyProcess = spawnTerminalProcess({
          nodePty,
          shell,
          cols: config.cols,
          rows: config.rows,
          cwd,
          env,
        });
      } catch (error) {
        throw new Error(
          `Failed to start terminal with shell '${shell}' in '${cwd}': ${getErrorMessage(error)}`,
        );
      }

      const session: TerminalSession = {
        id,
        pty: ptyProcess,
        cwd,
        createdAt: Date.now(),
      };

      // Forward PTY output to the renderer
      ptyProcess.onData((data: string) => {
        config.onData(data);
      });

      // Handle process exit
      ptyProcess.onExit(({ exitCode }) => {
        const code = typeof exitCode === 'number' ? exitCode : -1;
        config.onExit(code);
        sessions.delete(id);
      });

      sessions.set(id, session);

      return {
        id,
        shell,
        fontFamily: fontProfile.fontFamily,
        fontSize: fontProfile.fontSize,
        theme: fontProfile.theme,
        fontFamilySource: fontProfile.source,
        windowsPty: resolveTerminalWindowsPtyInfo(),
      };
    },

    write(id: string, data: string): void {
      const session = sessions.get(id);
      if (session) {
        try {
          session.pty.write(data);
        } catch (err) {
          console.error(`[TerminalManager] Write error for session ${id}:`, err);
        }
      }
    },

    resize(id: string, rows: number, cols: number): void {
      const session = sessions.get(id);
      if (session) {
        try {
          session.pty.resize(cols, rows);
        } catch (err) {
          console.error(`[TerminalManager] Resize error for session ${id}:`, err);
        }
      }
    },

    destroy(id: string): void {
      const session = sessions.get(id);
      if (session) {
        try {
          session.pty.kill();
        } catch (err) {
          console.error(`[TerminalManager] Kill error for session ${id}:`, err);
        }
        sessions.delete(id);
      }
    },

    get(id: string): TerminalSession | undefined {
      return sessions.get(id);
    },

    list(): TerminalSession[] {
      return Array.from(sessions.values());
    },

    destroyAll(): void {
      for (const [id, session] of sessions) {
        try {
          session.pty.kill();
        } catch (err) {
          console.error(`[TerminalManager] Kill error for session ${id}:`, err);
        }
      }
      sessions.clear();
    },
  };
}
