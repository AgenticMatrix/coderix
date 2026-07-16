/**
 * Teammate initialization — lifecycle hooks for agents running as teammates.
 *
 * Registers hooks that notify the team leader when the teammate becomes idle
 * and applies team-wide permission rules.
 */

import {
  createIdleNotification,
  writeToMailbox,
} from './teammateMailbox.js';
import { getTeammateColor } from './teammate.js';
import { loadTeamFile } from './teamHelpers.js';

/**
 * Initialize hooks for a teammate running in a swarm.
 *
 * Registers a "Stop" hook that sends an idle notification to the team leader
 * when this teammate's session stops.
 */
export async function initializeTeammateHooks(
  teamInfo: {
    teamName: string;
    agentId: string;
    agentName: string;
  },
  /** Hook registration callback — implement in the CLI layer. */
  registerStopHook: (
    fn: () => Promise<void>,
  ) => void,
): Promise<void> {
  const { teamName, agentId, agentName } = teamInfo;

  const teamFile = await loadTeamFile(teamName);
  if (!teamFile) return;

  const leadAgentId = (teamFile as Record<string, unknown>).leadAgentId as string | undefined;
  if (!leadAgentId) return;

  // Apply team-wide allowed paths
  const teamAllowedPaths = (teamFile as Record<string, unknown>).teamAllowedPaths as
    | Array<{ path: string; toolName: string }>
    | undefined;
  // Path permissions applied by the CLI layer

  // Find leader name from members
  const members = (teamFile as Record<string, unknown>).members as
    | Array<{ agentId: string; name: string }>
    | undefined;
  const leadMember = members?.find(m => m.agentId === leadAgentId);
  const leadAgentName = leadMember?.name || 'lead';

  // Don't register hook if this agent IS the leader
  if (agentId === leadAgentId) return;

  // Register Stop hook to notify leader on idle
  registerStopHook(async () => {
    const notification = createIdleNotification(agentName, {
      idleReason: 'available',
    });
    await writeToMailbox(leadAgentName, {
      from: agentName,
      text: JSON.stringify(notification),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    });
  });
}
