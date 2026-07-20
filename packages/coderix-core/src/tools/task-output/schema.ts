import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'TaskOutput',
  description:
    'Retrieves output from a completed background task (shell, agent, or remote session). Blocks until the task completes or times out (default: 15s). Pass the actual shell command as `command` for display.',
  input_schema: {
    type: 'object',
    properties: {
      task_id: {
        type: 'string',
        description: 'The ID of the background task to get output from',
      },
      command: {
        type: 'string',
        description: 'The actual shell command or agent prompt that was executed (not the human-readable description)',
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds (default: 15000, max: 60000)',
        default: 15000,
      },
    },
    required: ['task_id'],
  },
  _meta: { riskLevel: 'safe' },
};
