/**
 * Team file helpers — read/write team configuration on disk.
 *
 * Team files are stored at ~/.coderix/teams/{team_name}/team.json
 * Unlike the mailbox, the team file is only written by the leader,
 * so no file locking is needed.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';

// ---------------------------------------------------------------------------
// Types (mirrors teams/types.ts but extends for swarm-specific fields)
// ---------------------------------------------------------------------------

export interface SwarmTeamMember {
  agentId: string;
  name: string;
  agentType: string;
  model?: string;
  color?: string;
  status: 'pending' | 'running' | 'done' | 'error' | 'stopped' | 'idle';
  prompt?: string;
  backendType?: string;
  paneId?: string;
  sessionId?: string;
  worktreePath?: string;
  joinedAt: number;
  finishedAt?: number;
}

export interface SwarmTeamConfig {
  name: string;
  description: string;
  createdAt: number;
  leadAgentId?: string;
  leadSessionId?: string;
  members: SwarmTeamMember[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function teamFilePath(teamName: string): string {
  const sanitized = teamName.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'unnamed';
  return join(homedir(), '.coderix', 'teams', sanitized, 'team.json');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function loadTeamFile(teamName: string): SwarmTeamConfig | null {
  try {
    const path = teamFilePath(teamName);
    if (!existsSync(path)) return null;
    const raw = readFileSync(path, 'utf-8');
    return JSON.parse(raw) as SwarmTeamConfig;
  } catch {
    return null;
  }
}

export function saveTeamFile(config: SwarmTeamConfig): void {
  const path = teamFilePath(config.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf-8');
}

export function addMemberToTeam(
  teamName: string,
  member: SwarmTeamMember,
): SwarmTeamConfig {
  const config = loadTeamFile(teamName);
  if (!config) {
    throw new Error(`Team '${teamName}' not found`);
  }
  // Replace existing member with same name, or append new
  const idx = config.members.findIndex(m => m.name === member.name);
  if (idx >= 0) {
    config.members[idx] = member;
  } else {
    config.members.push(member);
  }
  saveTeamFile(config);
  return config;
}

export function updateMemberInTeam(
  teamName: string,
  agentId: string,
  patch: Partial<SwarmTeamMember>,
): SwarmTeamConfig | null {
  const config = loadTeamFile(teamName);
  if (!config) return null;
  const member = config.members.find(m => m.agentId === agentId);
  if (!member) return null;
  Object.assign(member, patch);
  saveTeamFile(config);
  return config;
}

export function getMemberFromTeam(
  teamName: string,
  agentName: string,
): SwarmTeamMember | null {
  const config = loadTeamFile(teamName);
  if (!config) return null;
  return config.members.find(m => m.name === agentName) ?? null;
}
