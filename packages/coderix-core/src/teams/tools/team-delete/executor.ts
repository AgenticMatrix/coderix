import type { ToolExecutor } from '../../../tools/types.js';
import { loadTeamConfig } from '../../team-store.js';
import { deleteTeam } from '../../team-store.js';
import { sessionDir as getSessionDir } from '../../../core/session-store.js';
import { deleteTeamMailboxes, sendShutdownRequestToMailbox } from '../../../utils/swarm/teammateMailbox.js';

export const execute: ToolExecutor = async (input, options) => {
  const teamName = (input.team_name as string) || (input.name as string);

  if (!teamName) {
    return { content: 'Error: team_name is required.', isError: true };
  }

  // Hard gate: refuse to delete without explicit confirmation.
  // The prompt-level restriction alone is not enough — LLMs will still
  // proactively clean up after tests.
  if (input.confirmed !== true) {
    return {
      content:
        'TeamDelete requires confirmed: true. '
        + 'Only delete a team when the user explicitly asks you to. '
        + 'If the user has not asked to delete this team, do NOT call this tool.',
      isError: true,
    };
  }

  const sessionId = options.sessionId;
  if (!sessionId) {
    return { content: 'Error: no active session.', isError: true };
  }
  const sd = getSessionDir(sessionId);

  const config = await loadTeamConfig(sd, teamName);
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
          sd,
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
  await deleteTeamMailboxes(sd, teamName);
  await deleteTeam(sd, teamName);

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
