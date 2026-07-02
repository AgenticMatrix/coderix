import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskGet',
  description:
    'Retrieve a task by its ID, or query sub-agent status. Returns full task details including subject, description, status, owner, dependencies, and metadata. Use agent_id or list_all to query sub-agents spawned by the Agent tool.',
  input_schema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The ID of the task to retrieve.',
      },
      agent_id: {
        type: 'string',
        description: 'The ID of a sub-agent to query (returned by Agent).',
      },
      list_all: {
        type: 'boolean',
        description: 'If true, list all sub-agents and their statuses.',
      },
    },
  },
  _meta: { riskLevel: 'safe', isConcurrencySafe: true },
};
