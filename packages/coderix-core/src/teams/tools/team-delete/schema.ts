import type { ToolSchema } from '../../../tools/types.js';

export const schema: ToolSchema = {
  name: 'TeamDelete',
  description:
    'Delete a team and all its associated data (config, mailboxes, task lists). Use this to clean up a team that is no longer needed. The team must not have any active (running) members.',
  input_schema: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'Team name to delete' },
    },
    required: ['team_name'],
  },
  _meta: { riskLevel: 'destructive' },
};
