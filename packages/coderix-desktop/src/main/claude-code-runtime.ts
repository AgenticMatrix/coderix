/**
 * claude-code-runtime.ts — on-demand install + resolution of the native
 * Claude Code CLI that `@anthropic-ai/claude-agent-sdk` spawns.
 *
 * The SDK's JS is bundled into the desktop main bundle, but its ~200MB native
 * `claude` binary is not shipped with the package. When the binary is missing
 * (first launch of a packaged app, or an install where the platform
 * optionalDependency didn't land), we install the SDK on demand into a writable
 * runtime dir — mirroring agentstation-app's `~/.agentstation/runtimes/claude-code`
 * (`platform/gateway/src/routes/runtimes.ts`).
 *
 * npm installs use registry failover: probe registry.npmjs.org first; if
 * unreachable (common for users in mainland China) switch to
 * registry.npmmirror.com, and retry once against the mirror on failure.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

// Keep in sync with the `@anthropic-ai/claude-agent-sdk` version pinned in
// packages/coderix-desktop/package.json. The bundled SDK JS and the CLI binary
// must match, so the on-demand install resolves the exact same version.
export const CLAUDE_CODE_SDK_VERSION = '0.3.199';

/** Writable runtime dir the claude-code CLI is installed into (never bundled). */
export const CLAUDE_CODE_INSTALL_DIR = join(
  homedir(),
  '.coderix',
  'runtimes',
  'claude-code',
);

const NPM_DEFAULT_REGISTRY = 'https://registry.npmjs.org';
const NPM_MIRROR_REGISTRY = 'https://registry.npmmirror.com';

/** One in-flight install at a time, shared by boot + engine callers. */
let installPromise: Promise<boolean> | null = null;

/**
 * Locate the native `claude` binary under a claude-code install dir. The binary
 * arrives as the SDK's optionalDependency
 * `@anthropic-ai/claude-agent-sdk-<platform>-<arch>`, exposed under
 * `<installDir>/node_modules/@anthropic-ai/`. Returns null when not installed.
 */
export function findClaudeCodeBinary(installDir: string = CLAUDE_CODE_INSTALL_DIR): string | null {
  const nm = join(installDir, 'node_modules', '@anthropic-ai');
  if (!existsSync(nm)) return null;
  const exe = process.platform === 'win32' ? 'claude.exe' : 'claude';
  try {
    for (const entry of readdirSync(nm, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith('claude-agent-sdk-')) continue;
      const bin = join(nm, entry.name, exe);
      if (existsSync(bin)) return bin;
    }
  } catch {
    /* best-effort */
  }
  return null;
}

/** True when the on-demand claude-code runtime is already installed. */
export function claudeCodeInstalled(): boolean {
  return findClaudeCodeBinary() !== null;
}

/**
 * Installed-state report for the claude-code runtime, mirrored from
 * agentstation-app's `claudeCodeStatus()` (`GET /api/runtimes`). "Installed"
 * means the on-demand dir holds the native `claude` binary — a global `claude`
 * on PATH is intentionally NOT counted, since it isn't the SDK we manage.
 */
export interface ClaudeCodeRuntimeStatus {
  installed: boolean;
  bin: string | null;
  version: string | null;
  installDir: string;
}

export function claudeCodeRuntimeStatus(): ClaudeCodeRuntimeStatus {
  const bin = findClaudeCodeBinary();
  let version: string | null = null;
  if (bin) {
    try {
      const pkg = JSON.parse(
        readFileSync(
          join(CLAUDE_CODE_INSTALL_DIR, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'),
          'utf-8',
        ),
      );
      version = typeof pkg.version === 'string' ? pkg.version : null;
    } catch {
      /* version is best-effort */
    }
  }
  return { installed: bin !== null, bin, version, installDir: CLAUDE_CODE_INSTALL_DIR };
}

async function registryReachable(registry: string, timeoutMs = 5000): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${registry}/-/ping`, { signal: ctrl.signal });
    return res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** `~/.nvm/versions/node/<ver>/bin` dirs, newest first (so the latest Node wins). */
function listNvmBins(home: string): string[] {
  const base = join(home, '.nvm', 'versions', 'node');
  try {
    return readdirSync(base)
      .filter((d) => !d.startsWith('.'))
      .sort()
      .reverse()
      .map((v) => join(base, v, 'bin'));
  } catch {
    return [];
  }
}

/**
 * Resolve an absolute path to `npm` (or `npm.cmd` on Windows). A packaged GUI app
 * launched from Finder has a minimal PATH that omits Node's bin dir (nvm / fnm /
 * `~/.local/bin` / Homebrew), so `spawn('npm')` would fail with ENOENT. Probe PATH
 * entries plus well-known Node locations; fall back to the bare name so a
 * dev/shell-launched app (full PATH) keeps working unchanged.
 */
function resolveNpmExecutable(): string {
  const exe = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(Boolean);

  const extra = process.platform === 'win32'
    ? [
        join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs'),
        join(process.env.APPDATA ?? '', 'npm'),
      ]
    : [
        join(homedir(), '.local', 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        ...listNvmBins(homedir()),
      ];

  for (const dir of [...dirs, ...extra]) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    if (existsSync(candidate)) return candidate;
  }
  return exe;
}

/** Run `npm install` once, resolving to `{ code, stderr }` on completion. */
function runNpmInstall(installDir: string, registry: string): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const npm = resolveNpmExecutable();
    const npmDir = dirname(npm);
    // Prepend npm's dir to PATH so both `npm` and its `#!/usr/bin/env node`
    // shebang resolve even in a packaged GUI app whose PATH lacks Node's bin dir.
    const env = {
      ...process.env,
      PATH: npmDir !== '.' ? [npmDir, process.env.PATH ?? ''].join(delimiter) : process.env.PATH,
    };
    const child = spawn(
      npm,
      [
        'install',
        '--prefix',
        installDir,
        '--no-audit',
        '--no-fund',
        `--registry=${registry}`,
        `@anthropic-ai/claude-agent-sdk@${CLAUDE_CODE_SDK_VERSION}`,
      ],
      { env, stdio: ['ignore', 'pipe', 'pipe'], shell: process.platform === 'win32' },
    );

    let stderr = '';
    child.stdout.on('data', (d: Buffer) => process.stdout.write(d));
    child.stderr.on('data', (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-4000);
      process.stderr.write(d);
    });

    // Bound the install — a cold cache can be slow, but 10 min is generous.
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, 10 * 60 * 1000);

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stderr: `npm failed to start: ${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stderr });
    });
  });
}

/** npm install with registry failover; resolves to the final exit code. */
async function npmInstallWithFailover(installDir: string): Promise<{ code: number; stderr: string }> {
  mkdirSync(installDir, { recursive: true });

  let registry = NPM_DEFAULT_REGISTRY;
  if (!(await registryReachable(NPM_DEFAULT_REGISTRY))) {
    console.log('[claude-code-runtime] npmjs unreachable, switching to mirror', NPM_MIRROR_REGISTRY);
    registry = NPM_MIRROR_REGISTRY;
  }

  console.log('[claude-code-runtime] npm install →', installDir, `(registry ${registry})`);
  let result = await runNpmInstall(installDir, registry);

  if (result.code !== 0 && registry === NPM_DEFAULT_REGISTRY) {
    // 官方源探测通过但安装仍失败（例如中途被墙）→ 清掉半成品，改走镜像重试一次。
    console.log('[claude-code-runtime] install via npmjs failed, retrying via mirror', NPM_MIRROR_REGISTRY);
    rmSync(installDir, { recursive: true, force: true });
    mkdirSync(installDir, { recursive: true });
    result = await runNpmInstall(installDir, NPM_MIRROR_REGISTRY);
  }

  return result;
}

/**
 * Install the claude-code runtime into `~/.coderix/runtimes/claude-code/`.
 * Deduped at the module level: concurrent callers share the same in-flight
 * install instead of each spawning their own `npm install`.
 */
export function installClaudeCode(): Promise<boolean> {
  if (installPromise) return installPromise;
  installPromise = npmInstallWithFailover(CLAUDE_CODE_INSTALL_DIR)
    .then((result) => {
      if (result.code === 0) {
        console.log('[claude-code-runtime] claude-code installed');
        return true;
      }
      console.warn(`[claude-code-runtime] install failed (code ${result.code}):`, result.stderr);
      return false;
    })
    .finally(() => {
      installPromise = null;
    });
  return installPromise;
}

/** Ensure the claude-code runtime is installed; resolves to whether it is now. */
export async function ensureClaudeCodeInstalled(): Promise<boolean> {
  if (claudeCodeInstalled()) return true;
  await installClaudeCode();
  return claudeCodeInstalled();
}

/**
 * Fire-and-forget install on first launch. No-op when already installed or an
 * install is already in flight, so it never blocks startup and never downloads
 * the ~200MB binary twice.
 */
export function autoInstallClaudeCodeOnBoot(): void {
  if (claudeCodeInstalled()) return;
  void ensureClaudeCodeInstalled().then((ok) => {
    if (ok) console.log('[claude-code-runtime] claude-code auto-installed');
    else console.warn('[claude-code-runtime] claude-code auto-install failed');
  });
}
