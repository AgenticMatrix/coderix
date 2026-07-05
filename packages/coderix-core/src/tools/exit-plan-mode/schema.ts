import type { ToolSchema } from '../types.js';

export const schema: ToolSchema = {
  name: 'ExitPlanMode',
  description:
    'Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\n\n' +
    '## How This Tool Works\n' +
    '- You should have already written your plan to the plan file specified in the plan mode system message\n' +
    '- This tool does NOT take the plan content as a parameter — it will read the plan from the file you wrote\n' +
    '- This tool simply signals that you are done planning and ready for the user to review and approve\n' +
    '- The user will see the contents of your plan file when they review it\n\n' +
    '## When to Use This Tool\n' +
    'IMPORTANT: Only use this tool when the task requires planning the implementation steps of a task that requires writing code. For research tasks where you are gathering information, searching files, reading files or in general trying to understand the codebase — do NOT use this tool.\n\n' +
    '## Before Using This Tool\n' +
    'Ensure your plan is complete and unambiguous:\n' +
    '- If you have unresolved questions about requirements or approach, use AskUserQuestion first (in earlier phases)\n' +
    '- Once your plan is finalized, use THIS tool to request approval\n\n' +
    '**Important:** Do NOT use AskUserQuestion to ask "Is this plan okay?" or "Should I proceed?" — that is exactly what THIS tool does. ExitPlanMode inherently requests user approval of your plan.',
  input_schema: {
    type: 'object',
    properties: {
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
