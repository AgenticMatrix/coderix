import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'Sleep',
  description:
    'Pause execution and wait for background tasks to complete. Use this when you have spawned background sub-agents and need to wait for their results. Do NOT poll with TaskGet — just call Sleep and the results will arrive automatically when background agents finish.',
  input_schema: {
    type: 'object',
    properties: {
      duration: {
        type: 'number',
        description: 'Maximum duration to sleep in seconds (1-300). Sleep will wake early if a background agent completes.',
      },
      reason: {
        type: 'string',
        description: 'Optional reason for sleeping (e.g. "waiting for explore agent to finish")',
      },
    },
    required: ['duration'],
  },
  _meta: { riskLevel: 'safe', isConcurrencySafe: true },
};
