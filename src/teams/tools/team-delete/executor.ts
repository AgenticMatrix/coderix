import type { ToolExecutor } from '../../../tools/types.js';
import { loadTeamConfig, deleteTeam } from '../../team-store.js';

export const execute: ToolExecutor = async (input, _options) => {
  const teamName = input.name as string;

  const config = await loadTeamConfig(teamName);
  if (!config) {
    return {
      content: `Team '${teamName}' does not exist.`,
      isError: true,
    };
  }

  const activeMembers = config.members.filter(m => m.status === 'running');
  if (activeMembers.length > 0) {
    const names = activeMembers.map(m => m.name).join(', ');
    return {
      content: `Cannot delete team '${teamName}' — it still has active members: ${names}. Stop them first with TaskStop.`,
      isError: true,
    };
  }

  await deleteTeam(teamName);

  return {
    content: `Team '${teamName}' deleted.`,
    isError: false,
    metadata: { teamName },
  };
};
