import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'ExitPlanMode',
  description:
    'Exit plan mode: present your plan for user approval. The plan is read from the plan file on disk — you should have already written it there. After approval, switches back to the previous permission mode and implementation can begin.\n\n' +
    'Use allowedPrompts to request prompt-based permissions for Bash operations needed during implementation (e.g. "run tests", "install dependencies").',
  input_schema: {
    type: 'object',
    properties: {
      plan: {
        type: 'string',
        description:
          'Optional. The plan content in Markdown format. If omitted, the plan is read from the plan file on disk. Include only if you want to override the file content.',
      },
      allowedPrompts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            tool: {
              type: 'string',
              enum: ['Bash'],
              description: 'The tool this prompt applies to',
            },
            prompt: {
              type: 'string',
              description:
                'Semantic description of the action, e.g. "run tests", "install dependencies"',
            },
          },
          required: ['tool', 'prompt'],
        },
        description:
          'Prompt-based permissions needed to implement the plan. These describe categories of actions rather than specific commands.',
      },
    },
  },
  _meta: {
    riskLevel: 'mutation',
    isConcurrencySafe: false,
  },
};
