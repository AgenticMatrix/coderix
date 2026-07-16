/**
 * Team discovery — scans the filesystem for team data and teammate status.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TEAMS_DIR = join(homedir(), '.coderix', 'teams');

export interface TeammateStatus {
  name: string;
  agentId: string;
  agentType?: string;
  model?: string;
  prompt?: string;
  status: 'running' | 'idle' | 'unknown';
  color?: string;
  tmuxPaneId?: string;
  cwd?: string;
  worktreePath?: string;
  isHidden?: boolean;
  backendType?: string;
  mode?: string;
}

export interface TeamSummary {
  name: string;
  memberCount: number;
  runningCount: number;
  idleCount: number;
}

/** Read a team config file and extract teammate statuses. */
export async function getTeammateStatuses(teamName: string): Promise<TeammateStatus[]> {
  const safeName = teamName.replace(/[^a-zA-Z0-9_-]/g, '-');
  const configPath = join(TEAMS_DIR, safeName, 'config.json');

  try {
    const raw = await readFile(configPath, 'utf-8');
    const config = JSON.parse(raw) as Record<string, unknown>;
    const members = (config.members as Array<Record<string, unknown>>) || [];

    return members.map(m => ({
      name: (m.name as string) || 'unknown',
      agentId: (m.agentId as string) || '',
      agentType: m.agentType as string | undefined,
      model: m.model as string | undefined,
      status: m.isActive ? 'running' : (m.status as TeammateStatus['status']) || 'unknown',
      color: m.color as string | undefined,
      tmuxPaneId: m.tmuxPaneId as string | undefined,
      cwd: m.cwd as string | undefined,
      worktreePath: m.worktreePath as string | undefined,
      isHidden: (m.isHidden as boolean) || false,
      backendType: m.backendType as string | undefined,
      mode: m.mode as string | undefined,
    }));
  } catch {
    return [];
  }
}
