/**
 * Backend registry — selects the best available swarm backend.
 *
 * Detection priority:
 *   1. CODERIX_TEAMMATE_MODE env var override (tmux / iterm2 / in-process / auto)
 *   2. Inside tmux → TmuxBackend
 *   3. Inside iTerm2 → ITermBackend
 *   4. Default → InProcessBackend (always available)
 */

import { isInsideTmux, isInITerm2, isInsideWindowsTerminal } from './detection.js';
import { TmuxBackend } from './TmuxBackend.js';
import { ITermBackend } from './ITermBackend.js';
import { WindowsTerminalBackend } from './WindowsTerminalBackend.js';
import { InProcessBackend } from './InProcessBackend.js';
import { PaneBackendExecutor } from './PaneBackendExecutor.js';
import type { TeammateExecutor, BackendType } from './types.js';
import type { AgentSpawnContext } from '../../../core/types.js';

// ---------------------------------------------------------------------------
// Teammate mode resolution
// ---------------------------------------------------------------------------

export type TeammateMode = 'tmux' | 'iterm2' | 'windows-terminal' | 'in-process' | 'auto';

/** Resolve the effective teammate mode from env vars. */
export function resolveTeammateMode(): TeammateMode {
  const override = process.env.CODERIX_TEAMMATE_MODE;
  if (override === 'tmux') return 'tmux';
  if (override === 'iterm2') return 'iterm2';
  if (override === 'windows-terminal') return 'windows-terminal';
  if (override === 'in-process') return 'in-process';
  return 'auto';
}

// ---------------------------------------------------------------------------
// Backend selection
// ---------------------------------------------------------------------------

/**
 * Detect and instantiate the best available TeammateExecutor.
 * Always succeeds — in-process is the universal fallback.
 */
export function getTeammateExecutor(
  agentSpawn?: AgentSpawnContext,
): TeammateExecutor {
  const mode = resolveTeammateMode();

  // Explicit override
  if (mode === 'in-process') {
    return new InProcessBackend(agentSpawn);
  }

  if (mode === 'tmux') {
    try {
      return new PaneBackendExecutor(new TmuxBackend());
    } catch {
      return new InProcessBackend(agentSpawn);
    }
  }

  if (mode === 'iterm2') {
    try {
      return new PaneBackendExecutor(new ITermBackend());
    } catch {
      return new InProcessBackend(agentSpawn);
    }
  }

  if (mode === 'windows-terminal') {
    try {
      return new PaneBackendExecutor(new WindowsTerminalBackend());
    } catch {
      return new InProcessBackend(agentSpawn);
    }
  }

  // Auto-detect
  if (isInsideTmux()) {
    try {
      return new PaneBackendExecutor(new TmuxBackend());
    } catch {
      // Fall through to in-process
    }
  }

  if (isInITerm2()) {
    try {
      return new PaneBackendExecutor(new ITermBackend());
    } catch {
      // Fall through to in-process
    }
  }

  if (isInsideWindowsTerminal()) {
    try {
      return new PaneBackendExecutor(new WindowsTerminalBackend());
    } catch {
      // Fall through to in-process
    }
  }

  // Universal fallback
  return new InProcessBackend(agentSpawn);
}

/** Detect the backend type that would be selected (without instantiating). */
export function detectBackendType(): BackendType {
  const mode = resolveTeammateMode();
  if (mode === 'in-process') return 'in-process';
  if (mode === 'tmux') return 'tmux';
  if (mode === 'iterm2') return 'iterm2';
  if (mode === 'windows-terminal') return 'windows-terminal';

  if (isInsideTmux()) return 'tmux';
  if (isInITerm2()) return 'iterm2';
  if (isInsideWindowsTerminal()) return 'windows-terminal';
  return 'in-process';
}
