import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskOutput',
  description:
    'Retrieves output from a running or completed background task (shell, agent, or remote session). Use block=true (default) to wait for completion, or block=false for a non-blocking status check.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The ID of the background task to get output from',
      },
      block: {
        type: 'boolean',
        description: 'Whether to wait for the task to complete before returning (default: true)',
        default: true,
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds when block=true (default: 30000, max: 600000)',
        default: 30000,
      },
    },
    required: ['task_id'],
  },
  _meta: { riskLevel: 'safe' },
};
