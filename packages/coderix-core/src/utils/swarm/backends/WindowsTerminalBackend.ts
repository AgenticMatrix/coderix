/**
 * WindowsTerminalBackend — swarm pane backend powered by Windows Terminal.
 *
 * Uses `wt.exe` (Windows Terminal CLI) to split panes, send commands,
 * and manage layout for team-mode agents. Falls back gracefully when
 * wt.exe is not available (e.g., running in plain CMD or ConEmu).
 *
 * Reference (design only, no code copied):
 *   claude-code-best src/utils/swarm/backends/WindowsTerminalBackend.ts
 */

import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileSync, unlinkSync, existsSync } from 'node:fs';
import type { PaneBackend, PaneCreateResult, BackendType } from './types.js';
import { isInsideWindowsTerminal, getLeaderWtPaneId } from './detection.js';

// ── Helpers ──────────────────────────────────────────────────────────────

/** Check if wt.exe is available (via where.exe, no window flash). */
function wtAvailable(): boolean {
  try {
    execSync('where.exe wt.exe', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

let _available: boolean | null = null;

function isAvailable(): boolean {
  if (_available === null) {
    _available = isInsideWindowsTerminal() && wtAvailable();
  }
  return _available;
}

/**
 * Launch a PowerShell command that writes its PID to a temp file,
 * then returns the file path.  We use this to track the pane's process.
 */
function launchWithPidTracking(
  command: string,
  cwd: string,
  title: string,
): { paneId: string; pidFile: string } {
  const paneId = `wt-pane-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const pidFile = join(tmpdir(), `coderix-wt-pid-${paneId}.txt`);
  // Write PID to a known file so we can kill it later
  writeFileSync(pidFile, '', 'utf-8');

  const psCommand = [
    `$pid | Out-File -FilePath '${pidFile.replace(/\\/g, '\\\\')}'`,
    `Set-Location -LiteralPath '${cwd}'`,
    command,
  ].join('; ');

  // wt.exe new-tab: opens a new tab; split-pane: splits current pane
  execSync(
    `wt.exe split-pane -H -d "${cwd}" --title "${title}" ` +
    `powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "${psCommand}"`,
    { stdio: 'ignore', timeout: 10000 },
  );

  return { paneId, pidFile };
}

// ── Backend ──────────────────────────────────────────────────────────────

export class WindowsTerminalBackend implements PaneBackend {
  readonly type: BackendType = 'windows-terminal';

  private panePids = new Map<string, string>(); // paneId → pidFile

  async createTeammatePane(displayName: string, _color?: string): Promise<PaneCreateResult> {
    if (!isAvailable()) {
      throw new Error('WindowsTerminalBackend: not inside Windows Terminal or wt.exe not found');
    }

    const shellCmd = 'echo "Coderix teammate ready."';
    const { paneId, pidFile } = launchWithPidTracking(
      shellCmd,
      process.cwd(),
      displayName,
    );
    this.panePids.set(paneId, pidFile);

    return {
      paneId,
      windowTarget: getLeaderWtPaneId() ?? '0',
      insideCurrentSession: true,
    };
  }

  async sendCommandToPane(paneId: string, command: string): Promise<void> {
    // wt.exe doesn't support sending commands to an arbitrary pane by ID.
    // Instead, focus the pane and send keystrokes via a temp script.
    // For now, log that this is a best-effort operation.
    try {
      execSync(
        `wt.exe focus-pane --target ${paneId}`,
        { stdio: 'ignore', timeout: 5000 },
      );
      // Write command to clipboard and paste it (Windows Terminal supports Ctrl+V)
      const psScript = `Set-Clipboard -Value '${command.replace(/'/g, "''")}'; Start-Sleep -Milliseconds 200; $wshell = New-Object -ComObject wscript.shell; $wshell.SendKeys('^v~')`;
      execSync(
        `powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "${psScript}"`,
        { stdio: 'ignore', timeout: 5000 },
      );
    } catch {
      // Best-effort: if WT pane operations fail, fall through silently
    }
  }

  async setPaneTitle(paneId: string, title: string): Promise<void> {
    try {
      execSync(
        `wt.exe focus-pane --target ${paneId} --title "${title}"`,
        { stdio: 'ignore', timeout: 3000 },
      );
    } catch { /* best-effort */ }
  }

  async setPaneBorderColor(_paneId: string, _color: string): Promise<void> {
    // Windows Terminal does not support per-pane border colors via CLI.
    // This is a no-op that matches the PaneBackend contract.
  }

  async killPane(paneId: string): Promise<void> {
    const pidFile = this.panePids.get(paneId);
    if (pidFile && existsSync(pidFile)) {
      try {
        const pid = require('node:fs').readFileSync(pidFile, 'utf-8').trim();
        if (pid) {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore', timeout: 5000 });
        }
      } catch {
        // Fallback: try to close the tab
        try {
          execSync(
            `powershell.exe -NoProfile -Command "Get-Process WindowsTerminal | Where-Object { $_.MainWindowTitle -like '*${paneId}*' } | Stop-Process -Force"`,
            { stdio: 'ignore', timeout: 5000 },
          );
        } catch { /* process already gone */ }
      }
      try { unlinkSync(pidFile); } catch { /* already removed */ }
    }
    this.panePids.delete(paneId);
  }

  async hidePane(_paneId: string): Promise<boolean> {
    // Windows Terminal doesn't support hiding panes via CLI
    return false;
  }

  async showPane(_paneId: string, _targetWindow: string): Promise<boolean> {
    // Windows Terminal doesn't support showing hidden panes
    return false;
  }

  async rebalancePanes(): Promise<void> {
    // No equivalent in Windows Terminal CLI
  }
}
