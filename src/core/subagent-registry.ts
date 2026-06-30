/**
 * SubAgentRegistry — Central in-memory registry for sub-agent lifecycle.
 *
 * Tracks running and completed sub-agents so the main agent can query
 * status via TaskGet, stop them via TaskStop, and retrieve results.
 */

import type { Message } from './types.js';

export type SubagentType = 'explore' | 'plan' | 'general-purpose' | 'verification' | 'coderix-guide' | 'statusline-setup';
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
  /** Prevents duplicate notifications for the same completion event. */
  notified: boolean;
  /** Path to the on-disk output file (written for background agents). */
  outputPath?: string;
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
    record.notified = record.notified ?? false;
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

  /**
   * Build and enqueue a structured <task-notification> for a completed
   * background agent.  Idempotent — a second call for the same agent is
   * silently ignored.
   */
  notifyAgentCompletion(agentId: string): string | null {
    const agent = this.agents.get(agentId);
    if (!agent || agent.notified) return null;

    agent.notified = true;
    this._flushToAppState();

    const elapsed = ((agent.finishedAt ?? Date.now()) - agent.createdAt) / 1000;
    const status = agent.status === 'error' ? 'failed' : agent.status === 'stopped' ? 'killed' : 'completed';

    const lines: string[] = [
      '<task-notification>',
      `  <task_id>${agent.id}</task_id>`,
      `  <agent_type>${agent.agentType}</agent_type>`,
      `  <status>${status}</status>`,
      `  <turns>${agent.turnCount}</turns>`,
      `  <tools_used>${agent.toolCount}</tools_used>`,
      `  <elapsed>${elapsed.toFixed(1)}s</elapsed>`,
    ];

    if (agent.error) {
      lines.push(`  <error>${agent.error}</error>`);
    }

    if (agent.outputPath) {
      lines.push(`  <output_path>${agent.outputPath}</output_path>`);
    }

    if (agent.result) {
      lines.push(`  <result>${agent.result.slice(0, 2000)}</result>`);
    }

    lines.push('</task-notification>');

    const notification = lines.join('\n');
    this._pendingNotifications.push(notification);
    return notification;
  }

  /**
   * @deprecated Use notifyAgentCompletion(agentId) for structured
   * notifications with deduplication.
   */
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
