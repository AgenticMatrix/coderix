import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'exit-plan-mode',
  description:
    'Exit plan mode: write a plan file and request user approval to begin implementation. The plan content is written to ~/.claude/plans/, and the user reviews it before implementation begins. After approval, switches back to auto mode.',
  input_schema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description: 'The full plan content in Markdown format. Include architecture, files to change, implementation steps, and verification approach.',
      },
    },
    required: ['plan'],
  },
  _meta: {
    riskLevel: 'mutation',
    isConcurrencySafe: false,
  },
};
