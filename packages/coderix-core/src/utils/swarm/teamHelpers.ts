/**
 * Swarm team helpers — thin delegation layer over team-store.
 *
 * All swarm code reads/writes the same config.json that TeamCreate manages.
 * Delegates to team-store.ts for all file I/O so there is a single source of
 * truth.
 */

import type { TeamConfig, TeamMember } from '../../teams/types.js';
import {
  loadTeamConfig,
  saveTeamConfig,
  addTeamMember as storeAddMember,
  updateTeamMember as storeUpdateMember,
} from '../../teams/team-store.js';

// ---------------------------------------------------------------------------
// Swarm-extended types (superset of TeamMember)
// ---------------------------------------------------------------------------

export interface SwarmTeamMember extends TeamMember {
  prompt?: string;
  sessionId?: string;
  worktreePath?: string;
  finishedAt?: number;
}

export type SwarmTeamConfig = TeamConfig;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function loadTeamFile(
  sessionDir: string,
  teamName: string,
): Promise<SwarmTeamConfig | null> {
  return loadTeamConfig(sessionDir, teamName);
}

export async function saveTeamFile(
  sessionDir: string,
  config: SwarmTeamConfig,
): Promise<void> {
  await saveTeamConfig(sessionDir, config);
}

export async function addMemberToTeam(
  sessionDir: string,
  teamName: string,
  member: SwarmTeamMember,
): Promise<SwarmTeamConfig> {
  await storeAddMember(sessionDir, teamName, member as TeamMember);
  const updated = await loadTeamConfig(sessionDir, teamName);
  if (!updated) throw new Error(`Team '${teamName}' disappeared after member add`);
  return updated;
}

export async function updateMemberInTeam(
  sessionDir: string,
  teamName: string,
  agentId: string,
  patch: Partial<SwarmTeamMember>,
): Promise<SwarmTeamConfig | null> {
  return storeUpdateMember(sessionDir, teamName, agentId, patch as Partial<TeamMember>);
}

export async function getMemberFromTeam(
  sessionDir: string,
  teamName: string,
  agentName: string,
): Promise<SwarmTeamMember | null> {
  const config = await loadTeamConfig(sessionDir, teamName);
  if (!config) return null;
  const m = config.members.find(m => m.name === agentName);
  return (m as SwarmTeamMember) ?? null;
}
