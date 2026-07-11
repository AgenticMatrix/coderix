import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskGet',
  description:
    'Retrieve a task by its ID, or query sub-agent status. Use this when: you need the full description and context before starting work on a task, to understand what blocks a task and what it blocks, or after being assigned a task to get complete requirements.\n\nReturns full task details: subject, description, status, owner, blocks (tasks waiting on this one), blockedBy (tasks this one waits on). Verify blockedBy is empty before beginning work. Use agent_id or list_all to query sub-agents spawned by the Agent tool.',
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
