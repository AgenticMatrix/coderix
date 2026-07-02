/**
 * TmuxBackend — tmux pane management for swarm teammates.
 *
 * When inside tmux: splits the current window, leader on left, teammates to the right.
 * When outside tmux: creates a dedicated coderix-swarm session with an isolated socket.
 */

import { execSync } from 'node:child_process';
import { isInsideTmux, getLeaderTmuxPaneId } from './detection.js';
import { SWARM_SESSION_NAME, SWARM_SOCKET_NAME, HIDDEN_SESSION_NAME, PANE_INIT_DELAY } from '../constants.js';
import type { PaneBackend, PaneCreateResult, BackendType } from './types.js';

// Unique ID for this process's swarm socket
const SOCKET_PID = process.pid;

export class TmuxBackend implements PaneBackend {
  readonly type: BackendType = 'tmux';

  private readonly insideTmux: boolean;
  private readonly leaderPaneId: string | undefined;
  private _leaderWindowTarget: string | undefined;
  private teammatePaneIds: string[] = [];
  private paneCreationLock = Promise.resolve();

  constructor() {
    this.insideTmux = isInsideTmux();
    this.leaderPaneId = getLeaderTmuxPaneId();
    this._leaderWindowTarget = undefined; // Cached on first use
  }

  // -----------------------------------------------------------------------
  // PaneBackend implementation
  // -----------------------------------------------------------------------

  async createTeammatePane(displayName: string, _color?: string): Promise<PaneCreateResult> {
    // Serialize pane creation to prevent race conditions
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

  private createPaneInternal(displayName: string): PaneCreateResult {
    if (this.insideTmux && this.leaderPaneId) {
      return this.createPaneInsideTmux(displayName);
    }
    return this.createPaneExternal(displayName);
  }

  private createPaneInsideTmux(displayName: string): PaneCreateResult {
    const windowTarget = this.getLeaderWindowTarget();
    const count = this.teammatePaneIds.length;

    let splitCmd: string;
    if (count === 0) {
      // First teammate: split horizontally from leader
      splitCmd = `tmux split-window -h -t ${this.leaderPaneId} -P -F '#{pane_id}'`;
    } else {
      // Subsequent teammates: alternate split direction from last teammate
      const dir = count % 2 === 1 ? '-v' : '-h';
      splitCmd = `tmux split-window ${dir} -t ${this.teammatePaneIds[count - 1]} -P -F '#{pane_id}'`;
    }

    const paneId = execSync(splitCmd, { encoding: 'utf-8' }).trim();
    this.teammatePaneIds.push(paneId);

    // Set pane title
    execSync(`tmux select-pane -t ${paneId} -T "${displayName}"`, { encoding: 'utf-8' });

    // Evenly rebalance
    try {
      execSync(`tmux select-layout -t ${windowTarget} tiled`, { encoding: 'utf-8' });
    } catch {
      // tiled layout not critical
    }

    return { paneId, windowTarget, insideCurrentSession: true };
  }

  private createPaneExternal(displayName: string): PaneCreateResult {
    const socketName = `${SWARM_SOCKET_NAME}-${SOCKET_PID}`;
    const sessionExists = this.sessionExists(socketName);

    if (!sessionExists) {
      execSync(`tmux -L ${socketName} new-session -d -s ${SWARM_SESSION_NAME} -n ${displayName}`, { encoding: 'utf-8' });
      const paneId = execSync(`tmux -L ${socketName} display-message -p -F '#{pane_id}'`, { encoding: 'utf-8' }).trim();
      this.teammatePaneIds.push(paneId);
      return { paneId, windowTarget: `${SWARM_SESSION_NAME}:0`, insideCurrentSession: false };
    }

    // Session exists: create a new window for this teammate
    const windowIndex = execSync(`tmux -L ${socketName} list-windows -t ${SWARM_SESSION_NAME} -F '#{window_index}'`, { encoding: 'utf-8' }).trim().split('\n').length;
    execSync(`tmux -L ${socketName} new-window -t ${SWARM_SESSION_NAME} -n "${displayName}"`, { encoding: 'utf-8' });
    const paneId = execSync(`tmux -L ${socketName} display-message -p -F '#{pane_id}'`, { encoding: 'utf-8' }).trim();
    this.teammatePaneIds.push(paneId);
    return { paneId, windowTarget: `${SWARM_SESSION_NAME}:${windowIndex}`, insideCurrentSession: false };
  }

  async sendCommandToPane(paneId: string, command: string): Promise<void> {
    if (this.insideTmux) {
      execSync(`tmux send-keys -t ${paneId} "${command.replace(/"/g, '\\"')}" Enter`, { encoding: 'utf-8' });
    } else {
      const socketName = `${SWARM_SOCKET_NAME}-${SOCKET_PID}`;
      execSync(`tmux -L ${socketName} send-keys -t ${paneId} "${command.replace(/"/g, '\\"')}" Enter`, { encoding: 'utf-8' });
    }
  }

  async setPaneBorderColor(paneId: string, color: string): Promise<void> {
    try {
      execSync(`tmux select-pane -t ${paneId} -P 'bg=${color}'`, { encoding: 'utf-8' });
    } catch {
      // Non-critical
    }
  }

  async setPaneTitle(paneId: string, title: string): Promise<void> {
    try {
      execSync(`tmux select-pane -t ${paneId} -T "${title}"`, { encoding: 'utf-8' });
    } catch {
      // Non-critical
    }
  }

  async killPane(paneId: string): Promise<void> {
    try {
      if (this.insideTmux) {
        execSync(`tmux kill-pane -t ${paneId}`, { encoding: 'utf-8' });
      } else {
        const socketName = `${SWARM_SOCKET_NAME}-${SOCKET_PID}`;
        execSync(`tmux -L ${socketName} kill-pane -t ${paneId}`, { encoding: 'utf-8' });
      }
      this.teammatePaneIds = this.teammatePaneIds.filter(id => id !== paneId);
    } catch {
      // Pane already gone
    }
  }

  async hidePane(paneId: string): Promise<boolean> {
    try {
      if (this.insideTmux) {
        // Create hidden session if needed, then break pane into it
        try {
          execSync(`tmux has-session -t ${HIDDEN_SESSION_NAME} 2>/dev/null`, { encoding: 'utf-8' });
        } catch {
          execSync(`tmux new-session -d -s ${HIDDEN_SESSION_NAME}`, { encoding: 'utf-8' });
        }
        execSync(`tmux break-pane -s ${paneId} -t ${HIDDEN_SESSION_NAME}`, { encoding: 'utf-8' });
      } else {
        const socketName = `${SWARM_SOCKET_NAME}-${SOCKET_PID}`;
        try {
          execSync(`tmux -L ${socketName} has-session -t ${HIDDEN_SESSION_NAME} 2>/dev/null`, { encoding: 'utf-8' });
        } catch {
          execSync(`tmux -L ${socketName} new-session -d -s ${HIDDEN_SESSION_NAME}`, { encoding: 'utf-8' });
        }
        execSync(`tmux -L ${socketName} break-pane -s ${paneId} -t ${HIDDEN_SESSION_NAME}`, { encoding: 'utf-8' });
      }
      return true;
    } catch {
      return false;
    }
  }

  async showPane(_paneId: string, _targetWindow: string): Promise<boolean> {
    // Join-pane back is complex and rarely used — stub for now
    return false;
  }

  async rebalancePanes(): Promise<void> {
    try {
      if (this.insideTmux) {
        const target = this.getLeaderWindowTarget();
        execSync(`tmux select-layout -t ${target} tiled`, { encoding: 'utf-8' });
      }
    } catch {
      // Non-critical
    }
  }

  // -----------------------------------------------------------------------
  // Helpers
  // -----------------------------------------------------------------------

  private getLeaderWindowTarget(): string {
    if (!this._leaderWindowTarget) {
      if (this.leaderPaneId) {
        const session = execSync('tmux display-message -p -F "#{session_name}"', { encoding: 'utf-8' }).trim();
        const window = execSync('tmux display-message -p -F "#{window_index}"', { encoding: 'utf-8' }).trim();
        this._leaderWindowTarget = `${session}:${window}`;
      }
    }
    return this._leaderWindowTarget ?? '';
  }

  private sessionExists(socketName: string): boolean {
    try {
      execSync(`tmux -L ${socketName} has-session -t ${SWARM_SESSION_NAME} 2>/dev/null`, { encoding: 'utf-8' });
      return true;
    } catch {
      return false;
    }
  }
}
