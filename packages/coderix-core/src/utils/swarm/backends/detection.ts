/**
 * Backend detection — determines which swarm backend is available.
 *
 * Detection runs once at module load and caches results, because environment
 * variables like TMUX may be overwritten at runtime.
 */

// ---------------------------------------------------------------------------
// Raw detection — captured at import time
// ---------------------------------------------------------------------------

/** The TMUX env var as seen at process start, before any tmux socket isolation. */
const ORIGINAL_TMUX = process.env.TMUX || '';

/** Whether the process is running inside a tmux session. */
export function isInsideTmux(): boolean {
  return ORIGINAL_TMUX !== '';
}

/** The leader's tmux pane ID, captured at module load. */
export function getLeaderTmuxPaneId(): string | undefined {
  if (!isInsideTmux()) return undefined;
  // TMUX is formatted as: /tmp/tmux-{uid}/default,{socket},{pid},{session},{window},{pane_id}
  try {
    const parts = ORIGINAL_TMUX.split(',');
    // %-prefixed pane ID is the last comma-separated part, or an env var
    return process.env.TMUX_PANE || parts[5] || undefined;
  } catch {
    return process.env.TMUX_PANE;
  }
}

// ---------------------------------------------------------------------------
// iTerm2 detection
// ---------------------------------------------------------------------------

/** Whether the process is running inside iTerm2. */
export function isInITerm2(): boolean {
  return process.env.TERM_PROGRAM === 'iTerm.app' ||
    process.env.ITERM_SESSION_ID !== undefined;
}

/** The leader's iTerm2 session ID. */
export function getLeaderITermSessionId(): string | undefined {
  if (!isInITerm2()) return undefined;
  return process.env.ITERM_SESSION_ID || undefined;
}

// ---------------------------------------------------------------------------
// Windows Terminal detection
// ---------------------------------------------------------------------------

/** Whether the process is running inside Windows Terminal. */
export function isInsideWindowsTerminal(): boolean {
  return process.platform === 'win32' && !!process.env.WT_SESSION;
}

/** The leader's Windows Terminal session ID. */
export function getLeaderWtPaneId(): string | undefined {
  if (!isInsideWindowsTerminal()) return undefined;
  return process.env.WT_SESSION || undefined;
}

// ---------------------------------------------------------------------------
// Composite detection
// ---------------------------------------------------------------------------

import type { BackendType } from './types.js';

/** Auto-detect the best available backend. */
export function detectBackend(): BackendType {
  if (isInsideTmux()) return 'tmux';
  if (isInITerm2()) return 'iterm2';
  if (isInsideWindowsTerminal()) return 'windows-terminal';
  return 'none';
}

/** Whether any visual pane backend is available. */
export function hasPaneBackend(): boolean {
  return isInsideTmux() || isInITerm2() || isInsideWindowsTerminal();
}

/** Whether the leader pane is inside tmux (not just tmux installed on the system). */
export function isLeaderInsideTmux(): boolean {
  return isInsideTmux();
}
