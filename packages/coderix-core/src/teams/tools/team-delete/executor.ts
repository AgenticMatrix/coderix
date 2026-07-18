import type { ToolExecutor } from '../../../tools/types.js';
import { loadTeamConfig } from '../../team-store.js';
import { deleteTeam } from '../../team-store.js';
import { deleteTeamMailboxes, sendShutdownRequestToMailbox } from '../../../utils/swarm/teammateMailbox.js';
import { clearTeammateColors } from '../../../utils/swarm/teammateLayoutManager.js';

export const execute: ToolExecutor = async (input, _options) => {
  const teamName = (input.team_name as string) || (input.name as string);

  if (!teamName) {
    return { content: 'Error: team_name is required.', isError: true };
  }

  const config = await loadTeamConfig(teamName);
  if (!config) {
    return {
      content: `Team '${teamName}' does not exist.`,
      isError: true,
    };
  }

  // Collect active members to request shutdown
  const activeMembers = config.members.filter(m => m.status === 'running');

  const shutdownResults: string[] = [];

  if (activeMembers.length > 0) {
    const ids = activeMembers.map(m => `${m.name} (${m.agentId})`).join(', ');
    shutdownResults.push(`Requesting shutdown for ${activeMembers.length} active worker(s): ${ids}`);

    // Send shutdown request to each active member's mailbox
    for (const member of activeMembers) {
      try {
        const result = await sendShutdownRequestToMailbox(
          member.agentId,
          teamName,
          'Team is being deleted',
        );
        shutdownResults.push(`  - Shutdown request sent to '${member.name}' (${result.requestId})`);
      } catch (err) {
        shutdownResults.push(`  - Failed to send shutdown to '${member.name}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Delete team directory (config + inboxes)
  await deleteTeamMailboxes(teamName);
  await deleteTeam(teamName);

  // Clear color assignments
  clearTeammateColors();

  const resultText = [
    `Team '${teamName}' deleted.`,
    shutdownResults.length > 0 ? `\n${shutdownResults.join('\n')}` : '',
  ].filter(Boolean).join('\n');

  return {
    content: resultText,
    isError: false,
    metadata: { teamName },
  };
};
