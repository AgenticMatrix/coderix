import type { ToolSchema } from '../../tools/types.js';

export const schema: ToolSchema = {
  name: 'agent-message',
  description: `Send a follow-up message to a completed sub-agent to continue the conversation.
The sub-agent resumes with its full previous transcript (tool outputs, findings, context)
plus this new message, so it can build on its prior work.

Use this to:
- Ask a completed sub-agent to elaborate on its findings
- Give a sub-agent a follow-up task related to what it just did
- Correct or redirect a sub-agent's approach

The sub-agent runs with the same tool access and permissions as before.
Use agent-read first to find the agent ID of a completed sub-agent.`,
  input_schema: {
    type: 'object',
    properties: {
      agent_id: {
        type: 'string',
        description: 'The ID of the completed sub-agent to resume. Use agent-read to list agents and find IDs.',
      },
      message: {
        type: 'string',
        description: 'The follow-up message. Be specific about what you want the sub-agent to do next.',
      },
    },
    required: ['agent_id', 'message'],
  },
  _meta: { riskLevel: 'safe' },
};
