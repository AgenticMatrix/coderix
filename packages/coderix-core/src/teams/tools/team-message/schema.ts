import type { ToolSchema } from '../../../tools/types.js';

export const schema: ToolSchema = {
  name: 'SendMessage',
  description:
    'Send a message to a teammate or resume a completed agent. The system automatically detects the agent\'s state:\n'
    + '- If the agent is running: delivers the message instantly (in-memory) or via inbox.\n'
    + '- If the agent is stopped/done/error: automatically resumes it with full conversation history and text as the new task prompt.\n'
    + '- Use "*" as agent_name to broadcast to all running team members.\n'
    + '- Use "leader" as agent_name to send a message to the team leader.\n'
    + '- Structured messages: provide message_type for shutdown_request or shutdown_response.',
  input_schema: {
    type: 'object',
    properties: {
      agent_name: { type: 'string', description: 'Recipient agent name (e.g. "alice"), "leader" for the team leader, or "*" to broadcast to all workers. If the agent is stopped, it will be automatically resumed with text as the new task.' },
      team_name: { type: 'string', description: 'Team name' },
      text: { type: 'string', description: 'Message content. If the agent is running this is a message; if stopped this becomes the new task prompt.' },
      description: { type: 'string', description: 'Short summary of the message, 3-8 words' },
      from: { type: 'string', description: 'Sender name (defaults to "leader"). When used by a team agent worker, this is automatically set to the agent\'s name.' },
      message_type: {
        type: 'string',
        description: 'Type of structured message: "shutdown_request" or "shutdown_response"',
        enum: ['shutdown_request', 'shutdown_response'],
      },
      reason: { type: 'string', description: 'Reason for shutdown request or rejection' },
      approve: { type: 'boolean', description: 'Whether to approve a shutdown request (for shutdown_response)' },
      request_id: { type: 'string', description: 'Request ID for shutdown_response' },
    },
  },
  _meta: { riskLevel: 'safe' },
};
