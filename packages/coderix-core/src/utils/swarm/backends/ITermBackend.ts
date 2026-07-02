/**
 * ITermBackend — iTerm2 pane management via the it2 CLI.
 *
 * Uses the `it2` Python automation tool to split panes and send commands.
 * Falls back gracefully when it2 is not available.
 */

import { execSync } from 'node:child_process';
import { getLeaderITermSessionId } from './detection.js';
import type { PaneBackend, PaneCreateResult, BackendType } from './types.js';

export class ITermBackend implements PaneBackend {
  readonly type: BackendType = 'iterm2';

  private readonly leaderSessionId: string;
  private teammateSessionIds: string[] = [];
  private paneCreationLock = Promise.resolve();

  constructor() {
    const sessionId = getLeaderITermSessionId();
    if (!sessionId) {
      throw new Error('ITermBackend requires iTerm2 session ID');
    }
    this.leaderSessionId = sessionId;
  }

  // -----------------------------------------------------------------------
  // PaneBackend implementation
  // -----------------------------------------------------------------------

  async createTeammatePane(displayName: string, _color?: string): Promise<PaneCreateResult> {
    const prev = this.paneCreationLock;
    let resolveLock!: () => void;
    this.paneCreationLock = new Promise<void>(r => { resolveLock = r; });

    try {
      await prev;
      return this.createPaneInternal(displayName);
    } finally {
      resolveLock();
    }
  }

  private createPaneInternal(_displayName: string): PaneCreateResult {
    const count = this.teammateSessionIds.length;

    let targetSession: string;
    let splitFlag: string;

    if (count === 0) {
      // First teammate: split vertically from leader
      targetSession = this.leaderSessionId;
      splitFlag = '-v';
    } else {
      // Subsequent: split from last teammate (no direction flag)
      targetSession = this.teammateSessionIds[count - 1];
      splitFlag = '';
    }

    try {
      const cmd = splitFlag
        ? `it2 split-pane ${splitFlag} -s ${targetSession}`
        : `it2 split-pane -s ${targetSession}`;
      const output = execSync(cmd, { encoding: 'utf-8' }).trim();
      // Extract session ID from it2 output (format varies)
      const sessionId = this.extractSessionId(output);
      this.teammateSessionIds.push(sessionId);
      return { paneId: sessionId, windowTarget: 'iterm2', insideCurrentSession: true };
    } catch (err) {
      // At-fault recovery: prune stale sessions and retry
      return this.recoverAndRetry(targetSession, count);
    }
  }

  async sendCommandToPane(paneId: string, command: string): Promise<void> {
    try {
      execSync(`it2 write -s ${paneId} "${command.replace(/"/g, '\\"')}"`, { encoding: 'utf-8' });
      execSync(`it2 send -s ${paneId} return`, { encoding: 'utf-8' });
    } catch {
      // Pane may have been closed
    }
  }

  async setPaneBorderColor(_paneId: string, _color: string): Promise<void> {
    // No-op: each it2 call spawns a Python process, so visual styling is
    // intentionally skipped for performance.
  }

  async setPaneTitle(_paneId: string, _title: string): Promise<void> {
    // No-op: too slow via it2 CLI
  }

  async killPane(paneId: string): Promise<void> {
    try {
      // -f bypasses iTerm2's "Confirm before closing" preference
      execSync(`it2 session close -f -s ${paneId}`, { encoding: 'utf-8' });
    } catch {
      // Already gone
    }
    this.teammateSessionIds = this.teammateSessionIds.filter(id => id !== paneId);
  }

  async hidePane(_paneId: string): Promise<boolean> {
    // Not supported by it2 CLI
    return false;
  }

  async showPane(_paneId: string, _targetWindow: string): Promise<boolean> {
    // Not supported by it2 CLI
    return false;
  }

  async rebalancePanes(): Promise<void> {
    // No-op: too slow via it2 CLI
  }

  // -----------------------------------------------------------------------
  // Recovery
  // -----------------------------------------------------------------------

  private recoverAndRetry(failedTarget: string, count: number): PaneCreateResult {
    // Check if the target session is dead
    try {
      const sessions = execSync('it2 session list', { encoding: 'utf-8' });
      if (!sessions.includes(failedTarget)) {
        // Stale session — prune and retry with the next-to-last
        this.teammateSessionIds = this.teammateSessionIds.filter(id => id !== failedTarget);
        if (this.teammateSessionIds.length > 0) {
          const retryTarget = this.teammateSessionIds[this.teammateSessionIds.length - 1];
          const output = execSync(`it2 split-pane -s ${retryTarget}`, { encoding: 'utf-8' }).trim();
          const sessionId = this.extractSessionId(output);
          this.teammateSessionIds.push(sessionId);
          return { paneId: sessionId, windowTarget: 'iterm2', insideCurrentSession: true };
        }
      }
    } catch {
      // Can't recover — throw original error
    }

    throw new Error(
      `Failed to create iTerm2 pane. The ${count === 0 ? 'leader' : 'teammate'} session may have been closed. ` +
      `Try closing and reopening the iTerm2 window, or use a different backend.`,
    );
  }

  private extractSessionId(output: string): string {
    // it2 outputs the new session ID — try to find it
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        return trimmed;
      }
    }
    return output;
  }
}
