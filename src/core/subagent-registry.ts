/**
 * SubAgentRegistry — Central in-memory registry for sub-agent lifecycle.
 *
 * Tracks running and completed sub-agents so the main agent can query
 * status via agent-read, stop them via agent-stop, and retrieve results.
 */

import type { Message } from './types.js';

export type SubagentType = 'explore' | 'plan' | 'general-purpose' | 'verification';
export type SubAgentStatus = 'running' | 'done' | 'error' | 'stopped';

export interface SubAgentRecord {
  id: string;
  name: string;
  agentType: SubagentType;
  status: SubAgentStatus;
  prompt: string;
  createdAt: number;
  finishedAt?: number;
  turnCount: number;
  messageCount: number;
  toolCount: number;
  result?: string;
  transcript?: Message[];
  error?: string;
  abortController: AbortController;
}

export class SubAgentRegistry {
  private agents = new Map<string, SubAgentRecord>();
  private _pendingNotifications: string[] = [];
  private _appSyncFn: ((agents: Record<string, SubAgentRecord>) => void) | null = null;

  /** Inject AppState sync for dual-write (Phase 2 bridge). */
  setAppStateSync(syncFn: (record: Record<string, SubAgentRecord>) => void): void {
    this._appSyncFn = syncFn;
    // Sync all existing agents into AppState on bridge attach
    this._flushToAppState();
  }

  private _flushToAppState(): void {
    if (!this._appSyncFn) return;
    const snapshot: Record<string, SubAgentRecord> = {};
    for (const [id, record] of this.agents) {
      snapshot[id] = record;
    }
    this._appSyncFn(snapshot);
  }

  register(record: SubAgentRecord): void {
    this.agents.set(record.id, record);
    this._flushToAppState();
  }

  update(id: string, patch: Partial<SubAgentRecord>): void {
    const existing = this.agents.get(id);
    if (existing) {
      Object.assign(existing, patch);
      this._flushToAppState();
    }
  }

  get(id: string): SubAgentRecord | undefined {
    return this.agents.get(id);
  }

  list(): SubAgentRecord[] {
    return Array.from(this.agents.values());
  }

  listByStatus(status: SubAgentStatus): SubAgentRecord[] {
    return this.list().filter(a => a.status === status);
  }

  abort(id: string): boolean {
    const agent = this.agents.get(id);
    if (!agent || agent.status !== 'running') return false;
    agent.abortController.abort();
    return true;
  }

  abortAll(): void {
    for (const agent of this.agents.values()) {
      if (agent.status === 'running') {
        agent.abortController.abort();
      }
    }
  }

  /** Push a notification for a completed background agent. */
  pushNotification(notification: string): void {
    this._pendingNotifications.push(notification);
  }

  /** Drain and return all pending background agent notifications. */
  drainNotifications(): string[] {
    const drained = this._pendingNotifications;
    this._pendingNotifications = [];
    return drained;
  }
}
