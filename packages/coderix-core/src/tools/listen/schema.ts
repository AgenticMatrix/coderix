import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'Listen',
  description:
    'Listen for background sub-agent completions. Use this when you have spawned background sub-agents and need to wait for their results. Do NOT poll with TaskGet — just call Listen and the results will arrive automatically when background agents finish.',
  input_schema: {
    type: 'object',
    properties: {
      duration: {
        type: 'number',
        description: 'Maximum duration to listen in seconds (1-300). Listen will wake early if a background agent completes.',
      },
      reason: {
        type: 'string',
        description: 'What the sub-agent is working on, e.g. "对 claude-code 项目的调研". Used to construct the status message shown to the user.',
      },
    },
    required: ['duration'],
  },
  _meta: { riskLevel: 'safe', isConcurrencySafe: true },
};
