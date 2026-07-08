/**
 * Cross-platform shell auto-detection.
 *
 * On Windows, Git Bash is preferred (bash tools use POSIX syntax),
 * followed by PowerShell 7, PowerShell 5, and cmd.exe as fallback.
 *
 * On macOS / Linux, respects $SHELL and falls back to /bin/sh.
 */

import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { IS_WINDOWS } from './platform.js';

// ── Types ────────────────────────────────────────────────────────────────

export type ShellType = 'git-bash' | 'pwsh' | 'powershell' | 'cmd' | 'sh' | 'zsh' | 'bash';

export interface ShellInfo {
  /** Absolute path to the shell binary. */
  path: string;
  /** High-level shell category for LLM context and feature flags. */
  type: ShellType;
}

// ── Public API ───────────────────────────────────────────────────────────

/** Auto-detect the best available shell for the current platform. */
export function detectShell(): ShellInfo {
  // User override always wins
  if (process.env.SHELL) {
    return classifyShell(process.env.SHELL);
  }
  if (process.env.CODERIX_SHELL) {
    return classifyShell(process.env.CODERIX_SHELL);
  }

  if (!IS_WINDOWS) {
    return { path: '/bin/sh', type: 'sh' };
  }

  // Windows priority: Git Bash > pwsh > PowerShell > cmd
  const gitBash = findGitBash();
  if (gitBash) return { path: gitBash, type: 'git-bash' };

  const pwsh = findInPath('pwsh.exe');
  if (pwsh) return { path: pwsh, type: 'pwsh' };

  const ps = findInPath('powershell.exe');
  if (ps) return { path: ps, type: 'powershell' };

  return { path: process.env.COMSPEC ?? 'cmd.exe', type: 'cmd' };
}

// ── Classification ───────────────────────────────────────────────────────

function classifyShell(raw: string): ShellInfo {
  const normalized = raw.replace(/\\/g, '/');
  const base = normalized.split('/').pop()?.toLowerCase() ?? '';

  if (base === 'zsh')                            return { path: raw, type: 'zsh' };
  if (base.includes('bash'))                     return { path: raw, type: 'bash' };
  if (base === 'pwsh.exe' || base === 'pwsh')   return { path: raw, type: 'pwsh' };
  if (base === 'powershell.exe')                 return { path: raw, type: 'powershell' };
  if (base === 'cmd.exe')                        return { path: raw, type: 'cmd' };
  return { path: raw, type: 'sh' };
}

// ── Discovery helpers ────────────────────────────────────────────────────

function findGitBash(): string | null {
  // Check common installation locations
  const paths = [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }

  // Try via git executable path
  const git = findInPath('git');
  if (git) {
    // git is at Git\cmd\git.exe, bash is at Git\bin\bash.exe
    const { join } = require('node:path');
    const bashPath = join(git, '..', '..', 'bin', 'bash.exe');
    if (existsSync(bashPath)) return bashPath;
  }

  return null;
}

function findInPath(name: string): string | null {
  try {
    const result = execSync(`where.exe ${name}`, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
    return result.split('\r\n')[0] || null;
  } catch {
    return null;
  }
}
