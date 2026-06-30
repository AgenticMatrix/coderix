import type { ToolSchema } from '../../../tools/types.js';

export const schema: ToolSchema = {
  name: 'SendMessage',
  description:
    'Send a message to a teammate, broadcast to a whole team, or continue a conversation with a completed sub-agent.\n\n'
    + 'Two modes:\n'
    + '1. Team messaging: provide team_name + to + text. Use "*" as recipient to broadcast.\n'
    + '2. Sub-agent resume: provide agent_id + message to continue a completed sub-agent\'s work with full context.',
  input_schema: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'Team name (for team messaging mode)' },
      to: { type: 'string', description: 'Recipient name, or "*" to broadcast to all members' },
      text: { type: 'string', description: 'Message content (for team messaging mode)' },
      from: { type: 'string', description: 'Sender name (defaults to "coordinator")' },
      agent_id: { type: 'string', description: 'ID of a completed sub-agent to resume (for sub-agent resume mode)' },
      message: { type: 'string', description: 'Follow-up message for the sub-agent (for sub-agent resume mode)' },
    },
  },
  _meta: { riskLevel: 'safe' },
};
