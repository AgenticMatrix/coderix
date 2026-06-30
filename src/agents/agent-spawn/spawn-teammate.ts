/**
 * Swarm teammate spawn — Phase 3 backend dispatch.
 *
 * When team_name + name are both present on the Agent tool call,
 * the executor routes here. This stub returns a placeholder result;
 * Phase 3 will fill in the actual tmux/iTerm2/in-process backends.
 */

import type { ToolResult } from '../../tools/types.js';
import type { AgentDefinition, AgentSpawnContext } from '../../core/types.js';
import { addTeamMember, loadTeamConfig } from '../../teams/team-store.js';
import type { TeamMember } from '../../teams/types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeammateSpawnInput {
  teamName: string;
  agentName: string;
  prompt: string;
  model?: string;
  background?: boolean;
  isolation?: 'worktree';
  agentSpawn: AgentSpawnContext;
  agentType: string;
  agentDef: AgentDefinition | null;
  cwd: string;
  sessionId?: string;
}

export interface TeammateSpawnResult {
  agentId: string;
  teamName: string;
  agentName: string;
  backend: 'in-process' | 'tmux' | 'iterm2' | 'stub';
}

// ---------------------------------------------------------------------------
// Stub implementation
// ---------------------------------------------------------------------------

export async function spawnTeammate(
  input: TeammateSpawnInput,
): Promise<ToolResult> {
  const {
    teamName, agentName, prompt, model, agentType,
    agentSpawn, isolation,
  } = input;

  // Load the team config
  const config = await loadTeamConfig(teamName);
  if (!config) {
    return {
      content: `Team '${teamName}' not found. Create it first with TeamCreate, then spawn members via the Agent tool with team_name + name.`,
      isError: true,
    };
  }

  // Check if this member name already exists in the team
  const existing = config.members.find(m => m.name === agentName);
  if (existing && existing.status === 'running') {
    return {
      content: `Team member '${agentName}' is already running in team '${teamName}' (agentId: ${existing.agentId}). Use SendMessage with agent_id=${existing.agentId} to communicate with it.`,
      isError: true,
    };
  }

  // For now, swarm backends (tmux/iTerm2/in-process) are not yet implemented.
  // Phase 3 will add the actual backend dispatch here.
  // We fall back to standard sub-agent spawning with team registration.

  const member: TeamMember = {
    agentId: '',
    name: agentName,
    agentType: input.agentDef?.agentType ?? agentType ?? 'general-purpose',
    model,
    status: 'pending',
    task: prompt,
    joinedAt: Date.now(),
  };

  try {
    await addTeamMember(teamName, member);
  } catch (err) {
    return {
      content: `Failed to register teammate '${agentName}' in team '${teamName}': ${(err as Error).message}`,
      isError: true,
    };
  }

  // TODO (Phase 3): Dispatch to swarm backend (tmux/iTerm2/in-process)
  // For now return a stub that tells the user swarm backends are coming

  const backendHint = process.env.CODERIX_EXPERIMENTAL_AGENT_TEAMS === '1'
    ? 'Swarm backend is enabled experimentally but not yet implemented.'
    : 'Swarm backends (tmux/iTerm2/in-process) are not yet available.';

  return {
    content: [
      `Teammate '${agentName}' registered in team '${teamName}'.`,
      '',
      backendHint,
      '',
      'To spawn this teammate as a standard sub-agent instead, use:',
      `  Agent(agent_type: "${agentType}", prompt: "${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}")`,
      '',
      'Set CODERIX_EXPERIMENTAL_AGENT_TEAMS=1 to enable the swarm backend when available.',
    ].join('\n'),
    isError: false,
    metadata: {
      teamName,
      agentName,
      agentType: agentType,
      backend: 'stub',
    },
  };
}
