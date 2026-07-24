import type { ToolExecutor } from '../../../tools/types.js';
import { loadTeamConfig, saveTeamConfig, sanitizeTeamName, teamDir } from '../../team-store.js';
import { sessionDir as getSessionDir } from '../../../core/session-store.js';
import type { TeamConfig } from '../../types.js';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

export const execute: ToolExecutor = async (input, options) => {
  const rawName = input.team_name as string || input.name as string;
  const description = (input.description as string) || '';

  if (!rawName) {
    return { content: 'Error: team_name is required.', isError: true };
  }

  const name = sanitizeTeamName(rawName);

  const sessionId = options.sessionId;
  if (!sessionId) {
    return { content: 'Error: no active session.', isError: true };
  }
  const sd = getSessionDir(sessionId);

  const existing = await loadTeamConfig(sd, name);
  if (existing) {
    return {
      content: `Team '${name}' already exists. Use TeamAgent(name: "<member>") to spawn members, or SendMessage to communicate with them.`,
      isError: true,
    };
  }

  // Create inboxes directory for future mailbox use
  const inboxDir = join(teamDir(sd, name), 'inboxes');
  await mkdir(inboxDir, { recursive: true });

  const config: TeamConfig = {
    name,
    description,
    createdAt: Date.now(),
    leadSessionId: options.sessionId,
    members: [],
  };

  await saveTeamConfig(sd, config);

  return {
    content: [
      `Team '${name}' created. You are the team leader.`,
      ``,
      `Next steps:`,
      `- Spawn workers: TeamAgent(name: "researcher", team_name: "${name}", prompt: "explore the codebase")`,
      `- Send messages: SendMessage(team_name: "${name}", to: "<member>", text: "...")`,
      `- Broadcast: SendMessage(team_name: "${name}", to: "*", text: "...")`,
      `- Monitor: TaskList to check member progress`,
      `- Delete team: TeamDelete(team_name: "${name}")`,
    ].join('\n'),
    isError: false,
    metadata: { teamName: name, memberCount: 0 },
  };
};
