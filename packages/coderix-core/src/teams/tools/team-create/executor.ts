import type { ToolExecutor } from '../../../tools/types.js';
import { loadTeamConfig, saveTeamConfig, sanitizeTeamName, teamDir } from '../../team-store.js';
import type { TeamConfig, TeamMember } from '../../types.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

function shortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** Generate a deterministic lead agent ID for the team coordinator. */
function formatLeadAgentId(teamName: string): string {
  return `team-lead@${teamName}`;
}

export const execute: ToolExecutor = async (input, options) => {
  const rawName = input.team_name as string || input.name as string;
  const description = (input.description as string) || '';

  if (!rawName) {
    return { content: 'Error: team_name is required.', isError: true };
  }

  const name = sanitizeTeamName(rawName);
  const leadAgentId = formatLeadAgentId(name);

  const existing = await loadTeamConfig(name);
  if (existing) {
    return {
      content: `Team '${name}' already exists. Use Agent(name: "<member>") to spawn members, or SendMessage to communicate with them.`,
      isError: true,
    };
  }

  // Create inboxes directory for future mailbox use
  const inboxDir = join(teamDir(name), 'inboxes');
  await mkdir(inboxDir, { recursive: true });

  // Create the team lead as first member
  const leadMember: TeamMember = {
    agentId: leadAgentId,
    name: 'lead',
    agentType: 'coordinator',
    status: 'running',
    task: 'Team coordinator',
    joinedAt: Date.now(),
    color: 'cyan',
  };

  const members: TeamMember[] = [leadMember];

  const config: TeamConfig = {
    name,
    description,
    createdAt: Date.now(),
    leadSessionId: options.sessionId,
    members,
  };

  await saveTeamConfig(config);

  return {
    content: [
      `Team '${name}' created with coordinator (lead).`,
      ``,
      `Lead agent ID: \`${leadAgentId}\``,
      ``,
      `Next steps:`,
      `- Spawn workers: Agent(name: "researcher", prompt: "explore the codebase")`,
      `- Send messages: SendMessage(team_name: "${name}", to: "<member>", text: "...")`,
      `- Broadcast: SendMessage(team_name: "${name}", to: "*", text: "...")`,
      `- Monitor: TaskList to check member progress`,
      `- Delete team: TeamDelete(name: "${name}")`,
    ].join('\n'),
    isError: false,
    metadata: { teamName: name, leadAgentId, memberCount: 1 },
  };
};
