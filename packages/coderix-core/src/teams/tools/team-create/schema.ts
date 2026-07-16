import type { ToolSchema } from '../../../tools/types.js';

export const schema: ToolSchema = {
  name: 'TeamCreate',
  description:
    'Create a new team for coordinated multi-agent work. A team defines a roster of members with persistent identities. Spawn members via the Agent tool with just a name parameter (the team_name is resolved from context). The team persists in ~/.coderix/teams/ and supports inter-agent messaging via SendMessage.',
  input_schema: {
    type: 'object',
    properties: {
      team_name: {
        type: 'string',
        description: 'Team name (used as a directory name, sanitized automatically)',
      },
      description: {
        type: 'string',
        description: 'Purpose of this team — what problem it should solve',
      },
    },
    required: ['team_name'],
  },
  _meta: { riskLevel: 'safe' },
};
