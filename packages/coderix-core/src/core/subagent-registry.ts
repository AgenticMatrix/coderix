/**
 * SubAgentRegistry — Central in-memory registry for sub-agent lifecycle.
 *
 * Tracks running and completed sub-agents so the main agent can query
 * status via TaskGet, stop them via TaskStop, and retrieve results.
 */

import type { Message } from './types.js';
import type { ToolRequestEvent } from '../state/observable.js';

export type SubagentType = 'explore' | 'plan' | 'general-purpose' | 'verification' | 'coderix-guide' | 'statusline-setup';
export type SubAgentStatus = 'running' | 'done' | 'error' | 'stopped';

export interface SubAgentRecord {
  id: string;
  name: string;
  agentType: SubagentType;
  status: SubAgentStatus;
  prompt: string;
  /** Brief human-readable summary shown in the Agents panel. */
  description?: string;
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
  /** Live tool calls emitted during agent execution (for real-time TUI). */
  liveToolCalls?: Array<{ name: string; input: string; state: string }>;
  /** Anthropic tool_use_id — links this agent to its spawner tool call. */
  toolUseId?: string;
  /** Accumulated token usage (context window consumption) for this agent. */
  tokenUsage?: { inputTokens: number; outputTokens: number; cacheCreationInputTokens?: number; cacheReadInputTokens?: number; totalTokens?: number };
}

export class SubAgentRegistry {
  private agents = new Map<string, SubAgentRecord>();
  private _pendingNotifications: string[] = [];
  private _emitFn: ((req: ToolRequestEvent) => void) | null = null;

  /** Inject an emitter for agent lifecycle events (replaces Phase 2 setAppStateSync). */
  setEmitter(
    emit: (req: ToolRequestEvent) => void,
  ): void {
    this._emitFn = emit;
    // Emit register events for all existing agents
    for (const [id, record] of this.agents) {
      this._emitAgent('agent_register', id, record);
    }
  }

  private _nextReqId(): string {
    return `agent_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  private _emitAgent(type: 'agent_register' | 'agent_update' | 'agent_remove', agentId: string, agent: SubAgentRecord): void {
    if (!this._emitFn) return;
    this._emitFn({
      type,
      agentId,
      agent: agent as unknown as Record<string, unknown>,
      requestId: this._nextReqId(),
    });
  }

  register(record: SubAgentRecord): void {
    record.notified = record.notified ?? false;
    this.agents.set(record.id, record);
    this._emitAgent('agent_register', record.id, record);
  }

  update(id: string, patch: Partial<SubAgentRecord>): void {
    const existing = this.agents.get(id);
    if (existing) {
      Object.assign(existing, patch);
      this._emitAgent('agent_update', existing.id, existing);
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
    this._emitAgent('agent_update', agent.id, agent);

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
      lines.push(`  <result>${agent.result.slice(0, 32000)}</result>`);
    }

    if (agent.tokenUsage) {
      const tu = agent.tokenUsage;
      lines.push('  <token_usage>');
      lines.push(`    <input_tokens>${tu.inputTokens}</input_tokens>`);
      lines.push(`    <output_tokens>${tu.outputTokens}</output_tokens>`);
      if (tu.cacheCreationInputTokens) lines.push(`    <cache_creation_input_tokens>${tu.cacheCreationInputTokens}</cache_creation_input_tokens>`);
      if (tu.cacheReadInputTokens) lines.push(`    <cache_read_input_tokens>${tu.cacheReadInputTokens}</cache_read_input_tokens>`);
      lines.push('  </token_usage>');
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

  /** Non-destructive check: are there pending notifications? */
  hasPendingNotifications(): boolean {
    return this._pendingNotifications.length > 0;
  }
}
