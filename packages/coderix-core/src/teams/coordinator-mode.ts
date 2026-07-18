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
  teamName: string,
): Promise<string | null> {
  const config = await loadTeamConfig(teamName);
  if (!config) return null;

  return buildTeamContextBlock(config);
}

async function buildTeamContextBlock(config: TeamConfig): Promise<string> {
  const lines: string[] = [
    `# Active Team: ${config.name}`,
    `Description: ${config.description}`,
    '',
    'You are the team leader. Use Agent(name, team_name) to spawn workers,',
    'SendMessage to communicate with them, and TaskGet/TaskList to monitor progress.',
    '',
  ];

  if (config.members.length > 0) {
    lines.push('Workers:');
    for (const m of config.members) {
      const unread = await getUnreadCount(config.name, m.name).catch(() => 0);
      const unreadNote = unread > 0 ? ` (${unread} unread)` : '';
      lines.push(`- ${m.name} (${m.agentType}) [${m.status}]${unreadNote}${m.task ? ` — ${m.task}` : ''}`);
    }
  } else {
    lines.push('No workers yet. Use Agent(name, team_name) to spawn one.');
  }

  return lines.join('\n');
}
