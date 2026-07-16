import type { ToolSchema } from '../../../tools/types.js';

export const schema: ToolSchema = {
  name: 'SendMessage',
  description:
    'Send a message to a teammate, broadcast to a whole team, send structured protocol messages (shutdown requests, plan approval), or continue a conversation with a completed sub-agent.\n\n'
    + 'Modes:\n'
    + '1. Team messaging: provide team_name + to + text. Use "*" as recipient to broadcast.\n'
    + '2. Structured messages: provide team_name + to + message_type for shutdown_request or shutdown_response.\n'
    + '3. Sub-agent resume: provide agent_id + message to continue a completed sub-agent\'s work with full context.',
  input_schema: {
    type: 'object',
    properties: {
      team_name: { type: 'string', description: 'Team name (for team messaging mode)' },
      to: { type: 'string', description: 'Recipient name, or "*" to broadcast to all members' },
      text: { type: 'string', description: 'Message content (for plain text messaging)' },
      from: { type: 'string', description: 'Sender name (defaults to "coordinator")' },
      message_type: {
        type: 'string',
        description: 'Type of structured message: "shutdown_request" or "shutdown_response"',
        enum: ['shutdown_request', 'shutdown_response'],
      },
      reason: { type: 'string', description: 'Reason for shutdown request or rejection' },
      approve: { type: 'boolean', description: 'Whether to approve a shutdown request (for shutdown_response)' },
      request_id: { type: 'string', description: 'Request ID for shutdown_response' },
      agent_id: { type: 'string', description: 'ID of a completed sub-agent to resume (for sub-agent resume mode)' },
      message: { type: 'string', description: 'Follow-up message for the sub-agent (for sub-agent resume mode)' },
    },
  },
  _meta: { riskLevel: 'safe' },
};
