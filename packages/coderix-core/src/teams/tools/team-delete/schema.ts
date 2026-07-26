import type { ToolSchema } from '../../../tools/types.js';

export const schema: ToolSchema = {
  name: 'TeamDelete',
  description:
    'ONLY use this tool when the user explicitly asks you to delete a team. '
    + 'NEVER delete a team proactively — even after a test or demo is complete. '
    + 'This tool WILL FAIL unless you set confirmed: true. '
    + 'The confirmed parameter exists to prevent accidental deletion. '
    + 'Deletes the team and all its associated data (config, mailboxes, task lists). '
    + 'The team must not have any active (running) members.',
  input_schema: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'Team name to delete' },
      confirmed: { type: 'boolean', description: 'Must be true to confirm deletion. Set to true ONLY when the user has explicitly asked to delete this team.' },
    },
    required: ['team_name', 'confirmed'],
  },
  _meta: { riskLevel: 'destructive' },
};
