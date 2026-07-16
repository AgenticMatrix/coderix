/**
 * Swarm reconnection module — handles initialization of swarm context
 * for both fresh spawns (from CLI args) and resumed sessions (from stored metadata).
 */

import { getDynamicTeamContext } from './teammate.js';
import { loadTeamFile } from './teamHelpers.js';
import { teamDir } from '../../teams/team-store.js';
import { join } from 'node:path';

/** Team context shape used in AppState. */
export interface TeamContextState {
  teamName: string;
  teamFilePath: string;
  leadAgentId: string;
  selfAgentId?: string;
  selfAgentName?: string;
  isLeader?: boolean;
  teammates: Record<string, {
    name: string;
    agentType?: string;
    color?: string;
    tmuxSessionName?: string;
    tmuxPaneId?: string;
    cwd?: string;
    worktreePath?: string;
    spawnedAt: number;
  }>;
}

/**
 * Computes the initial teamContext for AppState on startup.
 * Called asynchronously before the first render.
 */
export async function computeInitialTeamContext(): Promise<TeamContextState | undefined> {
  const context = getDynamicTeamContext();
  if (!context?.teamName || !context?.agentName) return undefined;

  const { teamName, agentId, agentName } = context;
  const teamFile = await loadTeamFile(teamName);
  if (!teamFile) return undefined;

  const teamFilePath = join(teamDir(teamName), 'config.json');
  const filed = teamFile as Record<string, unknown>;
  const isLeader = !agentId;

  return {
    teamName,
    teamFilePath,
    leadAgentId: filed.leadAgentId as string,
    selfAgentId: agentId,
    selfAgentName: agentName,
    isLeader,
    teammates: {},
  };
}

/**
 * Initialize teammate context from a resumed session.
 * Called when resuming a session that has teamName/agentName in its transcript.
 */
export async function initializeTeammateContextFromSession(
  teamName: string,
  agentName: string,
): Promise<TeamContextState | undefined> {
  const teamFile = await loadTeamFile(teamName);
  if (!teamFile) return undefined;

  const filed = teamFile as Record<string, unknown>;
  const members = filed.members as Array<{ name: string; agentId: string }> | undefined;
  const member = members?.find(m => m.name === agentName);
  const agentId = member?.agentId;
  const teamFilePath = join(teamDir(teamName), 'config.json');

  return {
    teamName,
    teamFilePath,
    leadAgentId: filed.leadAgentId as string,
    selfAgentId: agentId,
    selfAgentName: agentName,
    isLeader: false,
    teammates: {},
  };
}
