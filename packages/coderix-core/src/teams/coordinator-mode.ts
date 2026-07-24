/**
 * Coordinator mode — activation and system context.
 *
 * When coordinator_mode is enabled (via settings or CODERIX_COORDINATOR env var),
 * the agent uses the 'coordinator' system prompt role, which includes delegation
 * instructions and the agent registry.
 */

import { loadTeamConfig } from './team-store.js';
import { getUnreadCount } from './team-mailbox.js';
import type { CoderSettings } from '../config.js';
import type { TeamConfig } from './types.js';

// ---------------------------------------------------------------------------
// Activation checks
// ---------------------------------------------------------------------------

export function isCoordinatorModeEnabled(settings?: CoderSettings): boolean {
  if (process.env.CODERIX_COORDINATOR === 'true') return true;
  if (process.env.CODERIX_COORDINATOR === '1') return true;
  if (settings?.coordinator_mode === true) return true;
  return false;
}

export function getAgentRole(settings?: CoderSettings): 'default' | 'coordinator' {
  return isCoordinatorModeEnabled(settings) ? 'coordinator' : 'default';
}

// ---------------------------------------------------------------------------
// System context generation
// ---------------------------------------------------------------------------

export async function getCoordinatorSystemContext(
  sessionDir: string,
  teamName: string,
): Promise<string | null> {
  const config = await loadTeamConfig(sessionDir, teamName);
  if (!config) return null;

  return buildTeamContextBlock(sessionDir, config);
}

async function buildTeamContextBlock(sessionDir: string, config: TeamConfig): Promise<string> {
  const lines: string[] = [
    `# Active Team: ${config.name}`,
    `Description: ${config.description}`,
    '',
    'You are the team leader. Use Agent(name, team_name) to spawn workers.',
    '',
    'IMPORTANT — SendMessage addressing:',
    '- Workers are addressed by agentId ONLY (the ID in backticks like `swarm-xxx`). Names will NOT work.',
    '- SendMessage(to: "<agentId>", text: "...") — use the agentId from the worker list below',
    '- SendMessage(to: "*") — broadcast to all workers',
    '- SendMessage(to: "leader") — workers use this to reach you',
    '',
  ];

  if (config.members.length > 0) {
    lines.push('Workers (use the agentId to address them):');
    for (const m of config.members) {
      const unread = await getUnreadCount(sessionDir, config.name, m.agentId).catch(() => 0);
      const unreadNote = unread > 0 ? ` (${unread} unread)` : '';
      lines.push(`- ${m.name} \`${m.agentId}\` [${m.agentType}] [${m.status}]${unreadNote}${m.task ? ` — ${m.task}` : ''}`);
    }
  } else {
    lines.push('No workers yet. Use Agent(name, team_name) to spawn one.');
  }

  return lines.join('\n');
}
