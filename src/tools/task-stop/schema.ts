import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskStop',
  description:
    'Stops a running background task by its ID. Use this when you need to terminate a long-running task (bash command, sub-agent, or remote session).',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The ID of the background task to stop',
      },
    },
    required: ['task_id'],
  },
  _meta: { riskLevel: 'mutation' },
};
