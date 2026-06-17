import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'enter-plan-mode',
  description:
    'Switch to plan mode. In plan mode, only safe (read-only) tools are allowed — mutation and destructive tools are blocked. Use this to explore the codebase and design solutions without accidentally modifying files.',
  input_schema: {
    type: 'object',
    properties: {},
  },
  _meta: {
    riskLevel: 'safe',
    isConcurrencySafe: true,
  },
};
