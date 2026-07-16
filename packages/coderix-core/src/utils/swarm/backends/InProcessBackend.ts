/**
 * InProcessBackend — teammate execution within the leader's Node.js process.
 *
 * Teammates run in the same process but isolated via AsyncLocalStorage.
 * No terminal panes are created. Communication goes through the file-based
 * mailbox (same as pane-based teammates), ensuring uniform behavior.
 *
 * This is the simplest backend — no tmux or iTerm2 required.
 * Enabled by CODERIX_EXPERIMENTAL_AGENT_TEAMS=1 or forced via
 * CODERIX_TEAMMATE_MODE=in-process.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { TeammateExecutor, TeammateSpawnConfig, TeammateSpawnResult, BackendType, BackendInfo } from './types.js';
import { writeToMailbox, clearMailbox } from '../teammateMailbox.js';
import { addMemberToTeam, updateMemberInTeam } from '../teamHelpers.js';
import type { AgentSpawnContext } from '../../../core/types.js';

// ---------------------------------------------------------------------------
// Teammate context (AsyncLocalStorage)
// ---------------------------------------------------------------------------

export interface TeammateContext {
  agentId: string;
  agentName: string;
  teamName: string;
  color?: string;
  abortController: AbortController;
}

const teammateStorage = new AsyncLocalStorage<TeammateContext>();

export function getTeammateContext(): TeammateContext | undefined {
  return teammateStorage.getStore();
}

export function runWithTeammateContext<T>(ctx: TeammateContext, fn: () => T): T {
  return teammateStorage.run(ctx, fn);
}

// ---------------------------------------------------------------------------
// InProcessBackend
// ---------------------------------------------------------------------------

export class InProcessBackend implements TeammateExecutor {
  readonly backend: BackendInfo = {
    type: 'in-process',
    label: 'In-Process',
    hasVisualPanes: false,
  };

  private activeTeammates = new Map<string, { ctx: TeammateContext; taskId?: string }>();

  constructor(private agentSpawn?: AgentSpawnContext) {}

  async spawn(config: TeammateSpawnConfig): Promise<TeammateSpawnResult> {
    const abortController = new AbortController();

    const ctx: TeammateContext = {
      agentId: config.agentId,
      agentName: config.agentName,
      teamName: config.teamName,
      color: config.color,
      abortController,
    };

    this.activeTeammates.set(config.agentId, { ctx });

    // Register in team file
    await addMemberToTeam(config.teamName, {
      agentId: config.agentId,
      name: config.agentName,
      agentType: config.agentType,
      model: config.model,
      color: config.color,
      status: 'running',
      prompt: config.prompt,
      backendType: 'in-process',
      joinedAt: Date.now(),
    });

    // Send initial task to teammate's mailbox
    await writeToMailbox(config.agentName, {
      from: 'lead',
      text: config.prompt,
      timestamp: new Date().toISOString(),
      summary: config.prompt.slice(0, 80),
    }, config.teamName);

    // If we have agentSpawn, register in the registry for TUI visibility
    if (this.agentSpawn) {
      this.agentSpawn.subAgentRegistry.register({
        id: config.agentId,
        name: `${config.agentName} (${config.teamName})`,
        agentType: config.agentType as 'explore' | 'plan' | 'general-purpose',
        status: 'running',
        prompt: config.prompt,
        createdAt: Date.now(),
        turnCount: 0,
        messageCount: 0,
        toolCount: 0,
        abortController,
        notified: false,
      });
    }

    return {
      agentId: config.agentId,
      agentName: config.agentName,
      teamName: config.teamName,
      backend: 'in-process',
    };
  }

  async sendMessage(agentId: string, message: string): Promise<void> {
    const teammate = this.activeTeammates.get(agentId);
    if (!teammate) return;

    await writeToMailbox(teammate.ctx.agentName, {
      from: 'lead',
      text: message,
      timestamp: new Date().toISOString(),
      summary: message.slice(0, 80),
    }, teammate.ctx.teamName);
  }

  async terminate(agentId: string): Promise<void> {
    const teammate = this.activeTeammates.get(agentId);
    if (!teammate) return;

    // Send shutdown request via mailbox
    await writeToMailbox(teammate.ctx.agentName, {
      from: 'lead',
      text: JSON.stringify({ type: 'shutdown_request' }),
      timestamp: new Date().toISOString(),
    }, teammate.ctx.teamName);
  }

  async kill(agentId: string): Promise<void> {
    const teammate = this.activeTeammates.get(agentId);
    if (!teammate) return;

    teammate.ctx.abortController.abort();
    this.activeTeammates.delete(agentId);

    // Clean up mailbox
    try {
      await clearMailbox(teammate.ctx.agentName, teammate.ctx.teamName);
    } catch {
      // Non-fatal
    }

    // Update team file
    await updateMemberInTeam(teammate.ctx.teamName, agentId, {
      status: 'stopped',
      finishedAt: Date.now(),
    });

    // Update registry
    if (this.agentSpawn) {
      this.agentSpawn.subAgentRegistry.update(agentId, {
        status: 'stopped',
        finishedAt: Date.now(),
      });
      this.agentSpawn.subAgentRegistry.notifyAgentCompletion(agentId);
    }
  }

  async isActive(agentId: string): Promise<boolean> {
    const teammate = this.activeTeammates.get(agentId);
    if (!teammate) return false;
    return !teammate.ctx.abortController.signal.aborted;
  }

  /** Get all active teammate IDs. */
  getActiveTeammateIds(): string[] {
    return Array.from(this.activeTeammates.keys());
  }
}
