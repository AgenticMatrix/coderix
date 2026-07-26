import type { ToolSchema } from '../../../tools/types.js';

export const schema: ToolSchema = {
  name: 'TeamDelete',
  description:
    'ONLY use this tool when the user explicitly asks you to delete a team. '
    + 'NEVER delete a team proactively — even after a test or demo is complete. '
    + 'Deletes the team and all its associated data (config, mailboxes, task lists). '
    + 'The team must not have any active (running) members.',
  input_schema: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'Team name to delete' },
    },
    required: ['team_name'],
  },
  _meta: { riskLevel: 'destructive' },
};
