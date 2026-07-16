/**
 * In-process teammate spawner — creates and registers in-process teammate tasks.
 *
 * In-process teammates run in the same Node.js process using AsyncLocalStorage
 * for context isolation. They are registered as tracked tasks so the TUI can
 * display their status.
 */

import { createTeammateContext, type TeammateContext } from './teammateContext.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeammateIdentity {
  agentId: string;
  agentName: string;
  teamName: string;
  color?: string;
  planModeRequired: boolean;
  parentSessionId: string;
}

export interface InProcessSpawnConfig {
  /** Display name for the teammate, e.g. "researcher" */
  name: string;
  /** Team this teammate belongs to */
  teamName: string;
  /** Initial prompt/task for the teammate */
  prompt: string;
  /** Optional UI color for the teammate */
  color?: string;
  /** Whether teammate must enter plan mode before implementing */
  planModeRequired: boolean;
  /** Optional model override for this teammate */
  model?: string;
  /** Parent session ID */
  parentSessionId: string;
}

export interface InProcessSpawnOutput {
  success: boolean;
  agentId: string;
  taskId?: string;
  abortController?: AbortController;
  teammateContext?: TeammateContext;
  error?: string;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

function generateTaskId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatAgentId(name: string, teamName: string): string {
  return `${name}@${teamName}`;
}

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/**
 * Spawns an in-process teammate.
 *
 * Creates the teammate's context (identity + abort controller) and returns
 * the spawn result. The actual execution is driven by the in-process runner.
 */
export function spawnInProcessTeammate(
  config: InProcessSpawnConfig,
): InProcessSpawnOutput {
  const { name, teamName, prompt, color, planModeRequired, model, parentSessionId } = config;

  const agentId = formatAgentId(name, teamName);
  const taskId = generateTaskId('ip');

  try {
    // Create independent AbortController — teammates survive leader interruption
    const abortController = new AbortController();

    // Create teammate context for AsyncLocalStorage isolation
    const teammateContext = createTeammateContext({
      agentId,
      agentName: name,
      teamName,
      color,
      planModeRequired,
      parentSessionId,
      abortController,
    });

    return {
      success: true,
      agentId,
      taskId,
      abortController,
      teammateContext,
    };
  } catch (error) {
    return {
      success: false,
      agentId,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Kill an in-process teammate by aborting its controller.
 * Returns true if the teammate was running and is now killed.
 */
export function killInProcessTeammate(
  abortController: AbortController,
): boolean {
  if (abortController.signal.aborted) return false;
  abortController.abort();
  return true;
}
