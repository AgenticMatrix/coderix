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
import { TEAM_LEAD_NAME } from './constants.js';

/**
 * Initialize hooks for a teammate running in a swarm.
 *
 * Registers a "Stop" hook that sends an idle notification to the team leader
 * when this teammate's session stops.
 */
export async function initializeTeammateHooks(
  sessionDir: string,
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

  // The main agent is the team leader — don't register hooks for it
  const leadAgentName = TEAM_LEAD_NAME;

  // Register Stop hook to notify leader on idle
  registerStopHook(async () => {
    const notification = createIdleNotification(agentId, {
      idleReason: 'available',
    });
    await writeToMailbox(sessionDir, leadAgentName, {
      from: agentId,
      text: JSON.stringify(notification),
      timestamp: new Date().toISOString(),
      color: getTeammateColor(),
    });
  });
}
