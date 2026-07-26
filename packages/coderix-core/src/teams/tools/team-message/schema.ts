import type { ToolSchema } from '../../../tools/types.js';

export const schema: ToolSchema = {
  name: 'SendMessage',
  description:
    'REQUIRED for all inter-agent communication. Your plain text output is NOT visible to teammates — you MUST use this tool to send messages, reply to teammates, report results, or ask questions.\n'
    + '- Running agent: message is delivered instantly and they will see it in their next turn.\n'
    + '- Stopped/done agent: automatically resumes with full history and text as the new task.\n'
    + '- Use "leader" as agent_name to report to the team leader.\n'
    + '- Use "*" as agent_name to broadcast to all running team members.\n'
    + '- ALWAYS reply when a teammate sends you a message — they are waiting for your response.',
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
